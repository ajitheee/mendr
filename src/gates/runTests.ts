import type { CheckStatus } from './status.js';
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeFsFailure, gateEnv, truncateOutput, withPatchedSandbox, type PatchedFile } from './sandbox.js';

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

/**
 * Outcome of running the repo's test suite against the patched sources —
 * {@link CheckStatus}, the one vocabulary. This was its own three-word union,
 * and the caller had to re-split it by comparing `output` against the literal
 * string `'no test script'` to recover what had actually happened.
 */
export type TestStatus = CheckStatus;

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
  /**
   * Why a status is what it is, when the captured `output` does not say so by
   * itself. Carries the one case a reader would otherwise misread: a command
   * that exited 0 without demonstrably running anything.
   */
  note?: string;
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
 * The reason this gate gives up on a repository it has no runner for.
 *
 * mendr's only test runner is `npm test`. On a repo without a package.json it
 * has not proven there are no tests — only that it cannot reach them — so this
 * pairs with `inconclusive`, never with `not_run`.
 *
 * Exported because `fix-llm` prints the same row for a python repository and
 * `migrate` reaches it through this gate. While each surface held its own copy,
 * they described the same repository in different words.
 */
export const NO_TEST_RUNNER = 'mendr has no python test runner -- only `npm test` is supported';

/**
 * Run the target repo's test suite against `patchedFiles` in an isolated temp
 * copy. Never touches the original working tree. See file header for the full
 * isolation strategy.
 */
export async function runRepoTests(
  repoPath: string,
  patchedFiles: PatchedFile[],
): Promise<TestGateResult> {
  // 1. Bail early when there is nothing to verify. THREE cases, not one:
  //
  //    no package.json    this is not a Node project.      NOT_RUN
  //    no `test` script   it is, and declares no suite.    NOT_RUN
  //    unreadable         it is there and we could not read it. INCONCLUSIVE
  //
  // The first two used to be the first and third. A missing package.json fell
  // into the catch and came back `inconclusive` carrying the raw ENOENT —
  // Error, message, and the CI runner's ABSOLUTE PATH — which mendr-action
  // published verbatim in the body of a public pull request as the test gate's
  // reason. On a Python-only repository that fired on every single run.
  //
  // The honest status for a repository that is not a Node project is the one
  // "no test script" already gets: there is nothing to run, and no amount of
  // installing or retrying changes it.
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) {
    // INCONCLUSIVE, not `not_run`. `not_run` means "there was nothing to run",
    // and this gate is in no position to claim that: a repository with no
    // package.json may well have a pytest or go test suite mendr simply cannot
    // reach. Saying so would tell a reader their project has no tests.
    //
    // This is the same call `fix-llm` already made on its python path, and
    // using its exact sentence is the point — the two surfaces described the
    // same repository in different words before.
    return { status: 'inconclusive', output: NO_TEST_RUNNER };
  }
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    hasTestScript = Boolean(pkg?.scripts?.test);
  } catch (err) {
    // Present but unreadable IS inconclusive — re-running might work. The
    // reason goes through describeFsFailure for the same reason the sandbox's
    // does: this string is published.
    return { status: 'inconclusive', output: `could not read package.json: ${describeFsFailure(err)}` };
  }
  if (!hasTestScript) {
    // NOT_RUN, not inconclusive: there is nothing to run, so no amount of
    // retrying or installing changes it. The caller used to recover this by
    // string-matching the output field.
    return { status: 'not_run', output: 'no test script' };
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
      // The customer's own secrets stay; the CI's write-scoped token and OIDC do not.
      env: gateEnv(),
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
  const counts = parseTestCounts(output);

  // A NON-ZERO EXIT IS A REJECTION, and needs no corroboration.
  if (result.exitCode !== 0) return counts ? { status: 'failed', output, counts } : { status: 'failed', output };

  // EXIT 0 MEANS THE COMMAND SUCCEEDED. It does not mean a test ran.
  //
  // `"test": "exit 0"` — and every `"test": "echo no tests yet"` in the wild —
  // exits 0 having verified nothing. This used to return `pass`, and that one
  // word was enough to make a migration `verified` and PR-ready, with a pull
  // request whose body told the reviewer "your tests: passed". Nobody's tests
  // had passed, because nobody's tests had run.
  //
  // So `passed` now requires EVIDENCE that the suite ran: a parseable summary
  // with at least one test in it. Without that the honest state is
  // `inconclusive` — the command was fine, and we cannot say the suite was.
  const total = counts ? counts.passed + counts.failed : 0;
  if (total > 0) return { status: 'passed', output, counts: counts! };
  return {
    status: 'inconclusive',
    output,
    note: 'the test command exited 0, but no test results could be parsed from its output, so it is not proven that any test ran',
  };
}
