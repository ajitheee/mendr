import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
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

// REGRESSION (review of PR #50, 2026-10-07): the parameter guards ran only on a literal that was
// the DIRECT value of `model:`. The same id read through a const, a `{ model }` shorthand or an
// `as string` cast skipped both checks and was swapped unattended, while the inline twin was held:
// `const model = 'gpt-4-0613'; create({ model, max_tokens: 13 })` became `'gpt-5.6-sol'` with
// `max_tokens` still on it, which the bundled rule says gpt-5.6 rejects.
describe('an id read through a const, a shorthand or a cast is held exactly as its inline twin is', () => {
  const HEAD = ["import OpenAI from 'openai';", 'const openai = new OpenAI();'];
  /** One call, written with `model` as given and `params` beside it. */
  const call = (model: string, params: string, before: string[] = []) =>
    [
      ...HEAD,
      'export async function title() {',
      ...before.map((l) => `  ${l}`),
      `  return openai.chat.completions.create({ ${model}, ${params}, messages: [] });`,
      '}',
    ].join('\n');
  const inlineTwin = (params: string) => verdict(call("model: 'gpt-3.5-turbo'", params), 'gpt-3.5-turbo');

  const shapes: Array<[string, (params: string) => string]> = [
    ['a shorthand `{ model }`', (p) => call('model', p, ["const model = 'gpt-3.5-turbo';"])],
    [
      'a module-level const',
      (p) =>
        [
          ...HEAD,
          "const TITLE_MODEL = 'gpt-3.5-turbo';",
          'export async function title() {',
          `  return openai.chat.completions.create({ model: TITLE_MODEL, ${p}, messages: [] });`,
          '}',
        ].join('\n'),
    ],
    ['a const read behind `as string`', (p) => call('model: TITLE_MODEL as string', p, ["const TITLE_MODEL = 'gpt-3.5-turbo' as const;"])],
    ['a const read behind `!`', (p) => call('model: TITLE_MODEL!', p, ["const TITLE_MODEL = 'gpt-3.5-turbo';"])],
    ['an assignment `model = …`', (p) => call('model', p, ['let model: string;', "model = 'gpt-3.5-turbo';"])],
    [
      'a class property read as `this.model`',
      (p) =>
        [
          ...HEAD,
          'export class Titles {',
          "  model = 'gpt-3.5-turbo';",
          '  async title() {',
          `    return openai.chat.completions.create({ model: this.model, ${p}, messages: [] });`,
          '  }',
          '}',
        ].join('\n'),
    ],
    [
      'a constructor assignment `this.model = …` read as `this.model`',
      (p) =>
        [
          ...HEAD,
          'export class Titles {',
          '  private model: string;',
          "  constructor() { this.model = 'gpt-3.5-turbo'; }",
          '  async title() {',
          `    return openai.chat.completions.create({ model: this.model, ${p}, messages: [] });`,
          '  }',
          '}',
        ].join('\n'),
    ],
    ['an `as string` cast', (p) => call("model: 'gpt-3.5-turbo' as string", p)],
    ['parentheses', (p) => call("model: ('gpt-3.5-turbo')", p)],
    ['quoted keys', (p) => call('"model": "gpt-3.5-turbo"', p.replace(/(\w+):/g, '"$1":'))],
    ['computed string keys `["max_tokens"]`', (p) => call("model: 'gpt-3.5-turbo'", p.replace(/(\w+):/g, '["$1"]:'))],
  ];

  for (const [name, shape] of shapes) {
    it(`${name}: a rule that starts at the replacement holds it, with the twin's sentence`, () => {
      const twin = inlineTwin('max_tokens: 20');
      expect(twin?.reason).toContain('changes what this call asks for'); // the twin is held
      const v = verdict(shape('max_tokens: 20'), 'gpt-3.5-turbo');
      expect(v).toEqual(twin);
      expect(v?.tier).toBe('B');
    });

    it(`${name}: a parameter no rule covers holds it, with the twin's sentence`, () => {
      const twin = inlineTwin('temperature: 0.7, max_tokens: 20');
      expect(twin?.reason).toBe(TS_COUPLED_PARAM_REASON('gpt-5.6-terra', ['temperature']));
      expect(verdict(shape('temperature: 0.7, max_tokens: 20'), 'gpt-3.5-turbo')).toEqual(twin);
    });

    it(`${name}: no model-dependent parameter leaves it Tier A, like the twin`, () => {
      expect(inlineTwin('stream: false')?.tier).toBe('A');
      expect(verdict(shape('stream: false'), 'gpt-3.5-turbo')?.tier).toBe('A');
    });
  }

  const DECL = [...HEAD, "const TITLE_MODEL = 'gpt-3.5-turbo';"];

  it('a const consumed only by calls with no model-dependent parameter stays Tier A', () => {
    const src = [
      ...DECL,
      'export const a = async () => openai.chat.completions.create({ model: TITLE_MODEL, messages: [] });',
      'export const b = async () => openai.chat.completions.create({ model: TITLE_MODEL, messages: [], stream: true });',
    ].join('\n');
    expect(verdict(src, 'gpt-3.5-turbo')).toMatchObject({ tier: 'A', position: 'model_arg' });
  });

  it('a const consumed by one held call and one free call is held, with the held call\'s sentence', () => {
    const src = [
      ...DECL,
      'export const free = async () => openai.chat.completions.create({ model: TITLE_MODEL, messages: [] });',
      'export const held = async () => openai.chat.completions.create({ model: TITLE_MODEL, max_tokens: 20, messages: [] });',
    ].join('\n');
    expect(verdict(src, 'gpt-3.5-turbo')).toEqual(inlineTwin('max_tokens: 20'));
  });

  it('a parameter no rule covers wins over a behaviour change, whichever consumer comes first', () => {
    const src = [
      ...DECL,
      'export const a = async () => openai.chat.completions.create({ model: TITLE_MODEL, max_tokens: 20, messages: [] });',
      'export const b = async () => openai.chat.completions.create({ model: TITLE_MODEL, top_p: 0.5, messages: [] });',
    ].join('\n');
    expect(verdict(src, 'gpt-3.5-turbo')?.reason).toBe(TS_COUPLED_PARAM_REASON('gpt-5.6-terra', ['top_p']));
  });

  it('reads the request that carries the const, not another object argument of the same call', () => {
    for (const other of ["{ model: 'x', max_tokens: 20 }", '{ fallbackModel, max_tokens: 20 }']) {
      const src = [
        ...DECL,
        `export const a = async (fallbackModel: string) => openai.chat.completions.create({ model: TITLE_MODEL, messages: [] }, ${other});`,
      ].join('\n');
      expect(verdict(src, 'gpt-3.5-turbo'), other).toMatchObject({ tier: 'A', position: 'model_arg' });
    }
  });

  it('a call that cannot see the declaration does not hold it', () => {
    // `model` in b() is b's own parameter, not the const in a(): the sink rule's scope applies.
    const src = [
      ...HEAD,
      'export async function a() {',
      "  const model = 'gpt-3.5-turbo';",
      '  return openai.chat.completions.create({ model, messages: [] });',
      '}',
      'export async function b(model: string) {',
      '  return openai.chat.completions.create({ model, max_tokens: 20, messages: [] });',
      '}',
    ].join('\n');
    expect(verdict(src, 'gpt-3.5-turbo')).toMatchObject({ tier: 'A', position: 'model_arg' });
  });

  it('a fallback is judged the same way inline and through a const (neither form is widened here)', () => {
    const inline = verdict(call("model: process.env.M || 'gpt-3.5-turbo'", 'max_tokens: 20'), 'gpt-3.5-turbo');
    const viaConst = verdict(
      call('model: TITLE_MODEL', 'max_tokens: 20', ["const TITLE_MODEL = process.env.M || 'gpt-3.5-turbo';"]),
      'gpt-3.5-turbo',
    );
    const viaConsumer = verdict(
      call('model: process.env.M || TITLE_MODEL', 'max_tokens: 20', ["const TITLE_MODEL = 'gpt-3.5-turbo';"]),
      'gpt-3.5-turbo',
    );
    expect(viaConst?.tier).toBe(inline?.tier);
    expect(viaConsumer?.tier).toBe(inline?.tier);
  });
});

// REGRESSION (review of 402c1e4, 2026-10-07): the sink map files a consumer by NAME, and the
// parameter check read the keys of every consumer filed under the declaration's name. A call whose
// `model` is a different binding — a parameter, a local, another member — held the declaration for
// ITS `max_tokens`, and the report said the declaration "changes what this call asks for" about a
// call that never reads it. Each control below was Tier A on 0df2dce and Tier B on 402c1e4.
describe('a same-named binding that is not the declaration does not hold it', () => {
  const HEAD = ["import OpenAI from 'openai';", 'const openai = new OpenAI();'];
  const create = (args: string) => `openai.chat.completions.create({ ${args}, messages: [] })`;
  const fn = (name: string, params: string, body: string[]) => [`export async function ${name}(${params}) {`, ...body.map((l) => `  ${l}`), '}'];
  const twin = () => verdict([...HEAD, ...fn('t', '', [`return ${create("model: 'gpt-3.5-turbo', max_tokens: 5")};`])].join('\n'), 'gpt-3.5-turbo');
  const FREE = fn('usesConst', '', [`return ${create('model')};`]);

  const controls: Array<[string, string[]]> = [
    ['a parameter of the same name', ["const model = 'gpt-3.5-turbo';", ...FREE, ...fn('usesParam', 'model: string', [`return ${create('model, max_tokens: 5')};`])]],
    [
      'a local const of the same name in another function',
      [
        "const MODEL = 'gpt-3.5-turbo';",
        ...fn('usesConst', '', [`return ${create('model: MODEL')};`]),
        ...fn('usesLocal', '', ["const MODEL = 'gpt-4.1';", `return ${create('model: MODEL, max_tokens: 5')};`]),
      ],
    ],
    ['a local shorthand of the same name', ["const model = 'gpt-3.5-turbo';", ...FREE, ...fn('b', '', ["const model = 'gpt-4.1';", `return ${create('model, max_tokens: 5')};`])]],
    ['a destructured parameter', ["const model = 'gpt-3.5-turbo';", ...FREE, ...fn('ask', '{ model }: { model: string }', [`return ${create('model, max_tokens: 5')};`])]],
    ['a local destructured from something else', ["const model = 'gpt-3.5-turbo';", ...FREE, ...fn('ask', 'opts: { model: string }', ['const { model } = opts;', `return ${create('model: model, max_tokens: 5')};`])]],
    [
      'a nested arrow with its own parameter, called with another model',
      fn('a', '', [
        "const model = 'gpt-3.5-turbo';",
        `await ${create('model')};`,
        `const inner = async (model: string) => ${create('model, max_tokens: 5')};`,
        "return inner('gpt-4.1');",
      ]),
    ],
    [
      'a parameter property `this.model` of another class',
      ["const model = 'gpt-3.5-turbo';", ...FREE, 'export class Other {', '  constructor(private model: string) {}', `  async ask() { return ${create('model: this.model, max_tokens: 5')}; }`, '}'],
    ],
    [
      'a method parameter beside a class property',
      ['export class Bot {', "  model = 'gpt-3.5-turbo';", `  async ask() { return ${create('model: this.model')}; }`, `  async other(model: string) { return ${create('model, max_tokens: 5')}; }`, '}'],
    ],
    [
      'a parameter of the same name beside an assignment `model = …`',
      ['let model: string;', "model = 'gpt-3.5-turbo';", ...FREE, ...fn('usesParam', 'model: string', [`return ${create('model, max_tokens: 5')};`])],
    ],
    [
      'a method local beside a class property',
      ['export class Bot {', "  private readonly model = 'gpt-3.5-turbo';", `  async ask() { return ${create('model: this.model')}; }`, "  async summarize() { const model = 'gpt-4.1'; return " + create('model, max_tokens: 200') + '; }', '}'],
    ],
  ];
  for (const [name, body] of controls) {
    it(`${name}: stays Tier A`, () => {
      expect(twin()?.tier).toBe('B');
      expect(verdict([...HEAD, ...body].join('\n'), 'gpt-3.5-turbo')).toMatchObject({ tier: 'A', position: 'model_arg' });
    });
  }

  // A binding that is FED the declaration still reads it, and still holds it like the inline twin.
  const keeps: Array<[string, string[]]> = [
    ['a parameter defaulting to `this.model`', ['export class Bot {', "  model = 'gpt-3.5-turbo';", `  async chat(model = this.model) { return ${create('model, max_tokens: 5')}; }`, '}']],
    ['a local destructured from `this`', ['export class Bot {', "  model = 'gpt-3.5-turbo';", '  async ask() {', '    const { model } = this;', `    return ${create('model, max_tokens: 5')};`, '  }', '}']],
    ['a parameter passed the const at a call in the file', ["const model = 'gpt-3.5-turbo';", ...fn('ask', 'model: string', [`return ${create('model, max_tokens: 5')};`]), 'export const go = () => ask(model);']],
    [
      'a constructor parameter property passed the const',
      ["const model = 'gpt-3.5-turbo';", 'export class Bot {', '  constructor(private model: string) {}', `  async ask() { return ${create('model: this.model, max_tokens: 5')}; }`, '}', 'export const bot = new Bot(model);'],
    ],
    ['a class property initialised from the const', ["const model = 'gpt-3.5-turbo';", 'export class Bot {', '  model = model;', `  async ask() { return ${create('model: this.model, max_tokens: 5')}; }`, '}']],
    ['a `this.model` assigned the const', ["const model = 'gpt-3.5-turbo';", 'export class Bot {', '  model: string;', '  constructor() { this.model = model; }', `  async ask() { return ${create('model: this.model, max_tokens: 5')}; }`, '}']],
    ['a local initialised from `this.model`', ['export class Bot {', "  model = 'gpt-3.5-turbo';", '  async ask() {', '    const model = this.model ?? "x";', `    return ${create('model, max_tokens: 5')};`, '  }', '}']],
    ['a closure over the const', fn('a', '', ["const model = 'gpt-3.5-turbo';", `const run = async () => ${create('model, max_tokens: 5')};`, 'return run();'])],
    ['an unresolved name in a class method', ['export class Bot {', "  model = 'gpt-3.5-turbo';", `  async ask() { return ${create('model, max_tokens: 5')}; }`, '}']],
  ];
  for (const [name, body] of keeps) {
    it(`${name}: is held with the inline twin's sentence`, () => {
      expect(verdict([...HEAD, ...body].join('\n'), 'gpt-3.5-turbo')).toEqual(twin());
    });
  }

  it('a consumer that cannot be ruled out keeps the hold even beside one that is ruled out', () => {
    // b's `model` is its own parameter (ruled out); c reads the const (kept). Any kept consumer holds.
    const src = [
      ...HEAD,
      "const model = 'gpt-3.5-turbo';",
      ...fn('b', 'model: string', [`return ${create('model, max_tokens: 5')};`]),
      ...fn('c', '', [`return ${create('model, max_tokens: 5')};`]),
    ].join('\n');
    expect(verdict(src, 'gpt-3.5-turbo')).toEqual(twin());
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
