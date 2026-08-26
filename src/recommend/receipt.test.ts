import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { buildReceipt } from './receipt.js';
import type { FilterResult } from './filter.js';
import { REQUIREMENT_KEYS } from './types.js';
import type {
  CandidateDecision,
  CapabilityCheck,
  ExtractedRequirement,
  RequirementKey,
  RequirementState,
} from './types.js';

const dead: LlmModelIdDeprecation = {
  provider: 'openai',
  kind: 'model_id',
  deprecated: 'gpt-4',
  replacement: 'gpt-4o',
};

function req(key: RequirementKey, state: RequirementState): ExtractedRequirement {
  return { key, state, evidence: null };
}
function allNotObserved(): ExtractedRequirement[] {
  return REQUIREMENT_KEYS.map((k) => req(k, 'not_observed'));
}
function check(result: CapabilityCheck['result']): CapabilityCheck {
  return { key: 'tools', requirement: 'required', catalogValue: true, result };
}
function kept(modelId: string, checks: CapabilityCheck[], inCatalog = true): CandidateDecision {
  return { modelId, origin: 'compatible_alternative', kept: true, checks, eliminatedBy: null, eliminationDetail: null, inCatalog, registryVerdict: null };
}
function emptyFilter(): FilterResult {
  return { officialSuccessors: [], compatibleAlternatives: [], rejected: [] };
}
function receipt(requirements: ExtractedRequirement[], filter: FilterResult) {
  return buildReceipt({
    dead,
    candidateProvider: 'openai',
    occurrences: 1,
    requirements,
    filter,
    sortBy: null,
    deadlineDays: 30,
  });
}

const SATISFIED_ONLY: FilterResult = {
  officialSuccessors: [],
  compatibleAlternatives: [kept('gpt-4o', [check('satisfied')])],
  rejected: [],
};
const HAS_INDETERMINATE: FilterResult = {
  officialSuccessors: [],
  compatibleAlternatives: [kept('gpt-4o', [check('indeterminate')])],
  rejected: [],
};

describe('buildReceipt — criterion 11 (VerificationScope is honest)', () => {
  it('the seven un-measured dimensions are ALWAYS not_evaluated', () => {
    const v = receipt(allNotObserved(), SATISFIED_ONLY).verification;
    for (const dim of ['availability', 'code', 'toolBehavior', 'outputSchema', 'cost', 'latency', 'semanticQuality'] as const) {
      expect(v[dim]).toBe('not_evaluated');
    }
  });

  it('capabilities is passed only when every required check on a kept candidate is satisfied', () => {
    expect(receipt(allNotObserved(), SATISFIED_ONLY).verification.capabilities).toBe('passed');
    expect(receipt(allNotObserved(), SATISFIED_ONLY).verification.providerStatus).toBe('passed');
  });

  it('capabilities is unknown when a kept candidate has an indeterminate required check', () => {
    expect(receipt(allNotObserved(), HAS_INDETERMINATE).verification.capabilities).toBe('unknown');
  });

  it('capabilities and providerStatus are failed when the kept set is empty', () => {
    const v = receipt(allNotObserved(), emptyFilter()).verification;
    expect(v.capabilities).toBe('failed');
    expect(v.providerStatus).toBe('failed');
  });

  it('capabilities is UNKNOWN when a requirement is unknown, even if a required check passes (real-repo honesty)', () => {
    // A satisfied required check + an unknown requirement: we could NOT fully
    // verify what the call needs, so 'passed' would over-claim.
    const filter: FilterResult = {
      officialSuccessors: [],
      compatibleAlternatives: [
        kept('gpt-4o', [check('satisfied'), { key: 'vision', requirement: 'unknown', catalogValue: true, result: 'indeterminate' }]),
      ],
      rejected: [],
    };
    const reqs = allNotObserved().map((r) => (r.key === 'vision' ? req('vision', 'unknown') : r));
    const rc = receipt(reqs, filter);
    expect(rc.verification.capabilities).toBe('unknown');
    expect(rc.reviewFlag).toBe(true);
  });

  it('providerStatus is unknown when the only kept candidate is a registry successor not in the catalog', () => {
    const notInCatalog: CandidateDecision = {
      modelId: 'gpt-5.6-sol', origin: 'official_successor', kept: true,
      checks: allNotObserved().map((r) => ({ key: r.key, requirement: r.state, catalogValue: 'unknown' as const, result: 'indeterminate' as const })),
      eliminatedBy: null, eliminationDetail: null, inCatalog: false, registryVerdict: 'verified',
    };
    const rc = receipt(allNotObserved(), { officialSuccessors: [notInCatalog], compatibleAlternatives: [], rejected: [] });
    expect(rc.verification.providerStatus).toBe('unknown');
  });
});

describe('buildReceipt — criterion 5 (reviewFlag)', () => {
  it('is true when any requirement is unknown', () => {
    const reqs = allNotObserved().map((r) => (r.key === 'vision' ? req('vision', 'unknown') : r));
    expect(receipt(reqs, SATISFIED_ONLY).reviewFlag).toBe(true);
  });

  it('is true when a kept candidate has an indeterminate check, with ZERO unknown requirements', () => {
    const rc = receipt(allNotObserved(), HAS_INDETERMINATE);
    expect(rc.requirements.some((r) => r.state === 'unknown')).toBe(false);
    expect(rc.reviewFlag).toBe(true);
  });

  it('is false when nothing is unknown or indeterminate', () => {
    expect(receipt(allNotObserved(), SATISFIED_ONLY).reviewFlag).toBe(false);
  });

  it('authorization is always compatibility_only in M1', () => {
    expect(receipt(allNotObserved(), SATISFIED_ONLY).authorization).toEqual({ type: 'compatibility_only' });
  });
});
