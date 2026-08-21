import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { truncateOutput, withPatchedSandbox, type PatchedFile } from './sandbox.js';

// Phase 5: the test gate.
//
// Type-checking proves a patch is well-typed; it does NOT prove the patched
// code still BEHAVES. This gate runs the target repo's own test suite against
// the patched sources and reports whether they still pass.
//
// Hard safety rule: we NEVER mutate the target repo's working tree. The run
// happens inside the shared throwaway copy built by gates/sandbox.ts (temp
// copy + node_modules junction + patched overlay, always torn down).
//
// Any infrastructure failure (no test script, copy/junction error, timeout)
// yields `inconclusive` rather than throwing: the caller treats inconclusive as
// "could not verify" and refuses to grant Tier A on that basis, but the tool
// itself never crashes inside the gate.

export type { PatchedFile } from './sandbox.js';

/** Outcome of running the repo's test suite against the patched sources. */
export type TestStatus = 'pass' | 'fail' | 'inconclusive';

/** Parsed pass/fail totals from a recognized test runner's output. */
export interface TestCounts {
  passed: number;
  failed: number;
}

/** Result of the test gate. */
export interface TestGateResult {
  status: TestStatus;
  /** Captured test output (truncated) or the reason the gate was inconclusive. */
  output: string;
  /** Parsed pass/fail totals, when the runner's summary was recognizable. */
  counts?: TestCounts;
}

/**
 * Parse pass/fail totals out of a test runner's captured output, best-effort.
 * Knows the summary shapes of the common runners:
 *   vitest  `Tests  2 failed | 116 passed (118)`
 *   jest    `Tests:       1 failed, 117 passed, 118 total`
 *   mocha   `117 passing` / `2 failing`
 *   pytest  `1 failed, 5 passed in 0.12s`
 * Returns undefined when no recognizable summary is present — the caller then
 * reports the un-measurable status honestly instead of inventing numbers.
 */
export function parseTestCounts(output: string): TestCounts | undefined {
  // vitest/jest print a dedicated "Tests" summary line — prefer it, because
  // their surrounding output also carries per-FILE counts ("Test Files  17
  // passed") that would otherwise be mistaken for test totals.
  const testsLine = /^\s*Tests:?\s+(.+)$/m.exec(output)?.[1];
  const scope = testsLine ?? output;
  const passed = /(\d+)\s+pass(?:ed|ing)\b/.exec(scope);
  const failed = /(\d+)\s+fail(?:ed|ing)\b/.exec(scope);
  if (!passed && !failed) return undefined;
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
  };
}

const TEST_TIMEOUT_MS = 120_000;

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

  // 2. `npm test` runs the repo's OWN devDependencies (vitest, jest, ...), so
  //    unlike the eval gate this one genuinely requires an installed tree.
  if (!existsSync(join(repoPath, 'node_modules'))) {
    return {
      status: 'inconclusive',
      output: 'repo has no installed node_modules to link — cannot run tests',
    };
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const sandbox = await withPatchedSandbox(repoPath, patchedFiles, (dir) =>
    execa(npmCmd, ['test'], {
      cwd: dir,
      timeout: TEST_TIMEOUT_MS,
      reject: false,
      all: true,
      windowsHide: true,
    }),
  );

  // Any infra failure (copy/junction/spawn) is inconclusive, never fatal.
  if (!sandbox.ok) {
    return { status: 'inconclusive', output: `test gate infra error: ${sandbox.reason}` };
  }
  const result = sandbox.value;
  if (result.timedOut) {
    return { status: 'inconclusive', output: `test run timed out after ${TEST_TIMEOUT_MS}ms` };
  }
  const output = truncateOutput(result.all ?? `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const status: TestStatus = result.exitCode === 0 ? 'pass' : 'fail';
  // Best-effort measurability: real counts when the runner's summary is
  // recognizable, so gate lines can say "N passed, M failed" instead of a
  // bare unverifiable "pass".
  const counts = parseTestCounts(output);
  return counts ? { status, output, counts } : { status, output };
}
