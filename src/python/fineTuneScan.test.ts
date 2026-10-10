import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, loadLlmRegistry } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals } from './scanPy.js';
import { applyPyModelIdFixesToSources } from './fixPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';

// THE PYTHON TWIN of src/usage/fineTuneScan.test.ts.
//
// v0.5.9-alpha's known issue: `create(model="ft:gpt-4-0613:acme::abc123")` matched no registry
// value, so `audit` concluded no exposure and `fix-llm` printed "Nothing to fix". A fine-tune is
// now located wherever a plain id is, joined to the registry's row for fine-tunes of its base,
// and held for review: never swapped, because the swap would drop the customer's training.
// Fixtures written for this suite.

const SHIPPED = loadLlmRegistry();
const CLIENT = 'from openai import OpenAI\nclient = OpenAI()\n\n';

async function scan(text: string, registry: LlmRegistry = SHIPPED, path = 'app/llm.py') {
  return (await findPyModelIdLiterals([{ path, text }], registry)).map((m) => {
    const { tier, reason: code } = classifyOccurrenceTier(m);
    return {
      value: m.value,
      row: m.deprecation.deprecated,
      entryId: m.deprecation.entryId,
      position: m.position,
      purpose: m.purpose,
      /** The scanner's own sentence. */
      reason: m.reason,
      fineTuneOf: m.fineTuneOf,
      tier,
      /** The Tier B reason code. */
      code,
    };
  });
}

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], SHIPPED);
}, 60_000);

describe('a fine-tuned model id in a live Python call', () => {
  it('is located, joined to its ft- row, and held for review with the training sentence', async () => {
    const found = await scan(
      `${CLIENT}def run(messages):\n    return client.chat.completions.create(model="ft:gpt-4-0613:acme::abc123", messages=messages)\n`,
    );
    expect(found.map((f) => [f.value, f.entryId, f.position, f.tier, f.code])).toEqual([
      ['ft:gpt-4-0613:acme::abc123', 'openai.ft-gpt-4.retirement-2026-10-23', 'surface_capped', 'B', 'surface_capped'],
    ]);
    expect(found[0]!.reason).toContain('ft:gpt-4-0613:acme::abc123 is a fine-tune of gpt-4-0613');
    expect(found[0]!.reason).toContain("would drop the customer's training");
  }, 60_000);

  it('is never swapped, and fix-llm lists it as a held call with its record', async () => {
    const text = `${CLIENT}def run(prompt):\n    return client.completions.create(model="ft:babbage-002:acme::9abc", prompt=prompt)\n`;
    const result = await applyPyModelIdFixesToSources([{ path: 'app/llm.py', text }], SHIPPED);
    expect(result.siteCount).toBe(0);
    expect(result.diff).toBe('');
    expect(result.blockedMatches).toEqual([]);
    expect(result.usageUnverifiedMatches).toEqual([]);
    expect(result.heldMatches.map((m) => [m.value, m.deprecation.entryId])).toEqual([
      ['ft:babbage-002:acme::9abc', 'openai.ft-babbage-002.retirement-2026-10-23'],
    ]);
  }, 60_000);

  it('is held even when its base model has a verified row and no ft- row covers it', async () => {
    const baseOnly: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4o-2024-05-13', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
    ];
    const text =
      `${CLIENT}def run(messages):\n` +
      '    a = client.chat.completions.create(model="ft:gpt-4o-2024-05-13:acme::w1", messages=messages)\n' +
      '    b = client.chat.completions.create(model="gpt-4o-2024-05-13", messages=messages)\n' +
      '    return a, b\n';
    const found = await scan(text, baseOnly);
    expect(found.map((f) => [f.value, f.row, f.tier, f.position])).toEqual([
      ['ft:gpt-4o-2024-05-13:acme::w1', 'gpt-4o-2024-05-13', 'B', 'surface_capped'],
      // The control: the base model itself, in the same call shape, is a Tier A swap.
      ['gpt-4o-2024-05-13', 'gpt-4o-2024-05-13', 'A', 'model_arg'],
    ]);
    const result = await applyPyModelIdFixesToSources([{ path: 'app/llm.py', text }], baseOnly);
    expect(result.siteCount).toBe(1);
    expect(result.patchedFiles[0]!.newText).toContain('"ft:gpt-4o-2024-05-13:acme::w1"');
  }, 60_000);

  it('is held through a module constant, an untraced constant, a gateway prefix and a sample tree', async () => {
    const viaConst = await scan(
      `${CLIENT}FT_MODEL = "ft:gpt-3.5-turbo-0125:acme::9abc"\n\ndef run(messages):\n    return client.chat.completions.create(model=FT_MODEL, messages=messages)\n`,
    );
    expect(viaConst.map((f) => [f.row, f.tier, f.position])).toEqual([['ft-gpt-3.5-turbo', 'B', 'surface_capped']]);

    // A plain id here would be usage_unverified; a fine-tune is held as a fine-tune, and still never swapped.
    const untraced = await scan('DEFAULT_MODEL = "ft:gpt-3.5-turbo-0125:acme::9abc"\n');
    expect(untraced.map((f) => [f.row, f.tier, f.code])).toEqual([['ft-gpt-3.5-turbo', 'B', 'surface_capped']]);

    const viaGateway = await scan(
      `${CLIENT}def run(messages):\n    return client.chat.completions.create(model="openai/ft:gpt-4-0613:acme::abc123", messages=messages)\n`,
    );
    expect(viaGateway.map((f) => [f.row, f.tier, f.position])).toEqual([['ft-gpt-4', 'B', 'surface_capped']]);

    const inSample = await scan(
      `${CLIENT}def run(messages):\n    return client.chat.completions.create(model="ft:gpt-4-0613:acme::abc123", messages=messages)\n`,
      SHIPPED,
      'examples/chat.py',
    );
    expect(inSample.map((f) => [f.tier, f.position])).toEqual([['B', 'surface_capped']]);
  }, 60_000);
});

describe('a fine-tuned model id in a Python data position', () => {
  it('stays data, as a plain id would: a list, a dict key, a comparison', async () => {
    const found = await scan(
      'MODELS = ["ft:gpt-4-0613:acme::abc123"]\n' +
        'PRICES = {"ft:gpt-4-0613:acme::abc123": 3}\n\n' +
        'def is_ft(m):\n    return m == "ft:babbage-002:acme::9abc"\n',
    );
    expect(found.map((f) => [f.row, f.tier, f.purpose])).toEqual([
      ['ft-gpt-4', 'C', 'list_entry'],
      ['ft-gpt-4', 'C', 'lookup_key'],
      ['ft-babbage-002', 'C', 'comparison'],
    ]);
  }, 60_000);
});

describe('Python strings that are not a whole fine-tuned model id', () => {
  it('never match, in the positions where a fine-tune id would be held', async () => {
    const lines = [
      'from openai import OpenAI',
      'client = OpenAI()',
      'base = "gpt-4o-mini"',
      '',
      'def run(messages):',
      // Text around the id, a missing organisation or job id, another prefix, a family the
      // ft-gpt-4 row does not cover, and a base model the registry does not list.
      '    client.chat.completions.create(model="see ft:gpt-3.5-turbo-0125:acme::9abc", messages=messages)',
      '    client.chat.completions.create(model="ft:gpt-3.5-turbo-0125", messages=messages)',
      '    client.chat.completions.create(model="ft:gpt-3.5-turbo-0125:acme::", messages=messages)',
      '    client.chat.completions.create(model="draft:gpt-4-0613:acme::abc", messages=messages)',
      '    client.chat.completions.create(model="ft:gpt-4o:acme::abc", messages=messages)',
      '    client.chat.completions.create(model="ft:gpt-4o-2024-08-06:acme::abc", messages=messages)',
      // An f-string is not a fixed value, bytes are not a str, a log line is not an id, a comment is not a literal.
      '    client.chat.completions.create(model=f"ft:{base}:acme::abc", messages=messages)',
      '    client.chat.completions.create(model=b"ft:gpt-4-0613:acme::abc123", messages=messages)',
      '    print("fine-tuned via ft:gpt-4-0613:acme::abc123 last week")',
      '    # model="ft:gpt-4-0613:acme::abc123"',
      '',
    ];
    expect(await scan(lines.join('\n'))).toEqual([]);
  }, 60_000);
});
