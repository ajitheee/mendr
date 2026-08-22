import type { GateName, RepoConfig } from '../config/repoConfig.js';

// THE GATE POLICY: which gates must pass before mendr calls a fix Tier A.
//
// WHY THIS IS A POLICY AND NOT A CONSTANT. Until this file existed, one gate's
// lenience was hardcoded: a test gate that could not run ("no test script",
// "no installed node_modules") did NOT block Tier A. That default is defensible
// — a fresh CI clone of someone else's repo usually cannot run their suite, and
// refusing every such repo would make mendr useless in the place it runs most.
// But it is a JUDGEMENT ABOUT RISK, and the person who owns the repo is better
// placed to make it than mendr is. A team that can run its tests, and whose
// migration is worth a green suite, must be able to say so.
//
// THE ONE RULE THAT IS NOT CONFIGURABLE: a gate that did not run is never
// reported as passed. `inconclusive` is its own outcome everywhere — in the
// report, in the JSON, and here — and `required` decides whether it blocks, not
// whether it is renamed.

/**
 * What a gate returned on this run.
 *
 *   pass           — the check ran and was satisfied
 *   fail           — the check ran and was violated (always blocks, required or not)
 *   inconclusive   — the check COULD NOT RUN (no installed deps, timeout, infra)
 *   not-configured — there is nothing to run (no test script, no eval command)
 *   not-applicable — this gate does not exist for this language (no type-check
 *                    gate for Python). Distinct from `inconclusive`: nothing
 *                    was attempted and nothing could be, so requiring the gate
 *                    cannot make it run and must not block the language.
 */
export type GateOutcome = 'pass' | 'fail' | 'inconclusive' | 'not-configured' | 'not-applicable';

/** One gate's result for this run, as the policy sees it. */
export interface GateEvaluation {
  gate: GateName;
  outcome: GateOutcome;
  /** Why, in one clause — the text the block message and the report row carry. */
  detail?: string;
}

/** The resolved policy for one run: defaults, overlaid with the repo's config. */
export interface ResolvedGatePolicy {
  typecheck: { required: boolean };
  tests: { required: boolean };
  eval: { required: boolean; command?: string };
}

/**
 * The built-in defaults, which reproduce mendr's behavior before the policy
 * existed, exactly:
 *   typecheck — required. A patch that introduces a type error is never Tier A.
 *   tests     — NOT required. A suite that cannot run does not block; a suite
 *               that RUNS AND FAILS still does (a hard fail always blocks).
 *   eval      — required WHENEVER a command is configured. That is the
 *               fail-closed rule: a team that asked for behavioral
 *               verification and did not get one gets no fix.
 */
export const DEFAULT_GATE_REQUIRED: Readonly<Record<GateName, boolean>> = {
  typecheck: true,
  tests: false,
  // Overridden below: with no command there is nothing to require.
  eval: true,
};

/**
 * Resolve the policy for a run from the repo's config plus `--eval-command`.
 *
 * PRECEDENCE for the eval command: the CLI flag beats the file (it is the
 * later, more specific instruction), and within the file `gates.eval.command`
 * and the legacy top-level `evalCommand` are the same setting — loadRepoConfig
 * has already rejected the case where they disagree.
 */
export function resolveGatePolicy(
  config: RepoConfig,
  cliEvalCommand?: string,
): ResolvedGatePolicy {
  const command =
    cliEvalCommand?.trim() || config.gates?.eval?.command || config.evalCommand || undefined;
  return {
    typecheck: { required: config.gates?.typecheck?.required ?? DEFAULT_GATE_REQUIRED.typecheck },
    tests: { required: config.gates?.tests?.required ?? DEFAULT_GATE_REQUIRED.tests },
    eval: {
      // No command means nothing to run, so `required` defaults to false — but
      // an EXPLICIT `"eval": { "required": true }` is honored even then, and
      // blocks with "not configured". A repo may legitimately demand that every
      // model migration be backed by an eval, and the honest way to enforce
      // that is to refuse the fix, not to quietly skip the demand.
      required: config.gates?.eval?.required ?? (command ? DEFAULT_GATE_REQUIRED.eval : false),
      ...(command ? { command } : {}),
    },
  };
}

/** A gate that stops this fix from being Tier A. */
export interface GateBlock {
  gate: GateName;
  /** Never `pass` and never `not-applicable` — those do not block. */
  outcome: Exclude<GateOutcome, 'pass' | 'not-applicable'>;
  /** True when the policy REQUIRED this gate; false for an always-blocking hard fail. */
  required: boolean;
  detail?: string;
}

/**
 * Which of these gate results block Tier A.
 *
 *   fail                          — always blocks, required or not. A check
 *                                   that RAN and came back negative is the one
 *                                   signal no policy may wave through.
 *   inconclusive / not-configured — blocks IFF the gate is required.
 *   pass / not-applicable         — never blocks.
 *
 * Order is preserved, so the caller reports the first blocker in the order the
 * gates ran rather than in whatever order a map iterated.
 */
export function gateBlocks(
  policy: ResolvedGatePolicy,
  evaluations: readonly GateEvaluation[],
): GateBlock[] {
  const blocks: GateBlock[] = [];
  for (const evaluation of evaluations) {
    const { gate, outcome, detail } = evaluation;
    if (outcome === 'pass' || outcome === 'not-applicable') continue;
    const required = policy[gate].required;
    if (outcome !== 'fail' && !required) continue;
    blocks.push({ gate, outcome, required, ...(detail ? { detail } : {}) });
  }
  return blocks;
}

/** Human names for the gates, as the block message spells them. */
const GATE_LABEL: Readonly<Record<GateName, string>> = {
  typecheck: 'type-check',
  tests: 'tests',
  eval: 'behavioral evaluation',
};

/**
 * One sentence naming WHICH gate did not pass and WHAT it returned — the line a
 * user reads next to a downgraded Tier A candidate, and the reason a script's
 * non-zero exit needs to be explainable. A required gate says so, because
 * "tests: inconclusive" is only a blocking fact under a policy the user chose.
 */
export function describeGateBlock(block: GateBlock): string {
  const label = GATE_LABEL[block.gate];
  const detail = block.detail ? `: ${block.detail}` : '';
  if (block.outcome === 'fail') {
    // The eval gate keeps its own sentence: the thing that failed is the
    // command the USER wrote, and naming it (with its exit code) is what sends
    // them to the right place. "the behavioral evaluation gate failed" names
    // mendr's machinery instead of theirs.
    return block.gate === 'eval'
      ? `your eval command failed against the patched code (${block.detail ?? 'no detail'})`
      : `the ${label} gate failed against the patched code${detail}`;
  }
  const state = block.outcome === 'inconclusive' ? 'could not run' : 'is not configured';
  return (
    `required gate "${block.gate}" did not pass -- the ${label} gate ${state}${detail}` +
    ` (set "gates.${block.gate}": { "required": false } in mendr.config.json to allow it)`
  );
}
