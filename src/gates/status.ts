// THE verification vocabulary. Five words, one union, every surface.
//
// WHY THIS FILE EXISTS. There were six of these. `fix-llm` had a five-word
// GateOutcome, `migrate` a four-word GateStatus, and runTests, runEval and
// runBuild each declared their own; the Python syntax gate was a bare boolean.
// Nothing in the type system tied them together, so they drifted — "no test
// script" was `not-configured` on one path and `inconclusive` on the other, and
// the two paths printed opposite verdicts for the same repository: `fix-llm`
// said "Tier A (VERIFIED)" where `migrate` computed `inconclusive`.
//
// THE RULE THIS ENCODES, and the reason the vocabulary is worth a module:
//
//     A CHECK IS NEVER REPORTED AS PASSED UNLESS IT ACTUALLY RAN.
//
// `passed` is the only word that claims verification, and it is reserved for a
// check that ran AND could have failed. Everything else is a different kind of
// silence, and a reader is owed the difference:
//
//   passed        it ran, it could have failed, it did not
//   failed        it ran and rejected the change
//   skipped       we chose not to run it (--skip-gates, disabled by policy,
//                 not applicable to this language)
//   not_run       there was nothing to run (no test script, no eval command)
//   inconclusive  we tried and cannot say (no dependencies installed, timed
//                 out, the runner itself broke, or it ran BLIND — see below)
//
// `inconclusive` carries the case that motivated this work. A type-check
// against a shallow clone with no node_modules runs to completion and reports
// no new errors — but the SDK types that would have rejected a bad model id
// were never loaded, so nothing could have failed. The check ran; the part of
// it that mattered did not. That is not `passed`.

/** The five states. No surface may render anything else. */
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'not_run' | 'inconclusive';

/** Every value, for exhaustiveness tests and for validating machine output. */
export const CHECK_STATUSES: readonly CheckStatus[] = ['passed', 'failed', 'skipped', 'not_run', 'inconclusive'];

/**
 * The single glyph a report row leads with. Deliberately NOT a tick for
 * anything but `passed`: a reader skimming a column of ticks is reading a
 * claim, and only one of these five states is entitled to make it.
 */
export const CHECK_MARK: Readonly<Record<CheckStatus, string>> = {
  passed: '✓',
  failed: '✗',
  skipped: '–',
  not_run: '–',
  inconclusive: '○',
};

/** The word itself, as every human surface spells it. */
export const CHECK_LABEL: Readonly<Record<CheckStatus, 'passed' | 'failed' | 'skipped' | 'not run' | 'inconclusive'>> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  not_run: 'not run',
  inconclusive: 'inconclusive',
};

/**
 * Did this check VERIFY anything? True only for `passed`.
 *
 * The one predicate anything downstream should use to decide whether evidence
 * exists. Written as an equality so that adding a sixth state can never
 * accidentally widen what counts as proof.
 */
export function isVerified(status: CheckStatus): boolean {
  return status === 'passed';
}

/**
 * Did this check REJECT the change? True only for `failed`.
 *
 * Separate from `!isVerified` on purpose: four of the five states are not a
 * rejection, and treating silence as rejection would block migrations that
 * nothing actually objected to.
 */
export function isRejection(status: CheckStatus): boolean {
  return status === 'failed';
}

/**
 * Map a process exit code to a status, for a check that genuinely ran.
 *
 * Callers that cannot prove the command did the work it was asked to do must
 * NOT use this — see runTests, where an exit code of 0 from a script that ran
 * zero tests is `inconclusive`, not `passed`.
 */
export function fromExitCode(code: number): CheckStatus {
  return code === 0 ? 'passed' : 'failed';
}
