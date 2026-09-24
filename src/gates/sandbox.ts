import { sanitize, secretValuesFromEnv } from '../redact/sanitize.js';
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

/**
 * Credentials the GATE SUBPROCESS must never inherit.
 *
 * The gates run the CUSTOMER's own build, test and eval commands, so their own application
 * secrets have to stay in scope — stripping those is what turns a passing gate into an
 * inconclusive one and makes the product look worse than it is. What must NOT stay in scope
 * is the CI's own write-scoped credentials, which the migrate job holds because it opens a
 * pull request: contents:write, pull-requests:write, id-token:write.
 *
 * Nothing in a test suite legitimately needs those, and handing them to arbitrary code in a
 * customer's dependency tree is a privilege escalation with no upside: a compromised
 * transitive dependency could push to their default branch using the job's own token, or mint
 * an OIDC token asserting their repository's identity.
 */
const GATE_DENIED_ENV: readonly RegExp[] = [
  /^GITHUB_TOKEN$/,
  /^ACTIONS_(ID_TOKEN_REQUEST_(TOKEN|URL)|RUNTIME_(TOKEN|URL)|RESULTS_URL)$/,
  /^INPUT_/, // every `with:` value the action was given, which is where a secret is passed
];

/**
 * The environment a gate subprocess runs in: the customer's, minus the CI's own credentials.
 * Explicit rather than inherited, so what is dropped is readable and testable.
 */
export function gateEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (GATE_DENIED_ENV.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Secret shapes, redacted from captured output BEFORE it leaves this machine.
 *
 * The App already redacts on ingest (app/src/redact.ts), but that is the receiving end: by
 * then the value has crossed the network and passed through Mendr's own process. A product
 * whose promise is that the scan runs in your CI and only findings leave should clean its
 * output at the source, and keep the far-end redaction as a second line rather than the only
 * one. The rules live in src/redact/sanitize.ts; this adds the by-value pass, because a gate
 * subprocess is exactly where an INPUT_* value gets echoed back by someone else's script.
 */
export function redactCaptured(text: string): string {
  // One owner (src/redact/sanitize.ts). This was a second copy of the same
  // seven patterns, kept "in step" by a comment rather than by a test — and it
  // was the copy the App's drift test did not cover.
  return sanitize(text, secretValuesFromEnv(process.env));
}

/**
 * Keep captured output bounded so a chatty runner cannot flood the CLI summary — redacted
 * FIRST, so a secret is never split across the truncation boundary into two harmless-looking
 * halves, and so all three gates are covered by one chokepoint instead of three.
 */
export function truncateOutput(text: string): string {
  const clean = redactCaptured(text);
  if (clean.length <= MAX_OUTPUT) return clean;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${clean.slice(0, half)}\n... [truncated ${clean.length - MAX_OUTPUT} chars] ...\n${clean.slice(-half)}`;
}

/**
 * Either the callback's value, or the reason the sandbox itself could not be
 * built. Callers map `ok: false` to their own "could not verify" status — an
 * infra failure is never a verdict about the patch.
 */
export type SandboxResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Why a filesystem operation failed, WITHOUT the path it failed on.
 *
 * `String(err)` on a Node fs error reads
 *
 *     Error: ENOENT: no such file or directory, open 'D:\a\acme-api\acme-api\package.json'
 *
 * and every gate detail in this directory is PUBLISHED: mendr-action writes the
 * migrate report and the evidence block into the body of a public pull request.
 * That string hands an external reviewer the CI runner's directory layout and
 * the checkout's on-disk name, and tells them nothing they needed. The failure
 * CODE is the useful half; the path is the half that leaks.
 *
 * THE CENTRAL SANITIZER DOES NOT COVER THIS, in two independent ways.
 * src/redact/sanitize.ts matches secret SHAPES and known values, and has no
 * rule for an absolute path — nor should it, since a path is not a credential
 * and a rule broad enough to catch one would mangle ordinary output. And the
 * pull-request evidence block never reaches the sanitizer at all: run-mendr.sh
 * pipes the REPORT through `mendr redact` and cats the pr-body file in
 * directly. So the only reliable place to not leak a path is to not build the
 * string in the first place.
 */
export function describeFsFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code.length > 0) {
    const syscall = (err as NodeJS.ErrnoException).syscall;
    return syscall ? `${code} on ${syscall}` : code;
  }
  // Not an errno error. Keep the message, drop anything that looks like a
  // path: a bare name is still useful ("Unexpected token }"), a rooted one is
  // the customer's filesystem.
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s'"]{2,}/g, '<path>').slice(0, 200);
}

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
    // NO PATH. This `reason` is interpolated into three published gate details
    // — `test gate infra error: …`, `build gate infra error: …` and `eval gate
    // infra error: …` — and the paths it would carry are the CI runner's temp
    // directory AND the customer's checkout root.
    return { ok: false, reason: describeFsFailure(err) };
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
