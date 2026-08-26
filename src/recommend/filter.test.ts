import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { filterCandidates } from './filter.js';
import { activeEntryIdFor } from './activeEntryId.js';
import { REQUIREMENT_KEYS } from './types.js';
import type {
  ActiveModel,
  EndpointFamily,
  ExtractedRequirement,
  Provenanced,
  RequirementKey,
  RequirementState,
} from './types.js';

function prov<T>(value: T): Provenanced<T> {
  return { value, source: 'https://docs.test/x', checkedAt: '2026-08-25' };
}

function model(o: Partial<{
  provider: 'openai' | 'anthropic' | 'google';
  modelId: string;
  tools: boolean;
  maxOutputTokens: number;
  contextTokens: number;
  endpoint: EndpointFamily;
  inputPerMTok: number;
  outputPerMTok: number;
}> = {}): ActiveModel {
  const provider = o.provider ?? 'openai';
  const modelId = o.modelId ?? 'gpt-4o';
  return {
    entryId: activeEntryIdFor({ provider, modelId }),
    provider,
    modelId,
    lifecycle: 'active',
    capabilities: {
      tools: prov(o.tools ?? true),
      jsonStrict: prov(true),
      streaming: prov(true),
      vision: prov(true),
      reasoning: prov(false),
      contextTokens: prov(o.contextTokens ?? 128000),
      maxOutputTokens: prov(o.maxOutputTokens ?? 16384),
    },
    endpoint: prov<EndpointFamily>(o.endpoint ?? 'chat_completions'),
    price: { inputPerMTok: prov(o.inputPerMTok ?? 2.5), outputPerMTok: prov(o.outputPerMTok ?? 10), currency: 'USD' },
    availability: {
      regions: { value: 'unknown' },
      requiresPreviewAccess: prov(false),
      minAccountTier: prov<string | null>(null),
    },
  };
}

function req(key: RequirementKey, state: RequirementState, extra: Partial<ExtractedRequirement> = {}): ExtractedRequirement {
  return { key, state, evidence: null, ...extra };
}
function allNotObserved(): ExtractedRequirement[] {
  return REQUIREMENT_KEYS.map((k) => req(k, 'not_observed'));
}
/** Replace one key's requirement in an all-not_observed baseline. */
function withReq(key: RequirementKey, state: RequirementState, extra: Partial<ExtractedRequirement> = {}): ExtractedRequirement[] {
  return allNotObserved().map((r) => (r.key === key ? req(key, state, extra) : r));
}

const dead: LlmModelIdDeprecation = {
  provider: 'openai',
  kind: 'model_id',
  deprecated: 'gpt-4',
  replacement: 'gpt-4o',
};

describe('filterCandidates — criterion 2 (successors vs alternatives stay separate)', () => {
  it('the registry replacement is an official successor; other actives are alternatives; never both', () => {
    const catalog = [model({ modelId: 'gpt-4o' }), model({ modelId: 'gpt-4o-mini' })];
    const r = filterCandidates(dead, allNotObserved(), catalog, 'openai', null);
    expect(r.officialSuccessors.map((d) => d.modelId)).toEqual(['gpt-4o']);
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['gpt-4o-mini']);
    const overlap = r.officialSuccessors.some((s) => r.compatibleAlternatives.some((a) => a.modelId === s.modelId));
    expect(overlap).toBe(false);
  });
});

describe('filterCandidates — criterion 4 (only required eliminates)', () => {
  const catalog = [model({ modelId: 'gpt-4o-mini', tools: false })]; // NOT the replacement -> alternative

  it('a not_observed capability removes no candidate', () => {
    const r = filterCandidates(dead, withReq('tools', 'not_observed'), catalog, 'openai', null);
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['gpt-4o-mini']);
    expect(r.rejected).toEqual([]);
  });

  it('an unknown requirement removes no candidate', () => {
    const r = filterCandidates(dead, withReq('tools', 'unknown'), catalog, 'openai', null);
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['gpt-4o-mini']);
  });

  it('a required-and-unsatisfied capability eliminates', () => {
    const r = filterCandidates(dead, withReq('tools', 'required'), catalog, 'openai', null);
    expect(r.compatibleAlternatives).toEqual([]);
    expect(r.rejected.map((d) => d.modelId)).toEqual(['gpt-4o-mini']);
  });

  it('a required capability against an UNPROVENANCED catalog field is indeterminate, not eliminated', () => {
    const m = model({ modelId: 'gpt-4o-mini', tools: false });
    m.capabilities.tools.source = ''; // strip provenance
    const r = filterCandidates(dead, withReq('tools', 'required'), [m], 'openai', null);
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['gpt-4o-mini']);
    expect(r.rejected).toEqual([]);
    const check = r.compatibleAlternatives[0].checks.find((c) => c.key === 'tools')!;
    expect(check.result).toBe('indeterminate');
  });
});

describe('filterCandidates — criterion 6 (no ranking without --sort)', () => {
  const noReplacement: LlmModelIdDeprecation = { ...dead, replacement: 'none' };
  // Authored in DESCENDING modelId order so a file-order passthrough would give
  // the WRONG answer — the assertion only holds if the canonical sort runs.
  const catalog = [
    model({ modelId: 'zzz-cheap', inputPerMTok: 1, outputPerMTok: 2 }),
    model({ modelId: 'aaa-pricey', inputPerMTok: 10, outputPerMTok: 40 }),
  ];

  it('defaults to neutral ascending-modelId order, independent of catalog file order', () => {
    const r = filterCandidates(noReplacement, allNotObserved(), catalog, 'openai', null);
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['aaa-pricey', 'zzz-cheap']);
  });

  it('--sort cost reorders by total price', () => {
    const r = filterCandidates(noReplacement, allNotObserved(), catalog, 'openai', 'cost');
    expect(r.compatibleAlternatives.map((d) => d.modelId)).toEqual(['zzz-cheap', 'aaa-pricey']);
  });
});

describe('filterCandidates — criterion 7 (every eliminated candidate has a machine reason)', () => {
  it('a rejected candidate carries eliminatedBy + eliminationDetail', () => {
    const catalog = [model({ modelId: 'gpt-4o-mini', tools: false })];
    const r = filterCandidates(dead, withReq('tools', 'required'), catalog, 'openai', null);
    const rej = r.rejected[0];
    expect(rej.eliminatedBy).toBe('tools');
    expect(rej.eliminationDetail).toBeTruthy();
  });
});

describe('filterCandidates — criterion 13 (cross-provider sourcing)', () => {
  it('drawing from another provider yields no official successor and only alternatives', () => {
    const catalog = [model({ provider: 'google', modelId: 'gemini-3.6-flash', endpoint: 'gemini_generate' })];
    const r = filterCandidates(dead, allNotObserved(), catalog, 'google', null);
    expect(r.officialSuccessors).toEqual([]);
    expect(r.compatibleAlternatives.map((d) => d.origin)).toEqual(['compatible_alternative']);
  });
});

describe('filterCandidates — criterion 14 (empty kept set is first-class)', () => {
  it('all candidates eliminated yields both kept arrays empty and every rejected has eliminatedBy', () => {
    const catalog = [model({ modelId: 'gpt-4o', tools: false }), model({ modelId: 'gpt-4o-mini', tools: false })];
    const r = filterCandidates(dead, withReq('tools', 'required'), catalog, 'openai', null);
    expect(r.officialSuccessors).toEqual([]);
    expect(r.compatibleAlternatives).toEqual([]);
    expect(r.rejected.length).toBe(2);
    expect(r.rejected.every((d) => d.eliminatedBy !== null)).toBe(true);
  });
});
