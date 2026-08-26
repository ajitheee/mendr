import { describe, expect, it } from 'vitest';
import { loadActiveModels, validateActiveModels } from './catalog.js';
import { loadLlmRegistry, modelIdEntries } from '../usage/llmRegistry.js';
import { activeEntryIdFor } from './activeEntryId.js';
import type { ActiveModel, EndpointFamily, Provenanced } from './types.js';

function prov<T>(value: T, source = 'https://docs.test/x', checkedAt = '2026-08-25'): Provenanced<T> {
  return { value, source, checkedAt };
}

function makeActiveModel(o: Partial<{
  provider: 'openai' | 'anthropic' | 'google';
  modelId: string;
  lifecycle: 'active' | 'preview';
  tools: boolean;
  jsonStrict: boolean;
  streaming: boolean;
  vision: boolean;
  reasoning: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  endpoint: EndpointFamily;
  regionsUnknown: boolean;
}> = {}): ActiveModel {
  const provider = o.provider ?? 'openai';
  const modelId = o.modelId ?? 'gpt-4o';
  return {
    entryId: activeEntryIdFor({ provider, modelId }),
    provider,
    modelId,
    lifecycle: o.lifecycle ?? 'active',
    capabilities: {
      tools: prov(o.tools ?? true),
      jsonStrict: prov(o.jsonStrict ?? true),
      streaming: prov(o.streaming ?? true),
      vision: prov(o.vision ?? true),
      reasoning: prov(o.reasoning ?? false),
      contextTokens: prov(o.contextTokens ?? 128000),
      maxOutputTokens: prov(o.maxOutputTokens ?? 16384),
    },
    endpoint: prov<EndpointFamily>(o.endpoint ?? 'chat_completions'),
    price: { inputPerMTok: prov(2.5), outputPerMTok: prov(10), currency: 'USD' },
    availability: {
      regions: o.regionsUnknown ? { value: 'unknown' } : prov<string[]>(['global']),
      requiresPreviewAccess: prov(false),
      minAccountTier: prov<string | null>(null),
    },
  };
}

describe('validateActiveModels — criterion 1 (every field has a source and date)', () => {
  it('a well-formed record, including the regions unknown-sentinel, yields zero violations', () => {
    const catalog = [makeActiveModel({ regionsUnknown: true })];
    const result = validateActiveModels(catalog, new Set());
    expect(result.violations).toEqual([]);
  });

  it('flags a capability with an empty source', () => {
    const m = makeActiveModel();
    m.capabilities.tools.source = '';
    const result = validateActiveModels([m], new Set());
    expect(result.violations.map((v) => v.code)).toContain('missing_field_source');
  });

  it('flags a field with an invalid checkedAt', () => {
    const m = makeActiveModel();
    m.capabilities.maxOutputTokens.checkedAt = 'yesterday';
    const result = validateActiveModels([m], new Set());
    expect(result.violations.map((v) => v.code)).toContain('missing_field_checked_at');
  });

  it('does NOT flag the regions unknown-sentinel for missing provenance', () => {
    const m = makeActiveModel({ regionsUnknown: true });
    const result = validateActiveModels([m], new Set());
    expect(result.violations.filter((v) => v.message.includes('regions'))).toEqual([]);
  });
});

describe('validateActiveModels — criterion 12 (cross-registry + identity codes)', () => {
  it('flags a modelId that is a deprecated id in the deprecation registry', () => {
    const m = makeActiveModel({ modelId: 'gpt-4' });
    const result = validateActiveModels([m], new Set(['gpt-4']));
    expect(result.violations.map((v) => v.code)).toContain('active_id_is_deprecated');
  });

  it('flags an entryId that does not match the derived id', () => {
    const m = makeActiveModel();
    m.entryId = 'openai.wrong.active';
    const result = validateActiveModels([m], new Set());
    expect(result.violations.map((v) => v.code)).toContain('entry_id_mismatch');
  });

  it('flags a duplicate entryId', () => {
    const catalog = [makeActiveModel(), makeActiveModel()];
    const result = validateActiveModels(catalog, new Set());
    expect(result.violations.map((v) => v.code)).toContain('duplicate_entry_id');
  });

  it('flags an invalid lifecycle', () => {
    const m = makeActiveModel();
    (m as { lifecycle: string }).lifecycle = 'retired';
    const result = validateActiveModels([m], new Set());
    expect(result.violations.map((v) => v.code)).toContain('invalid_lifecycle');
  });
});

describe('the SHIPPED catalog is valid', () => {
  it('registries/llm-active-models.json loads and validates clean against the deprecation registry', () => {
    const catalog = loadActiveModels();
    const deprecatedIds = new Set(modelIdEntries(loadLlmRegistry()).map((e) => e.deprecated));
    expect(validateActiveModels(catalog, deprecatedIds).violations).toEqual([]);
  });
});
