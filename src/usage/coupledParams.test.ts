import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import { findModelIdLiterals } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { TS_COUPLED_PARAM_REASON } from './coupledParams.js';

// REGRESSION CASE: recommended_replacement_requires_coupled_parameter_migration
//
// Found 2026-09-29 while preparing a one-line fix for a real call site in a public
// repository (LibreChat, api/server/services/Endpoints/assistants/title.js:25):
//
//   openai.chat.completions.create({
//     model: 'gpt-3.5-turbo',
//     messages: [...],
//     temperature: 0.7,
//     max_tokens: 20,
//   })
//
// OpenAI's deprecations page maps `gpt-3.5-turbo` -> `gpt-5.6-terra`. That replacement is a
// reasoning model, and reasoning models reject BOTH of the remaining parameters:
//
//   * `max_tokens`  -> must become `max_completion_tokens`. The registry HAS this rule
//                      (kind: param_rename, on_models includes gpt-5.6), and the fix pass
//                      applies it correctly because it runs AFTER the model-id swap.
//   * `temperature` -> rejected outright: "Unsupported value: 'temperature' does not support
//                      0.7 with this model. Only the default (1) value is supported."
//                      The registry has NO rule for this: its three param_removal entries
//                      are all Anthropic Opus. So nothing touched it.
//
// The result, reproduced before this guard existed: `Decision: PATCH ELIGIBLE`, tier A,
// "safe automatic patch", and a diff that swapped the id, renamed max_tokens, and LEFT
// `temperature: 0.7` in place — a call that still fails at runtime. It escaped only because
// the fixture had no `openai` package so the type-check gate went inconclusive. In a real
// checkout that gate passes (a model id is just a string to tsc) and Mendr applies it.
//
// THE INVARIANT: a model-id replacement is not safe until coupled parameters and behavioural
// compatibility are validated. Where no authoritative migration rule exists for a parameter
// the replacement's family is known to constrain, the finding must REQUIRE REVIEW rather than
// produce an automatic patch. Absence of a rule is not evidence of compatibility.

const REG: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-3.5-turbo',
    replacement: 'gpt-5.6-terra',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0613',
    replacement: 'gpt-4o-mini',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    verification: autoApplyVerification(),
  },
  // The one authoritative parameter rule that exists for this family. Its `on_models` is
  // what tells us the family HAS parameter constraints at all.
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1', 'o3', 'o4', 'gpt-5', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4'],
  },
];

function scan(source: string, file = 'src/title.ts') {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(file, source);
  return findModelIdLiterals(project, REG);
}

function verdict(source: string, value: string, file = 'src/title.ts') {
  const m = scan(source, file).find((x) => x.value === value);
  if (!m) return undefined;
  return {
    ...classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }),
    position: m.position,
    reason: m.reason,
  };
}

/** The real LibreChat shape, reduced to the four keys that decide the verdict. */
const LIBRECHAT = [
  "import OpenAI from 'openai';",
  'const openai = new OpenAI();',
  'export async function generateTitle(p: string) {',
  '  return openai.chat.completions.create({',
  "    model: 'gpt-3.5-turbo',",
  "    messages: [{ role: 'user', content: p }],",
  '    temperature: 0.7,',
  '    max_tokens: 20,',
  '  });',
  '}',
].join('\n');

describe('recommended_replacement_requires_coupled_parameter_migration', () => {
  it('does NOT call the swap safe when the replacement rejects a parameter no rule covers', () => {
    const v = verdict(LIBRECHAT, 'gpt-3.5-turbo');
    // The whole point: not tier A, not patch-eligible, not "safe automatic patch".
    expect(v?.tier).toBe('B');
    expect(v?.position).toBe('surface_capped');
  });

  it('names the offending parameter, so the reviewer knows what to check', () => {
    const v = verdict(LIBRECHAT, 'gpt-3.5-turbo');
    expect(v?.reason).toBe(TS_COUPLED_PARAM_REASON('gpt-5.6-terra', ['temperature']));
    // Plain-language rule: the reason is a sentence that names the parameter and points at it.
    expect(v?.reason).toContain('temperature');
    expect(v?.reason).toContain('gpt-5.6-terra');
  });

  it('a parameter the registry DOES cover is not a blocker — max_tokens alone stays tier A', () => {
    // `max_tokens` has an authoritative rename rule for this family, and the fix pass applies
    // it after the swap. A covered parameter must not downgrade the finding, or the guard
    // would make every reasoning-model migration manual and the product useless.
    const src = LIBRECHAT.replace('    temperature: 0.7,\n', '');
    const v = verdict(src, 'gpt-3.5-turbo');
    expect(v?.tier).toBe('A');
  });

  it('a replacement whose family has no parameter constraints is untouched', () => {
    // gpt-4o-mini matches no param rule's on_models, so nothing about it is known to be
    // constrained and `temperature` is a normal, supported argument. This is the case that
    // keeps the guard narrow: it must not fire on every call site that sets temperature.
    const src = LIBRECHAT.replace("'gpt-3.5-turbo'", "'gpt-4-0613'");
    const v = verdict(src, 'gpt-4-0613');
    expect(v?.tier).toBe('A');
  });

  it('the guard is about the REPLACEMENT, not the deprecated id', () => {
    // `gpt-3.5-turbo` itself accepts temperature perfectly well. The incompatibility belongs
    // to what Mendr proposes to put there, which is why this cannot be judged from the
    // literal alone and is why the check lives next to the deprecation record.
    const withoutParams = [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function t(p: string) {',
      "  return openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [] });",
      '}',
    ].join('\n');
    expect(verdict(withoutParams, 'gpt-3.5-turbo')?.tier).toBe('A');
  });
});
