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
  requirements: readonly ExtractedRequirement[],
  keptCandidates: readonly CandidateDecision[],
): VerificationScope {
  const keptCount = keptCandidates.length;
  const keptInCatalog = keptCandidates.some((d) => d.inCatalog);
  const hasUnknownReq = requirements.some((r) => r.state === 'unknown');
  const keptChecks = keptCandidates.flatMap((d) => d.checks);
  const anyRequiredIndeterminate = keptChecks.some((c) => c.requirement === 'required' && c.result === 'indeterminate');
  const anyRequiredUnsatisfied = keptChecks.some((c) => c.requirement === 'required' && c.result === 'unsatisfied');

  // capabilities is honest about what M1 could prove:
  //   failed  = no kept candidate, or a surfaced official successor provably lacks a required capability.
  //   unknown = a requirement was unknown (e.g. Python — nothing proven), or a required check hit missing provenance.
  //   passed  = kept candidate(s) and every required capability satisfied, with no unknowns.
  let capabilities: VerificationScope['capabilities'];
  if (keptCount === 0 || anyRequiredUnsatisfied) capabilities = 'failed';
  else if (hasUnknownReq || anyRequiredIndeterminate) capabilities = 'unknown';
  else capabilities = 'passed';

  return {
    // 'passed' only when a CATALOG-backed model is recommended; 'unknown' when the
    // only kept candidate is a registry successor the catalog does not yet cover.
    providerStatus: keptCount === 0 ? 'failed' : keptInCatalog ? 'passed' : 'unknown',
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

/**
 * true iff any requirement is unknown, or any kept candidate has a `required`
 * check that is indeterminate or unsatisfied (the latter reachable only for an
 * always-surfaced official successor whose catalog data fails a hard requirement).
 */
export function computeReviewFlag(
  requirements: readonly ExtractedRequirement[],
  keptCandidates: readonly CandidateDecision[],
): boolean {
  const anyUnknownReq = requirements.some((r) => r.state === 'unknown');
  const anyRequiredIssue = keptCandidates.some((d) =>
    d.checks.some((c) => c.requirement === 'required' && (c.result === 'indeterminate' || c.result === 'unsatisfied')),
  );
  return anyUnknownReq || anyRequiredIssue;
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
    verification: computeVerification(requirements, keptCandidates),
    officialSuccessors: filter.officialSuccessors,
    compatibleAlternatives: filter.compatibleAlternatives,
    rejected: filter.rejected,
    alternativesQualified: filter.alternativesQualified,
    sortedBy: sortBy,
    deadlineDays,
  };
}
