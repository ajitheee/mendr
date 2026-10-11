import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { autoApplyVerification, isVerified, loadLlmRegistry, withheldVerification } from './llmRegistry.js';
import { findModelIdLiterals, toHeldCallMatches } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { applyModelIdFixesToProject } from '../fix/modelId.js';
import { applyLlmFixesToProject } from '../fix/llmFix.js';

// OPENAI FINE-TUNED MODEL IDS IN TYPESCRIPT AND JAVASCRIPT.
//
// v0.5.9-alpha's known issue: `create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc' })` matched no
// registry value, so `audit` concluded no exposure and `fix-llm` printed "Nothing to fix" for a
// call OpenAI stops serving on 2026-10-23. A fine-tune is now located wherever a plain id is,
// joined to the registry's row for fine-tunes of its base, and held for review: never swapped,
// because every replacement is a base model and the swap would drop the customer's training.
// Fixtures written for this suite.

const SHIPPED = loadLlmRegistry();
const OPENAI = 'import OpenAI from "openai";\nconst client = new OpenAI();\n';

function project(source: string, file = 'src/app.ts'): Project {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  p.createSourceFile(file, source);
  return p;
}

function scan(source: string, registry: LlmRegistry = SHIPPED, file = 'src/app.ts') {
  return findModelIdLiterals(project(source, file), registry).map((m) => {
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

describe('a fine-tuned model id in a live TypeScript call', { timeout: 60_000 }, () => {
  it('is located, joined to its ft- row, and held for review with the training sentence', () => {
    const found = scan(
      `${OPENAI}export async function run(messages: any[]) {\n` +
        "  await client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc', messages });\n" +
        "  await client.completions.create({ model: 'ft:babbage-002:acme::9abc', prompt: 'hi' });\n" +
        '}\n',
    );
    expect(found.map((f) => [f.value, f.entryId, f.position, f.tier, f.code])).toEqual([
      ['ft:gpt-3.5-turbo-0125:acme::9abc', 'openai.ft-gpt-3.5-turbo.retirement-2026-10-23', 'surface_capped', 'B', 'surface_capped'],
      ['ft:babbage-002:acme::9abc', 'openai.ft-babbage-002.retirement-2026-10-23', 'surface_capped', 'B', 'surface_capped'],
    ]);
    for (const f of found) {
      expect(f.reason).toContain("would drop the customer's training");
      expect(f.reason).toContain(`${f.value} is a fine-tune of ${f.fineTuneOf}`);
    }
  });

  it('is never swapped by both fix passes on the shipped registry, while the base model beside it is', () => {
    // The shipped ft- rows are quarantined, so a fine-tune that joins one is never swapped
    // whatever the hold does. This fine-tune joins no ft- row (ft-gpt-4 does not cover gpt-4o):
    // it joins its base model's shipped row, which is verified, so only the hold keeps it. The
    // base model in the same call shape is the control. No parameter rule names an `ft:` id, so
    // the parameter pass could reach this request only after a swap; neither call carries a
    // parameter a rule applies at the replacement, which would hold the control for another reason.
    const baseRow = SHIPPED.find(
      (e): e is LlmModelIdDeprecation => e.kind === 'model_id' && e.deprecated === 'gpt-4o-2024-05-13',
    );
    expect(baseRow !== undefined && isVerified(baseRow)).toBe(true);
    const source =
      `${OPENAI}export const run = (messages: any[]) => Promise.all([\n` +
      "  client.chat.completions.create({ model: 'ft:gpt-4o-2024-05-13:acme::w1', messages }),\n" +
      "  client.chat.completions.create({ model: 'gpt-4o-2024-05-13', messages }),\n" +
      ']);\n';
    const p = project(source);
    const result = applyLlmFixesToProject(p, SHIPPED);
    expect([result.modelIdSites, result.paramsRenamed, result.paramsRemoved]).toEqual([1, 0, 0]);
    expect(p.getSourceFiles()[0]!.getFullText()).toBe(
      source.replace("model: 'gpt-4o-2024-05-13'", `model: '${baseRow?.replacement}'`),
    );
  });

  it('is held even when its base model has a verified row and no ft- row covers it', () => {
    // registryModelId falls back to the base model, so the fine-tune joins a record that WOULD
    // auto-apply to the base. The swap would still drop the training, so it is held all the same.
    const baseOnly: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4o-2024-05-13', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
    ];
    const source =
      `${OPENAI}export const run = (messages: any[]) => Promise.all([\n` +
      "  client.chat.completions.create({ model: 'ft:gpt-4o-2024-05-13:acme::w1', messages }),\n" +
      "  client.chat.completions.create({ model: 'gpt-4o-2024-05-13', messages }),\n" +
      ']);\n';
    const found = scan(source, baseOnly);
    expect(found.map((f) => [f.value, f.row, f.tier, f.position])).toEqual([
      ['ft:gpt-4o-2024-05-13:acme::w1', 'gpt-4o-2024-05-13', 'B', 'surface_capped'],
      // The control: the base model itself, in the same call shape, is a Tier A swap.
      ['gpt-4o-2024-05-13', 'gpt-4o-2024-05-13', 'A', 'model_arg'],
    ]);
    const p = project(source);
    const result = applyModelIdFixesToProject(p, baseOnly);
    expect(result.siteCount).toBe(1);
    expect(p.getSourceFiles()[0]!.getFullText()).toContain("'ft:gpt-4o-2024-05-13:acme::w1'");
  });

  it('keeps the training sentence when its call also passes a parameter the guard would hold', () => {
    // Shipped registry: gpt-4o-2024-05-13 -> gpt-5.6-sol is verified, and max_tokens is renamed
    // from gpt-5.6 on, so the parameter guard holds the base model's call (param_behaviour_change),
    // written inline or read through a const. The fine-tune is held for its training first, so
    // its finding never reads as a parameter hold a person could clear by renaming max_tokens.
    const inline =
      `${OPENAI}export const run = (messages: any[]) => Promise.all([\n` +
      "  client.chat.completions.create({ model: 'ft:gpt-4o-2024-05-13:acme::w1', messages, max_tokens: 20 }),\n" +
      "  client.chat.completions.create({ model: 'gpt-4o-2024-05-13', messages, max_tokens: 20 }),\n" +
      ']);\n';
    const viaConst =
      `${OPENAI}const FT_MODEL = 'ft:gpt-4o-2024-05-13:acme::w1';\nconst BASE_MODEL = 'gpt-4o-2024-05-13';\n` +
      'export const run = (messages: any[]) => Promise.all([\n' +
      '  client.chat.completions.create({ model: FT_MODEL, messages, max_tokens: 20 }),\n' +
      '  client.chat.completions.create({ model: BASE_MODEL, messages, max_tokens: 20 }),\n' +
      ']);\n';
    for (const [name, source] of [['inline', inline], ['through a const', viaConst]] as const) {
      const found = scan(source);
      expect(found.map((f) => [f.value, f.tier, f.position, f.code]), name).toEqual([
        ['ft:gpt-4o-2024-05-13:acme::w1', 'B', 'surface_capped', 'surface_capped'],
        ['gpt-4o-2024-05-13', 'B', 'surface_capped', 'param_behaviour_change'],
      ]);
      expect(found[0]!.reason, name).toContain("would drop the customer's training");
      expect(found[1]!.reason, name).toContain('`max_tokens` becomes `max_completion_tokens`');
    }
  });

  it('joins its base model record, held, when the registry has no ft- row at all', () => {
    const noFineTuneRows: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: withheldVerification('unverified') },
    ];
    const found = scan(
      `${OPENAI}export const run = (messages: any[]) => client.chat.completions.create({ model: 'ft:gpt-4-0613:acme::abc123', messages });\n`,
      noFineTuneRows,
    );
    // Held as a fine-tune, not reported as an unverified replacement for the base model.
    expect(found.map((f) => [f.row, f.tier, f.code])).toEqual([['gpt-4-0613', 'B', 'surface_capped']]);
  });

  it('is held through a traced const, a cast, a gateway prefix and a sample tree', () => {
    const viaConst = scan(
      `${OPENAI}const FT_MODEL = 'ft:gpt-4-0613:acme::abc123';\nexport const run = (messages: any[]) => client.chat.completions.create({ model: FT_MODEL, messages });\n`,
    );
    expect(viaConst.map((f) => [f.row, f.tier, f.position])).toEqual([['ft-gpt-4', 'B', 'surface_capped']]);

    // A non-string cast demotes a plain id to type_cast_masked; a fine-tune is held as a fine-tune.
    const viaCast = scan(
      `${OPENAI}type FtModel = string & { ft: true };\nexport const run = (messages: any[]) => client.chat.completions.create({ model: ('ft:gpt-4-0613:acme::abc123' as FtModel), messages });\n`,
    );
    expect(viaCast.map((f) => [f.tier, f.code, f.reason?.includes('is a fine-tune of gpt-4-0613') ?? false])).toEqual([
      ['B', 'surface_capped', true],
    ]);

    const viaGateway = scan(
      `${OPENAI}export const run = (messages: any[]) => client.chat.completions.create({ model: 'openai/ft:gpt-4-0613:acme::abc123', messages });\n`,
    );
    expect(viaGateway.map((f) => [f.row, f.tier, f.position])).toEqual([['ft-gpt-4', 'B', 'surface_capped']]);

    const inSample = scan(
      `${OPENAI}export const run = (messages: any[]) => client.chat.completions.create({ model: 'ft:gpt-4-0613:acme::abc123', messages });\n`,
      SHIPPED,
      'examples/chat.ts',
    );
    expect(inSample.map((f) => [f.tier, f.position])).toEqual([['B', 'surface_capped']]);
  });

  it('is listed once per call site in the held stream fix-llm reports', () => {
    const p = project(
      `${OPENAI}export const run = (messages: any[]) => client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc', messages });\n`,
    );
    const held = toHeldCallMatches(findModelIdLiterals(p, SHIPPED));
    expect(held.map((m) => [m.value, m.deprecation.entryId])).toEqual([
      ['ft:gpt-3.5-turbo-0125:acme::9abc', 'openai.ft-gpt-3.5-turbo.retirement-2026-10-23'],
    ]);
  });
});

describe('a fine-tuned model id in a data position', { timeout: 60_000 }, () => {
  it('stays data, as a plain id would: a picker list, a lookup key, a comparison', () => {
    const found = scan(
      "export const PICKER = ['ft:gpt-4-0613:acme::abc123'];\n" +
        "export const PRICES: Record<string, number> = { 'ft:gpt-4-0613:acme::abc123': 3 };\n" +
        "export const isFt = (m: string) => m === 'ft:babbage-002:acme::9abc';\n",
    );
    expect(found.map((f) => [f.row, f.tier, f.purpose])).toEqual([
      ['ft-gpt-4', 'C', 'list_entry'],
      ['ft-gpt-4', 'C', 'lookup_key'],
      ['ft-babbage-002', 'C', 'comparison'],
    ]);
  });
});

describe('strings that are not a whole fine-tuned model id', { timeout: 60_000 }, () => {
  it('never match, in the positions where a fine-tune id would be held', () => {
    const lines = [
      "const base = 'gpt-4-0613';",
      'export async function run(messages: any[]) {',
      // Text around the id, a missing organisation or job id, another prefix, a family the
      // ft-gpt-4 row does not cover, and a base model the registry does not list.
      "  await client.chat.completions.create({ model: 'see ft:gpt-3.5-turbo-0125:acme::9abc', messages });",
      "  await client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125', messages });",
      "  await client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::', messages });",
      "  await client.chat.completions.create({ model: 'draft:gpt-4-0613:acme::abc', messages });",
      "  await client.chat.completions.create({ model: 'ft:gpt-4o:acme::abc', messages });",
      "  await client.chat.completions.create({ model: 'ft:gpt-4o-2024-08-06:acme::abc', messages });",
      // An interpolated template is not a fixed value, a log line is not an id, a comment is not a literal.
      '  await client.chat.completions.create({ model: `ft:${base}:acme::abc`, messages });',
      "  console.log('fine-tuned via ft:gpt-4-0613:acme::abc123 last week');",
      '  // model: ft:gpt-4-0613:acme::abc123',
      '}',
      '',
    ];
    const found = scan(OPENAI + lines.join('\n'));
    // Only the plain `base` const is a registry id here, and it is not a fine-tune.
    expect(found.map((f) => f.value)).toEqual(['gpt-4-0613']);
    expect(found.every((f) => f.fineTuneOf === undefined)).toBe(true);
  });

  it('match nothing when the registry has neither an ft- row nor the base model', () => {
    const unrelated: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0314', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: withheldVerification('unverified') },
    ];
    const found = scan(
      `${OPENAI}export const run = (messages: any[]) => client.chat.completions.create({ model: 'ft:gpt-4-0613:acme::abc123', messages });\n`,
      unrelated,
    );
    expect(found).toEqual([]);
  });
});
