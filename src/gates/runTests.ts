import { execa } from 'execa';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// Phase 5: the test gate.
//
// Type-checking proves a patch is well-typed; it does NOT prove the patched
// code still BEHAVES. This gate runs the target repo's own test suite against
// the patched sources and reports whether they still pass.
//
// Hard safety rule: we NEVER mutate the target repo's working tree. The gate
// copies the repo into a fresh OS-temp directory (excluding node_modules/.git/
// dist), re-links `node_modules` back to the original as a Windows directory
// JUNCTION (so nothing is reinstalled), writes the patched files into the copy,
// and runs `npm test` there. The temp copy is always torn down.
//
// Any infrastructure failure (no test script, copy/junction error, timeout)
// yields `inconclusive` rather than throwing: the caller treats inconclusive as
// "could not verify" and refuses to grant Tier A on that basis, but the tool
// itself never crashes inside the gate.

/** Outcome of running the repo's test suite against the patched sources. */
export type TestStatus = 'pass' | 'fail' | 'inconclusive';

/** A patched source file: absolute path in the target repo + its new contents. */
export interface PatchedFile {
  absPath: string;
  newText: string;
}

/** Result of the test gate. */
export interface TestGateResult {
  status: TestStatus;
  /** Captured test output (truncated) or the reason the gate was inconclusive. */
  output: string;
}

/** Directory names never copied into the temp sandbox. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist']);

/** Max chars of captured output we retain (head + tail around a marker). */
const MAX_OUTPUT = 8000;
const TEST_TIMEOUT_MS = 120_000;

/** Keep output bounded so a chatty runner cannot flood the CLI summary. */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - MAX_OUTPUT} chars] ...\n${text.slice(-half)}`;
}

/**
 * Run the target repo's test suite against `patchedFiles` in an isolated temp
 * copy. Never touches the original working tree. See file header for the full
 * isolation strategy.
 */
export async function runRepoTests(
  repoPath: string,
  patchedFiles: PatchedFile[],
): Promise<TestGateResult> {
  // 1. Bail early if the repo declares no test script — nothing to verify.
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    hasTestScript = Boolean(pkg?.scripts?.test);
  } catch (err) {
    return { status: 'inconclusive', output: `could not read package.json: ${String(err)}` };
  }
  if (!hasTestScript) {
    return { status: 'inconclusive', output: 'no test script' };
  }

  const originalNodeModules = join(repoPath, 'node_modules');
  if (!existsSync(originalNodeModules)) {
    return {
      status: 'inconclusive',
      output: 'repo has no installed node_modules to link — cannot run tests',
    };
  }

  let tempDir: string | undefined;
  let junctionPath: string | undefined;
  try {
    // 2. Fresh temp dir + shallow copy (no node_modules/.git/dist).
    tempDir = mkdtempSync(join(tmpdir(), 'mendr-gate-'));
    cpSync(repoPath, tempDir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(repoPath, src);
        if (rel === '') return true;
        return !rel.split(sep).some((segment) => EXCLUDED_DIRS.has(segment));
      },
    });

    // 3. Re-link node_modules to the original via a directory junction (no admin
    //    rights required on Windows; symlink type 'junction' maps to mklink /J).
    junctionPath = join(tempDir, 'node_modules');
    symlinkSync(originalNodeModules, junctionPath, 'junction');

    // 4. Overlay the patched sources into the copy at their relative paths.
    for (const file of patchedFiles) {
      const dest = join(tempDir, relative(repoPath, file.absPath));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.newText);
    }

    // 5. Run the repo's own `npm test` in the sandbox.
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await execa(npmCmd, ['test'], {
      cwd: tempDir,
      timeout: TEST_TIMEOUT_MS,
      reject: false,
      all: true,
      windowsHide: true,
    });

    if (result.timedOut) {
      return { status: 'inconclusive', output: `test run timed out after ${TEST_TIMEOUT_MS}ms` };
    }
    const output = truncate(result.all ?? `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    return { status: result.exitCode === 0 ? 'pass' : 'fail', output };
  } catch (err) {
    // Any infra failure (copy/junction/spawn) is inconclusive, never fatal.
    return { status: 'inconclusive', output: `test gate infra error: ${String(err)}` };
  } finally {
    // 6. Always tear down. Remove the junction first (unlinks the LINK only,
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
