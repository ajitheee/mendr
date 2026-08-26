// Assemble a RecommendationReceipt — the honest, dimension-scoped output.
//
// Two invariants live here:
//   VerificationScope population (M1): only providerStatus and capabilities are
//     evaluable this rung; the other seven dimensions are ALWAYS 'not_evaluated'
//     (M1 measures none of them, so none may ever read 'passed').
//   reviewFlag (authoritative): true iff any requirement is `unknown` OR any
//     CapabilityCheck on a KEPT candidate is `indeterminate`. Rejected candidates
//     never raise review: elimination requires a solid `unsatisfied`, so a
//     rejection is sound regardless of any indeterminate check it also carries.

import type { LlmModelIdDeprecation } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import type {
  CandidateDecision,
  ExtractedRequirement,
  RecommendationReceipt,
  VerificationScope,
} from './types.js';
import type { FilterResult } from './filter.js';

function computeVerification(
  keptCandidates: readonly CandidateDecision[],
): VerificationScope {
  const keptCount = keptCandidates.length;
  // Scoped to REQUIRED checks (not the broad reviewFlag predicate): an `unknown`
  // requirement produces an indeterminate check but must not drag capabilities
  // to 'unknown' when every REQUIRED capability is satisfied — that belongs in
  // reviewFlag, per the M1 population rule.
  const anyRequiredIndeterminate = keptCandidates.some((d) =>
    d.checks.some((c) => c.requirement === 'required' && c.result === 'indeterminate'),
  );

  const capabilities: VerificationScope['capabilities'] =
    keptCount === 0 ? 'failed' : anyRequiredIndeterminate ? 'unknown' : 'passed';

  return {
    providerStatus: keptCount > 0 ? 'passed' : 'failed',
    capabilities,
    // M1 measures none of these — they may NEVER read 'passed' this rung.
    availability: 'not_evaluated',
    code: 'not_evaluated',
    toolBehavior: 'not_evaluated',
    outputSchema: 'not_evaluated',
    cost: 'not_evaluated',
    latency: 'not_evaluated',
    semanticQuality: 'not_evaluated',
  };
}

/** true iff any requirement is unknown OR any kept candidate has an indeterminate check. */
export function computeReviewFlag(
  requirements: readonly ExtractedRequirement[],
  keptCandidates: readonly CandidateDecision[],
): boolean {
  const anyUnknownReq = requirements.some((r) => r.state === 'unknown');
  const anyKeptIndeterminate = keptCandidates.some((d) => d.checks.some((c) => c.result === 'indeterminate'));
  return anyUnknownReq || anyKeptIndeterminate;
}

/** Build the receipt for one dead model. Pure. */
export function buildReceipt(args: {
  dead: LlmModelIdDeprecation;
  candidateProvider: 'openai' | 'anthropic' | 'google';
  occurrences: number;
  requirements: ExtractedRequirement[];
  filter: FilterResult;
  sortBy: 'cost' | 'context' | null;
  deadlineDays: number | null;
}): RecommendationReceipt {
  const { dead, candidateProvider, occurrences, requirements, filter, sortBy, deadlineDays } = args;
  const keptCandidates = [...filter.officialSuccessors, ...filter.compatibleAlternatives];

  return {
    deprecated: dead.deprecated,
    entryId: displayEntryId(dead),
    provider: dead.provider,
    candidateProvider,
    occurrences,
    requirements,
    reviewFlag: computeReviewFlag(requirements, keptCandidates),
    authorization: { type: 'compatibility_only' },
    verification: computeVerification(keptCandidates),
    officialSuccessors: filter.officialSuccessors,
    compatibleAlternatives: filter.compatibleAlternatives,
    rejected: filter.rejected,
    sortedBy: sortBy,
    deadlineDays,
  };
}
