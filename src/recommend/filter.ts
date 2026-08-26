// Candidate generation + the tri-state compatibility filter.
//
// THE ONE RULE: only a `required` capability the catalog PROVENANCEDLY does not
// support eliminates a candidate. `not_observed` is permissive (never cuts);
// `unknown`, and a `required` check against an UNPROVENANCED catalog field, are
// `indeterminate` (never cut, raise the review flag). A bare numeric/enum
// comparison never decides elimination against missing data.
//
// No ranking without a policy: kept candidates are ordered by ascending modelId
// (a neutral canonical order, independent of catalog file order) unless the user
// passes --sort.

import type { LlmModelIdDeprecation } from '../types.js';
import { effectiveVerificationState } from '../usage/llmRegistry.js';
import type {
  ActiveModel,
  CandidateDecision,
  CandidateOrigin,
  CapabilityCheck,
  ExtractedRequirement,
  Provenanced,
  RequirementKey,
} from './types.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A catalog fact is usable only when it names a source AND a valid check date. */
function hasProvenance(field: Provenanced<unknown>): boolean {
  return !!field.source?.trim() && ISO_DATE_RE.test(field.checkedAt ?? '');
}

/** The catalog field a requirement key checks against. */
function fieldFor(cand: ActiveModel, key: RequirementKey): Provenanced<unknown> {
  switch (key) {
    case 'tools': return cand.capabilities.tools;
    case 'vision': return cand.capabilities.vision;
    case 'jsonStrict': return cand.capabilities.jsonStrict;
    case 'streaming': return cand.capabilities.streaming;
    case 'reasoning': return cand.capabilities.reasoning;
    case 'minOutputTokens': return cand.capabilities.maxOutputTokens;
    case 'endpoint': return cand.endpoint;
  }
}

/** The displayed catalog value ('unknown' when the field has no provenance). */
function catalogValueOf(cand: ActiveModel, key: RequirementKey): CapabilityCheck['catalogValue'] {
  const field = fieldFor(cand, key);
  if (!hasProvenance(field)) return 'unknown';
  return field.value as boolean | number | string;
}

/** Check ONE requirement against one candidate. */
function checkRequirement(cand: ActiveModel, r: ExtractedRequirement): CapabilityCheck {
  const key = r.key;
  const catalogValue = catalogValueOf(cand, key);

  if (r.state === 'not_observed') {
    return { key, requirement: 'not_observed', catalogValue, result: 'not_applicable' };
  }
  if (r.state === 'unknown') {
    return { key, requirement: 'unknown', catalogValue, result: 'indeterminate' };
  }

  // required — but never decide elimination against an unprovenanced operand.
  const field = fieldFor(cand, key);
  if (!hasProvenance(field)) {
    return { key, requirement: 'required', catalogValue: 'unknown', result: 'indeterminate' };
  }

  let satisfied: boolean;
  if (key === 'minOutputTokens') {
    if (typeof r.min !== 'number') {
      return { key, requirement: 'required', catalogValue, result: 'indeterminate' };
    }
    satisfied = (field.value as number) >= r.min;
  } else if (key === 'endpoint') {
    satisfied = field.value === r.endpointFamily;
  } else {
    satisfied = field.value === true;
  }
  return { key, requirement: 'required', catalogValue, result: satisfied ? 'satisfied' : 'unsatisfied' };
}

/** A short machine+human reason for an elimination. */
function detailFor(cand: ActiveModel, check: CapabilityCheck): string {
  const field = fieldFor(cand, check.key);
  const prov = hasProvenance(field) ? `${field.source}, ${field.checkedAt}` : 'no provenance';
  return `${check.key} required; ${cand.modelId} ${check.key}=${JSON.stringify(field.value)} (${prov})`;
}

/** Run every requirement against one candidate (an ALTERNATIVE) and decide keep/reject. */
export function decideCandidate(
  cand: ActiveModel,
  origin: CandidateOrigin,
  requirements: readonly ExtractedRequirement[],
): CandidateDecision {
  const checks = requirements.map((r) => checkRequirement(cand, r));
  const firstFail = checks.find((c) => c.result === 'unsatisfied');
  return {
    modelId: cand.modelId,
    origin,
    kept: !firstFail,
    checks,
    eliminatedBy: firstFail ? firstFail.key : null,
    eliminationDetail: firstFail ? detailFor(cand, firstFail) : null,
    inCatalog: true,
    registryVerdict: null,
  };
}

/**
 * The official successor is the provider's DOCUMENTED replacement (the registry's
 * `replacement`, the same target fix-llm/watch use). It is ALWAYS surfaced — never
 * capability-eliminated — even when the active-model catalog does not yet cover it
 * (then its checks are indeterminate and `inCatalog` is false). This is what makes
 * recommend agree with watch instead of silently dropping the verified successor.
 */
export function decideOfficialSuccessor(
  modelId: string,
  catalogEntry: ActiveModel | undefined,
  requirements: readonly ExtractedRequirement[],
  registryVerdict: string,
): CandidateDecision {
  const checks: CapabilityCheck[] = catalogEntry
    ? requirements.map((r) => checkRequirement(catalogEntry, r))
    : requirements.map((r) => ({ key: r.key, requirement: r.state, catalogValue: 'unknown', result: 'indeterminate' }));
  return {
    modelId,
    origin: 'official_successor',
    kept: true,
    checks,
    eliminatedBy: null,
    eliminationDetail: null,
    inCatalog: !!catalogEntry,
    registryVerdict,
  };
}

/** The candidate SET for a dead model. */
export function generateCandidates(
  dead: LlmModelIdDeprecation,
  catalog: readonly ActiveModel[],
  candidateProvider: 'openai' | 'anthropic' | 'google',
): { officialId: string | null; officialEntry: ActiveModel | undefined; alternatives: ActiveModel[] } {
  const providerCatalog = catalog.filter((m) => m.provider === candidateProvider);
  // The official successor is the registry's `replacement`, and only when the
  // candidate provider is the dead model's own provider (no cross-provider 1:1).
  const officialId = candidateProvider === dead.provider && dead.replacement ? dead.replacement : null;
  const officialEntry = officialId ? providerCatalog.find((m) => m.modelId === officialId) : undefined;
  const alternatives = providerCatalog.filter((m) => m.modelId !== officialId && m.modelId !== dead.deprecated);
  return { officialId, officialEntry, alternatives };
}

/** Neutral canonical order: ascending modelId. */
function byModelId(a: CandidateDecision, b: CandidateDecision): number {
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

/** Apply an explicit --sort preference to kept candidates (default: canonical modelId). */
function sortKept(
  decisions: CandidateDecision[],
  lookup: ReadonlyMap<string, ActiveModel>,
  sortBy: 'cost' | 'context' | null,
): CandidateDecision[] {
  const out = [...decisions];
  if (sortBy === 'cost') {
    out.sort((a, b) => {
      const ca = lookup.get(a.modelId);
      const cb = lookup.get(b.modelId);
      const pa = ca ? ca.price.inputPerMTok.value + ca.price.outputPerMTok.value : Infinity;
      const pb = cb ? cb.price.inputPerMTok.value + cb.price.outputPerMTok.value : Infinity;
      return pa - pb || byModelId(a, b);
    });
  } else if (sortBy === 'context') {
    out.sort((a, b) => {
      const ca = lookup.get(a.modelId);
      const cb = lookup.get(b.modelId);
      const va = ca ? ca.capabilities.contextTokens.value : -Infinity;
      const vb = cb ? cb.capabilities.contextTokens.value : -Infinity;
      return vb - va || byModelId(a, b);
    });
  } else {
    out.sort(byModelId);
  }
  return out;
}

/** The filtered result for one dead model: kept (split by origin) + rejected. */
export interface FilterResult {
  officialSuccessors: CandidateDecision[];
  compatibleAlternatives: CandidateDecision[];
  rejected: CandidateDecision[];
  alternativesQualified: boolean;
}

/** Generate, decide, split, and order the candidates for one dead model. */
export function filterCandidates(
  dead: LlmModelIdDeprecation,
  requirements: readonly ExtractedRequirement[],
  catalog: readonly ActiveModel[],
  candidateProvider: 'openai' | 'anthropic' | 'google',
  sortBy: 'cost' | 'context' | null,
): FilterResult {
  const { officialId, officialEntry, alternatives } = generateCandidates(dead, catalog, candidateProvider);
  const lookup = new Map(catalog.map((m) => [m.modelId, m]));

  // The registry's documented successor is always surfaced (at most one), even
  // when the catalog does not cover it — so recommend agrees with watch/fix-llm.
  const officialSuccessors: CandidateDecision[] = officialId
    ? [decideOfficialSuccessor(officialId, officialEntry, requirements, effectiveVerificationState(dead))]
    : [];

  // MODEL-CLASS SAFETY: a candidate is only "compatibility-qualified" if we could
  // determine the call's endpoint family (its model class). If the endpoint is
  // unknown (e.g. a Python call, or a dall-e/embeddings call whose class we can't
  // read), we do NOT offer alternatives — a chat model must never be called
  // "compatible" for an image-generation call. The official successor still shows.
  const endpointReq = requirements.find((r) => r.key === 'endpoint');
  const alternativesQualified = endpointReq === undefined || endpointReq.state !== 'unknown';
  const altDecisions = alternativesQualified
    ? alternatives.map((m) => decideCandidate(m, 'compatible_alternative', requirements))
    : [];

  return {
    alternativesQualified,
    officialSuccessors,
    compatibleAlternatives: sortKept(altDecisions.filter((d) => d.kept), lookup, sortBy),
    rejected: altDecisions.filter((d) => !d.kept).sort(byModelId),
  };
}
