import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmParamDeprecation } from '../types.js';
import { applyParamFixes } from '../fix/paramFix.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { loadLlmRegistry, modelMatches, paramEntries, resolveRegistryPath } from '../usage/llmRegistry.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { checkRules } from './checkRules.js';
import { resolveEvidenceDir } from './evidence.js';

// Anthropic's sampling-parameter rules, read from the SHIPPED registry.
//
// Until 2026-10-10 the three rules (temperature, top_p, top_k) named only Claude Opus 4.7, 4.8 and
// 5. Anthropic's pages say more models reject a non-default value: Claude Sonnet 5.5 (the
// replacement for claude-sonnet-4-5-20250929, retiring 2026-11-30), Claude Sonnet 5, Claude Haiku
// 5.5, Claude Fable 5 and 5.1, and "Claude 4.7 and later models and Claude Mythos Preview" on the
// deprecations page. A call on one of them that passes `temperature: 0.7` fails with a 400, and
// mendr said nothing about it.

const registry = loadLlmRegistry(resolveRegistryPath());
const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;

function rule(param: string): LlmParamDeprecation {
  const found = paramEntries(registry).find(
    (e) => e.provider === 'anthropic' && e.kind === 'param_removal' && e.param === param,
  );
  if (!found) throw new Error(`the shipped registry has no Anthropic removal rule for ${param}`);
  return found;
}

describe('the shipped Anthropic sampling rules', () => {
  // Every model Anthropic's own pages say rejects a non-default value, by API id.
  const REJECTING = [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5',
    'claude-mythos-5-1',
    'claude-mythos-preview',
  ];
  // Models Anthropic says accept the parameters: Sonnet 4.6 and earlier, Haiku 4.5, Opus 4.6 and
  // earlier. A rule that matched one of them would delete a value the call relies on.
  const ACCEPTING = [
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022',
    'claude-opus-4-6',
    'claude-opus-4-5-20251101',
    'claude-opus-4-1-20250805',
  ];

  for (const param of SAMPLING) {
    it(`removes ${param} on every model Anthropic says rejects it, Sonnet 5.5 included`, () => {
      for (const model of REJECTING) expect(modelMatches(model, rule(param).on_models), model).toBe(true);
    });

    it(`leaves ${param} alone on every model Anthropic says accepts it`, () => {
      for (const model of ACCEPTING) expect(modelMatches(model, rule(param).on_models), model).toBe(false);
    });
  }

  it('does not reach a different model that merely shares a prefix', () => {
    // The matcher is an exact prefix on "-": claude-sonnet-5 covers claude-sonnet-5-5, never a
    // hypothetical claude-sonnet-50; claude-opus-4-7 never reaches claude-opus-4-70.
    for (const param of SAMPLING) {
      for (const model of ['claude-sonnet-50', 'claude-opus-4-70', 'claude-haiku-5', 'claude-fable-50']) {
        expect(modelMatches(model, rule(param).on_models), `${param} on ${model}`).toBe(false);
      }
    }
  });

  it("quotes Anthropic's Sonnet 5.5 sentence in every rule", () => {
    for (const param of SAMPLING) {
      expect(rule(param).quotes, param).toContainEqual({
        sourceUrl: 'https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide',
        text: 'Claude Sonnet 4.6 and earlier models and Claude Haiku 4.5 accept temperature, top_p, and top_k. On Claude Sonnet 5.5, a non-default value returns a 400 error.',
        about: 'rule',
      });
    }
  });

  it('finds every quoted Anthropic sentence on the snapshot committed for its page', () => {
    // The same literal check `mendr check-rules` runs weekly against the live pages, run here
    // against the pages as read on 2026-10-10 and stored under registries/evidence/.
    const SNAPSHOTS: Record<string, string> = {
      'https://platform.claude.com/docs/en/models/opus-5-5/migration-guide': 'f8f3a36596fc',
      'https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide': 'aaec231645b4',
      'https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide': '3943c8fac68c',
      'https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1': '389c748904e6',
      'https://platform.claude.com/docs/en/about-claude/model-deprecations': 'd884c96e3dd2',
    };
    const pages = new Map(
      Object.entries(SNAPSHOTS).map(([url, name]) => [url, readFileSync(join(resolveEvidenceDir(), `${name}.txt`), 'utf8')]),
    );
    const anthropic = checkRules(registry, pages).filter((r) => r.rule.startsWith('anthropic.'));
    expect(anthropic.map((r) => r.rule).sort()).toEqual([
      'anthropic.param_removal.temperature',
      'anthropic.param_removal.top_k',
      'anthropic.param_removal.top_p',
    ]);
    for (const r of anthropic) {
      expect(r.unquoted, r.rule).toBe(false);
      for (const q of r.quotes) expect(q.verdict, `${r.rule}: ${q.text}`).toBe('confirmed');
    }
  });
});

function project(source: string, file = 'src/anthropic.ts'): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(file, source);
  return p;
}

const SOURCE = [
  "import Anthropic from '@anthropic-ai/sdk';",
  'const anthropic = new Anthropic();',
  'export async function run(messages: any) {',
  "  const a = await anthropic.messages.create({ model: 'claude-sonnet-5-5', temperature: 0.7, max_tokens: 1024, messages });",
  "  const b = await anthropic.messages.create({ model: 'claude-sonnet-4-6', temperature: 0.7, max_tokens: 1024, messages });",
  "  const c = await anthropic.messages.create({ model: 'claude-haiku-5-5', top_k: 40, max_tokens: 1024, messages });",
  "  const d = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', top_k: 40, max_tokens: 1024, messages });",
  '  return [a, b, c, d];',
  '}',
].join('\n');

describe('the parameter pass with the shipped registry', () => {
  it('drops temperature from a Claude Sonnet 5.5 call and top_k from a Claude Haiku 5.5 call', () => {
    const p = project(SOURCE);
    const edits = applyParamFixes(p, registry);
    expect(edits).toEqual(
      expect.arrayContaining([
        { kind: 'param_removal', param: 'temperature', model: 'claude-sonnet-5-5' },
        { kind: 'param_removal', param: 'top_k', model: 'claude-haiku-5-5' },
      ]),
    );
    const text = p.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    expect(text).toContain("{ model: 'claude-sonnet-5-5', max_tokens: 1024, messages }");
    expect(text).toContain("{ model: 'claude-haiku-5-5', max_tokens: 1024, messages }");
  });

  it('keeps temperature on Claude Sonnet 4.6 and top_k on Claude Haiku 4.5, which accept them', () => {
    const p = project(SOURCE);
    const edits = applyParamFixes(p, registry);
    expect(edits.map((e) => e.model)).not.toContain('claude-sonnet-4-6');
    expect(edits.map((e) => e.model)).not.toContain('claude-haiku-4-5-20251001');
    const text = p.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    expect(text).toContain("{ model: 'claude-sonnet-4-6', temperature: 0.7, max_tokens: 1024, messages }");
    expect(text).toContain("{ model: 'claude-haiku-4-5-20251001', top_k: 40, max_tokens: 1024, messages }");
  });
});

describe('the swap guard with the shipped registry', () => {
  function tierOf(model: string) {
    const source = [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function run(messages: any) {',
      `  return anthropic.messages.create({ model: '${model}', temperature: 0.7, max_tokens: 1024, messages });`,
      '}',
    ].join('\n');
    const matches = findModelIdLiterals(project(source), registry).filter((m) => m.value === model);
    expect(matches, model).toHaveLength(1);
    const [m] = matches;
    return classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
  }

  it('holds a Sonnet 4.5 call that passes temperature, whose replacement Sonnet 5.5 rejects it', () => {
    expect(tierOf('claude-sonnet-4-5-20250929').tier).toBe('B');
  });

  it('still patches a retired Sonnet 3.7 call that passes temperature: its replacement, Sonnet 4.6, accepts it', () => {
    // The rules grew; their reach into migrations must not. claude-3-7-sonnet-20250219 migrates
    // to claude-sonnet-4-6, which no sampling rule names, so the call stays a Tier A swap.
    expect(tierOf('claude-3-7-sonnet-20250219')).toEqual({ tier: 'A' });
  });
});
