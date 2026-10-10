import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { loadLlmRegistry, modelIdEntries, withheldVerification } from './llmRegistry.js';
import {
  fineTuneHoldReason,
  fineTuneRowId,
  fineTuneTextTokens,
  reportedFineTuneBase,
  resolveSourceFineTune,
  sourceFineTuneBase,
} from './fineTune.js';
import { buildRegistryPrefilter } from './scanRepo.js';
import { registryModelId } from '../recon/usageAudit.js';

// The fine-tune rule the usage audit and both source scanners share (fineTune.ts). The scanners
// read strings that are not known to be model ids, so their half of it must match a WHOLE
// fine-tune id and nothing else.

const SHIPPED = loadLlmRegistry();
const ENTRIES = modelIdEntries(SHIPPED);

function index(entries: readonly LlmModelIdDeprecation[]): Map<string, LlmModelIdDeprecation[]> {
  const m = new Map<string, LlmModelIdDeprecation[]>();
  for (const e of entries) m.set(e.deprecated, [...(m.get(e.deprecated) ?? []), e]);
  return m;
}

describe('sourceFineTuneBase: a whole fine-tuned model id', () => {
  it('reads the base model out of the ids OpenAI issues', () => {
    expect(sourceFineTuneBase('ft:gpt-3.5-turbo-0125:acme::9abc')).toBe('gpt-3.5-turbo-0125');
    expect(sourceFineTuneBase('ft:babbage-002:acme::9abc')).toBe('babbage-002');
    expect(sourceFineTuneBase('ft:gpt-4-0613:acme::abc123')).toBe('gpt-4-0613');
    // A named suffix, an organisation with a dash, and a checkpoint.
    expect(sourceFineTuneBase('ft:gpt-4.1-nano-2025-04-14:my-org:support_bot:AbC123')).toBe('gpt-4.1-nano-2025-04-14');
    expect(sourceFineTuneBase('ft:o4-mini-2025-04-16:acme::9abc:ckpt-step-88')).toBe('o4-mini-2025-04-16');
  });

  it('refuses a string that merely contains a fine-tune id, or is only part of one', () => {
    for (const value of [
      'see ft:gpt-3.5-turbo-0125:acme::9abc',
      'ft:gpt-3.5-turbo-0125:acme::9abc is retiring',
      ' ft:gpt-3.5-turbo-0125:acme::9abc',
      'draft:gpt-3.5-turbo-0125:acme::9abc',
      'FT:gpt-3.5-turbo-0125:acme::9abc',
      'ft-gpt-3.5-turbo',
      'ft:gpt-3.5-turbo-0125',
      'ft:gpt-3.5-turbo-0125:',
      'ft:gpt-3.5-turbo-0125:acme',
      'ft:gpt-3.5-turbo-0125:acme::',
      'ft:gpt-3.5-turbo-0125:acme::9abc:extra',
      'ft::acme::9abc',
      'ft: gpt-3.5-turbo-0125:acme::9abc',
      'ft:gpt-3.5-turbo-0125:ac me::9abc',
      'left:right',
      'ft:',
    ]) {
      expect(sourceFineTuneBase(value), value).toBeUndefined();
    }
  });

  it('is stricter than the usage-audit reading, which trusts that a reported id is a model id', () => {
    expect(reportedFineTuneBase('ft:gpt-4-0613:acme')).toBe('gpt-4-0613');
    expect(sourceFineTuneBase('ft:gpt-4-0613:acme')).toBeUndefined();
    expect(reportedFineTuneBase('gpt-4-0613')).toBeUndefined();
  });
});

describe('fineTuneRowId: the row a fine-tune joins', () => {
  it('joins the shipped ft- rows by the exact-segment family rule, most specific first', () => {
    expect(fineTuneRowId('gpt-3.5-turbo-0125', 'unknown', ENTRIES)).toBe('ft-gpt-3.5-turbo');
    expect(fineTuneRowId('gpt-3.5-turbo-1106', 'openai', ENTRIES)).toBe('ft-gpt-3.5-turbo');
    expect(fineTuneRowId('gpt-4-0613', 'unknown', ENTRIES)).toBe('ft-gpt-4');
    expect(fineTuneRowId('babbage-002', 'unknown', ENTRIES)).toBe('ft-babbage-002');
    expect(fineTuneRowId('davinci-002', 'unknown', ENTRIES)).toBe('ft-davinci-002');
    expect(fineTuneRowId('gpt-4.1-nano-2025-04-14', 'unknown', ENTRIES)).toBe('ft-gpt-4.1-nano-2025-04-14');
    expect(fineTuneRowId('o4-mini-2025-04-16', 'unknown', ENTRIES)).toBe('ft-o4-mini-2025-04-16');
  });

  it('falls back to the base model when no row covers it, and never bleeds across a family', () => {
    // gpt-4o is not gpt-4 plus a segment.
    expect(fineTuneRowId('gpt-4o-2024-08-06', 'unknown', ENTRIES)).toBe('gpt-4o-2024-08-06');
    expect(fineTuneRowId('gpt-4o-2024-05-13', 'unknown', ENTRIES)).toBe('gpt-4o-2024-05-13');
    // Another provider's fine-tune never joins an OpenAI row.
    expect(fineTuneRowId('babbage-002', 'google', ENTRIES)).toBe('babbage-002');
  });

  it('is the rule the usage audit applies to the same ids', () => {
    for (const raw of [
      'ft:gpt-3.5-turbo-0125:acme::9abc',
      'ft:babbage-002:acme::9abc',
      'ft:gpt-4-0613:acme::abc123',
      'ft:gpt-4o-2024-05-13:acme::w',
      'ft:o4-mini-2025-04-16:acme::9abc:ckpt-step-88',
    ]) {
      expect(registryModelId(raw, 'unknown', ENTRIES), raw).toBe(fineTuneRowId(sourceFineTuneBase(raw)!, 'unknown', ENTRIES));
    }
  });
});

describe('resolveSourceFineTune', () => {
  const byValue = index(ENTRIES);

  it('returns the records of the row a whole fine-tune id joins', () => {
    const ft = resolveSourceFineTune('ft:gpt-3.5-turbo-0125:acme::9abc', byValue, ENTRIES);
    expect(ft?.base).toBe('gpt-3.5-turbo-0125');
    expect(ft?.records.map((r) => r.entryId)).toEqual(['openai.ft-gpt-3.5-turbo.retirement-2026-10-23']);
    // Every shipped fine-tune row is held at review: a fine-tune is never an automatic swap.
    expect(ft?.records.every((r) => r.verification?.status === 'quarantined')).toBe(true);
  });

  it('returns nothing for a fine-tune of a model the registry does not list, or for a non-id', () => {
    expect(resolveSourceFineTune('ft:gpt-4o-2024-08-06:acme::abc', byValue, ENTRIES)).toBeUndefined();
    expect(resolveSourceFineTune('ft:gpt-4o:acme::abc', byValue, ENTRIES)).toBeUndefined();
    expect(resolveSourceFineTune('see ft:gpt-4-0613:acme::abc', byValue, ENTRIES)).toBeUndefined();
    expect(resolveSourceFineTune('gpt-4-0613', byValue, ENTRIES)).toBeUndefined();
  });
});

describe('fineTuneHoldReason', () => {
  it('names the id, says the swap would drop the training, and says what to do', () => {
    const text = fineTuneHoldReason('ft:babbage-002:acme::9abc', 'babbage-002', 'gpt-5.6-terra');
    expect(text).toContain('ft:babbage-002:acme::9abc is a fine-tune of babbage-002');
    expect(text).toContain("would drop the customer's training");
    expect(text).toContain('change the id by hand');
    expect(text.endsWith('.')).toBe(true);
  });
});

describe('the registry pre-filter reads fine-tune ids', () => {
  it('adds ft:<family> for each ft- row, so a file holding only a fine-tune is parsed', () => {
    const onlyFineTuneRow: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'ft-gpt-4.1-nano-2025-04-14',
        replacement: 'gpt-5.6-luna',
        status: 'deprecated',
        shutdownDate: '2026-10-23',
        verification: withheldVerification('quarantined'),
      },
    ];
    expect(fineTuneTextTokens(modelIdEntries(onlyFineTuneRow))).toEqual(['ft:gpt-4.1-nano-2025-04-14']);
    const prefilter = buildRegistryPrefilter(onlyFineTuneRow)!;
    expect(prefilter.test("create({ model: 'ft:gpt-4.1-nano-2025-04-14:acme::9abc' })")).toBe(true);
    expect(prefilter.test("create({ model: 'gpt-4.1-mini' })")).toBe(false);
  });

  it('lets every shipped fine-tune example through', () => {
    const prefilter = buildRegistryPrefilter(SHIPPED)!;
    for (const id of ['ft:gpt-3.5-turbo-0125:acme::9abc', 'ft:babbage-002:acme::9abc', 'ft:gpt-4-0613:acme::abc123']) {
      expect(prefilter.test(`model="${id}"`), id).toBe(true);
    }
  });
});
