import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, loadLlmRegistry, resolveRegistryPath } from './llmRegistry.js';
import { findModelIdLiterals } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import {
  isCoupledParamReason,
  isParamBehaviourReason,
  paramRulesStartingAt,
  TS_COUPLED_PARAM_REASON,
  TS_PARAM_BEHAVIOUR_REASON,
} from './coupledParams.js';

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

  it('max_tokens alone, carried onto a reasoning model, goes to review: the rule changes what the number means', () => {
    // REVERSED 2026-10-05. This test used to pin tier A ("a covered parameter must not
    // downgrade the finding, or ... every reasoning-model migration [goes] manual"). The rename
    // keeps the request VALID, but OpenAI defines max_completion_tokens as "An upper bound for
    // the number of tokens that can be generated for a completion, including visible output
    // tokens and reasoning tokens": LibreChat's `max_tokens: 20` title call, moved onto
    // gpt-5.6-terra, can come back empty, and tests that mock the API cannot see it. That is an
    // incorrect verified edit in waiting. The edit is still written; a person sets the value.
    const src = LIBRECHAT.replace('    temperature: 0.7,\n', '');
    const v = verdict(src, 'gpt-3.5-turbo');
    expect(v?.tier).toBe('B');
    expect(v?.reason).toContain('changes what this call asks for');
    expect(v?.reason).toContain('`max_tokens` becomes `max_completion_tokens`');
  });

  it('a covered parameter on a source already in the rule\'s family stays tier A: the rename means the same thing', () => {
    // o-series already counted reasoning tokens against the limit, so nothing about the
    // request changes when it moves to another reasoning model.
    const reg: LlmRegistry = [
      ...REG,
      { provider: 'openai', kind: 'model_id', deprecated: 'o1', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
    ];
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'src/r.ts',
      "import OpenAI from 'openai';\nconst o = new OpenAI();\nexport const r = () => o.chat.completions.create({ model: 'o1', messages: [], max_tokens: 500 });\n",
    );
    const m = findModelIdLiterals(project, reg).find((x) => x.value === 'o1')!;
    expect(classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier).toBe('A');
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

// paramRulesStartingAt: the rules a swap STARTS applying, for parameters the call passes.
describe('paramRulesStartingAt', () => {
  const rename = REG[2] as Extract<LlmRegistry[number], { kind: 'param_rename' }>;
  const quoted: LlmRegistry = [
    {
      ...rename,
      quotes: [
        { sourceUrl: 'https://example.test/ref', text: 'not compatible with o-series models.', about: 'rule' },
        { sourceUrl: 'https://example.test/ref', text: 'including visible output tokens and reasoning tokens.', about: 'behaviour' },
      ],
    },
  ];

  it('returns the rule a swap crosses into, when the call passes its parameter', () => {
    expect(paramRulesStartingAt(['max_tokens'], 'openai', 'gpt-3.5-turbo', 'gpt-5.6-terra', REG)).toEqual([rename]);
  });

  it('returns nothing when the source was already covered by the same rule', () => {
    expect(paramRulesStartingAt(['max_tokens'], 'openai', 'o1', 'gpt-5.6-sol', REG)).toEqual([]);
  });

  it('returns nothing when the call does not pass the parameter', () => {
    expect(paramRulesStartingAt(['messages'], 'openai', 'gpt-3.5-turbo', 'gpt-5.6-terra', REG)).toEqual([]);
  });

  it("returns nothing for another provider's rule", () => {
    expect(paramRulesStartingAt(['max_tokens'], 'anthropic', 'claude-3-opus', 'gpt-5.6-terra', REG)).toEqual([]);
  });

  it("quotes the rule's behaviour sentence in the review reason, and is not mistaken for the uncovered-parameter case", () => {
    const reason = TS_PARAM_BEHAVIOUR_REASON('gpt-3.5-turbo', 'gpt-5.6-terra', quoted as never);
    expect(reason).toContain('moving from gpt-3.5-turbo to gpt-5.6-terra changes what this call asks for');
    expect(reason).toContain('including visible output tokens and reasoning tokens.');
    expect(isParamBehaviourReason(reason)).toBe(true);
    expect(isCoupledParamReason(reason)).toBe(false);
    expect(isParamBehaviourReason(TS_COUPLED_PARAM_REASON('gpt-5.6-terra', ['temperature']))).toBe(false);
  });

  it('classifies as its own Tier B reason, so the report does not say "no migration rule covers it"', () => {
    const reason = TS_PARAM_BEHAVIOUR_REASON('gpt-3.5-turbo', 'gpt-5.6-terra', [rename]);
    const t = classifyOccurrenceTier({ position: 'surface_capped', deprecation: REG[0] as never, reason });
    expect(t).toEqual({ tier: 'B', reason: 'param_behaviour_change' });
  });
});

// prompt_cache_retention. OpenAI's latest-model guide (read 2026-10-10, snapshot 14d2ce97ad60)
// tells a GPT-5.6 migration to "replace prompt_cache_retention with prompt_cache_options.ttl".
// No rule can make that edit, so a call that passes the field and would be swapped onto a
// constrained family is held, and nothing else changes.
describe('prompt_cache_retention on a swap', () => {
  const CODEX: LlmRegistry[number] = {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-5-codex',
    replacement: 'gpt-5.6-sol',
    status: 'deprecated',
    shutdownDate: '2026-07-23',
    verification: autoApplyVerification(),
  };
  const REG_CODEX: LlmRegistry = [...REG, CODEX];

  function codexVerdict(model: string, extra: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'src/codex.ts',
      [
        "import OpenAI from 'openai';",
        'const openai = new OpenAI();',
        'export async function run(input: string) {',
        `  return openai.responses.create({ model: '${model}', input${extra} });`,
        '}',
      ].join('\n'),
    );
    const m = findModelIdLiterals(project, REG_CODEX).find((x) => x.value === model);
    if (!m) return undefined;
    return { ...classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }), why: m.reason };
  }

  it('holds a call that passes it when the replacement is gpt-5.6, and names the field', () => {
    const v = codexVerdict('gpt-5-codex', ", prompt_cache_retention: '24h'");
    expect(v?.tier).toBe('B');
    expect(v?.reason).toBe('coupled_param_unverified');
    expect(v?.why).toBe(TS_COUPLED_PARAM_REASON('gpt-5.6-sol', ['prompt_cache_retention']));
  });

  it('still swaps the same call when it does not pass the field', () => {
    expect(codexVerdict('gpt-5-codex', '')?.tier).toBe('A');
  });

  it('says nothing when the replacement is in no constrained family', () => {
    // gpt-4-0613 -> gpt-4o-mini: no rule names gpt-4o, so nothing is known to change there.
    expect(codexVerdict('gpt-4-0613', ", prompt_cache_retention: '24h'")?.tier).toBe('A');
  });

  it('reports nothing for a current model that passes the field', () => {
    // The guard only qualifies a finding. A call on a model nobody is retiring is not one.
    expect(codexVerdict('gpt-5.6-sol', ", prompt_cache_retention: '24h'")).toBeUndefined();
  });

  it('holds the shipped codex records that pass it, and swaps none of them with the field kept', () => {
    // The shipped registry. gpt-5-codex -> gpt-5.6-sol is verified, so only the guard holds a
    // call that passes the field. gpt-5.3-codex -> gpt-6-sol is quarantined: no rule names the
    // GPT-6 family, so the guard cannot reach that swap and the record holds every call.
    const shipped = loadLlmRegistry(resolveRegistryPath());
    function shippedVerdict(model: string, extra: string) {
      const project = new Project({ useInMemoryFileSystem: true });
      project.createSourceFile(
        'src/codex.ts',
        [
          "import OpenAI from 'openai';",
          'const openai = new OpenAI();',
          `export const run = (input: string) => openai.responses.create({ model: '${model}', input${extra} });`,
        ].join('\n'),
      );
      const [m] = findModelIdLiterals(project, shipped).filter((x) => x.value === model);
      return classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
    }
    expect(shippedVerdict('gpt-5-codex', ", prompt_cache_retention: '24h'")).toEqual({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(shippedVerdict('gpt-5-codex', '')).toEqual({ tier: 'A' });
    expect(shippedVerdict('gpt-5.3-codex', ", prompt_cache_retention: '24h'")).toEqual({ tier: 'B', reason: 'replacement_unverified' });
  });
});
