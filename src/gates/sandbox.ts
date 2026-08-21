import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// The throwaway patched workspace shared by every gate that has to RUN
// something (the test gate, the eval gate).
//
// Hard safety rule, and the reason this module exists exactly once: we NEVER
// mutate the target repo's working tree. A gate that runs a command runs it on
// a fresh OS-temp COPY of the repo (excluding node_modules/.git/dist), with
// `node_modules` re-linked back to the original as a Windows directory JUNCTION
// (so nothing is reinstalled), the patched files overlaid at their relative
// paths, and the whole copy torn down afterwards — success or failure.
//
// Extracted from runTests.ts when the eval gate arrived: two gates copying,
// junctioning and tearing down a repo in two places is two chances to leak a
// temp tree or to delete the wrong node_modules.

/** A patched source file: absolute path in the target repo + its new contents. */
export interface PatchedFile {
  absPath: string;
  newText: string;
}

/** Directory names never copied into the temp sandbox. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist']);

/** Max chars of captured output a gate retains (head + tail around a marker). */
const MAX_OUTPUT = 8000;

/** Keep captured output bounded so a chatty runner cannot flood the CLI summary. */
export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - MAX_OUTPUT} chars] ...\n${text.slice(-half)}`;
}

/**
 * Either the callback's value, or the reason the sandbox itself could not be
 * built. Callers map `ok: false` to their own "could not verify" status — an
 * infra failure is never a verdict about the patch.
 */
export type SandboxResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Build the patched copy, hand its directory to `run`, and tear it down.
 *
 * `node_modules` is linked only when the original repo HAS one. A repo without
 * installed dependencies is not an error here: the caller decides whether its
 * command needs them (the test gate refuses up front; an eval command may be
 * `pytest`, `make`, or a shell script that needs nothing from npm).
 */
export async function withPatchedSandbox<T>(
  repoPath: string,
  patchedFiles: readonly PatchedFile[],
  run: (sandboxDir: string) => Promise<T>,
): Promise<SandboxResult<T>> {
  let tempDir: string | undefined;
  let junctionPath: string | undefined;
  try {
    // 1. Fresh temp dir + shallow copy (no node_modules/.git/dist).
    tempDir = mkdtempSync(join(tmpdir(), 'mendr-gate-'));
    cpSync(repoPath, tempDir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(repoPath, src);
        if (rel === '') return true;
        return !rel.split(sep).some((segment) => EXCLUDED_DIRS.has(segment));
      },
    });

    // 2. Re-link node_modules to the original via a directory junction (no admin
    //    rights required on Windows; symlink type 'junction' maps to mklink /J).
    const originalNodeModules = join(repoPath, 'node_modules');
    if (existsSync(originalNodeModules)) {
      junctionPath = join(tempDir, 'node_modules');
      symlinkSync(originalNodeModules, junctionPath, 'junction');
    }

    // 3. Overlay the patched sources into the copy at their relative paths.
    for (const file of patchedFiles) {
      const dest = join(tempDir, relative(repoPath, file.absPath));
      mkdirSync(dirname(dest), { recursive: true });
      // DELETE BEFORE WRITE. cpSync preserves the read-only attribute, so a
      // single read-only file in the target repo made writeFileSync throw
      // EPERM here and cost the caller its whole gate ("infra error" ->
      // inconclusive), i.e. a user's configured eval silently did not run.
      // `dest` is inside the throwaway copy, never the user's tree.
      rmSync(dest, { force: true });
      writeFileSync(dest, file.newText);
    }

    return { ok: true, value: await run(tempDir) };
  } catch (err) {
    return { ok: false, reason: String(err) };
  } finally {
    // 4. Always tear down. Remove the junction first (unlinks the LINK only,
    //    never the original node_modules it points at), then the temp copy.
    try {
      if (junctionPath && existsSync(junctionPath)) {
        rmSync(junctionPath, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
    try {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
