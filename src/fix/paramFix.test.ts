import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { findParamSites, applyParamFixes, applyParamFixesToProject, withoutHeldCalls } from './paramFix.js';

// Hermetic tests for the MODEL-COUPLED param codemod. The Project is built
// in-memory from source strings and the registry is an inline literal, so there
// is no dependency on installed SDK types or the on-disk registry JSON.
//
// The single property under test is the whole point of the feature: a param is
// only transformed when the model RESOLVED AT ITS CALL SITE is in `on_models`.
// The precision showcase proves an accepting model KEEPS its temperature.

/** Anthropic removals (Opus 4.7+) + OpenAI reasoning-model rename. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'temperature',
    on_models: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'],
    note: 'temperature rejected on Opus 4.7+',
  },
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'top_p',
    on_models: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'],
    note: 'top_p rejected on Opus 4.7+',
  },
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1', 'o3', 'o4', 'gpt-5'],
    note: 'reasoning models require max_completion_tokens',
  },
];

function inMemoryProject(fileName: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('param_removal (temperature)', () => {
  // Both calls live in the SAME file: one on a rejecting model, one on an
  // accepting model that is NOT in on_models (and not a model_id retirement).
  const SOURCE = `
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
export async function run(messages: any) {
  const rejecting = await anthropic.messages.create({ model: "claude-opus-5", temperature: 0, max_tokens: 1024, messages });
  const accepting = await anthropic.messages.create({ model: "claude-3-haiku-20240307", temperature: 0, max_tokens: 1024, messages });
  return { rejecting, accepting };
}
`.trimStart();

  it('removes temperature on a rejecting model, keeping the other props', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    const edits = applyParamFixes(project, REGISTRY);

    // Exactly one removal fired: the rejecting-model call.
    expect(edits).toEqual([
      { kind: 'param_removal', param: 'temperature', model: 'claude-opus-5' },
    ]);

    const text = project.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    // Rejecting call: temperature gone, siblings intact.
    expect(text).toContain('{ model: "claude-opus-5", max_tokens: 1024, messages }');
  });

  it('PRECISION SHOWCASE: an accepting model KEEPS its temperature', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    applyParamFixes(project, REGISTRY);

    const text = project.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    // The accepting model is untouched — temperature stays exactly as written.
    expect(text).toContain(
      '{ model: "claude-3-haiku-20240307", temperature: 0, max_tokens: 1024, messages }',
    );
    // And there is still exactly ONE surviving `temperature:` in the file.
    expect(text.match(/temperature:/g)).toHaveLength(1);
  });

  it('locator only reports the rejecting-model site (coupling is in the locator)', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    const sites = findParamSites(project, REGISTRY);

    expect(sites).toHaveLength(1);
    expect(sites[0].model).toBe('claude-opus-5');
    expect(sites[0].deprecation.param).toBe('temperature');
  });
});

describe('param_rename (max_tokens -> max_completion_tokens)', () => {
  const SOURCE = `
import OpenAI from "openai";
const client = new OpenAI();
export async function run() {
  const reasoning = await client.chat.completions.create({ model: "o1-mini", max_tokens: 100 });
  const classic = await client.chat.completions.create({ model: "gpt-4o", max_tokens: 100 });
  return { reasoning, classic };
}
`.trimStart();

  it('renames the key on a reasoning model and keeps it on an accepting model', () => {
    const project = inMemoryProject('src/openai.ts', SOURCE);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toEqual([
      {
        kind: 'param_rename',
        param: 'max_tokens',
        replacement: 'max_completion_tokens',
        model: 'o1-mini',
      },
    ]);

    const text = project.getSourceFileOrThrow('src/openai.ts').getFullText();
    // o1-mini (matches "o1" by prefix): renamed, value preserved.
    expect(text).toContain('{ model: "o1-mini", max_completion_tokens: 100 }');
    // gpt-4o accepts max_tokens: kept verbatim.
    expect(text).toContain('{ model: "gpt-4o", max_tokens: 100 }');
  });
});

describe('withoutHeldCalls: a call held at review is never edited, and only a held call is skipped', { timeout: 30_000 }, () => {
  // The REAL scanner decides what is held, so these tests exercise the same verdicts fix-llm
  // and migrate act on. o3-mini is a retiring id here; the rename rule covers o3 and the
  // replacement alike, so a direct call on it is an ordinary swap (not held for its params).
  const HELD_REGISTRY: LlmRegistry = [
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'o3-mini',
      replacement: 'gpt-5.6-sol',
      verification: autoApplyVerification(),
    },
    {
      provider: 'openai',
      kind: 'param_rename',
      param: 'max_tokens',
      replacement: 'max_completion_tokens',
      on_models: ['o1', 'o3', 'gpt-5.6'],
    },
  ];
  const HEADER = [
    'import OpenAI from "openai";',
    'const client = new OpenAI();',
    'const proxy = new OpenAI({ baseURL: "https://llm-proxy.internal/v1" });',
  ].join('\n');

  /** The param sites the guard keeps, as `model:max_tokens value`, for one in-memory project. */
  function keptSites(project: Project, registry: LlmRegistry = HELD_REGISTRY): string[] {
    const held = findModelIdLiterals(project, registry).filter((m) => m.position === 'surface_capped');
    return withoutHeldCalls(findParamSites(project, registry), held).map(
      (s) => `${s.model}:${s.paramProp.getInitializer()?.getText()}`,
    );
  }

  // REGRESSION (review of PR #50, round two): a parameter in an object NESTED inside a held
  // call's request (a fallback list, an override block) was still renamed. The nested literal is
  // data to the scan, so only the request it sits in can say the call is held.
  it('skips the nested request objects of a held call, and keeps them in an ordinary call', () => {
    const nested = (receiver: string) => `${HEADER}
export async function run() {
  return ${receiver}.chat.completions.create({
    model: "o3-mini",
    max_tokens: 50,
    messages: [],
    fallbacks: [{ model: "o3-mini", max_tokens: 51 }],
    override: { model: "o3-mini", max_tokens: 52 },
  });
}
`;
    expect(keptSites(inMemoryProject('src/held.ts', nested('proxy')))).toEqual([]);
    expect(keptSites(inMemoryProject('src/plain.ts', nested('client'))).sort()).toEqual([
      'o3-mini:50',
      'o3-mini:51',
      'o3-mini:52',
    ]);
  });

  // REGRESSION (review of PR #50, round three): a nested request behind a ternary branch, a
  // logical operand or a type assertion was still renamed inside a held call.
  it('holds a nested request selected by a ternary, ||, ??, && or <T>, and keeps them in an ordinary call', () => {
    const selected = (receiver: string) => `${HEADER}
export async function run(allow: boolean, extra?: object) {
  return ${receiver}.chat.completions.create({
    model: "o3-mini",
    messages: [],
    a: allow ? [{ model: "o3-mini", max_tokens: 11 }] : undefined,
    b: extra || { model: "o3-mini", max_tokens: 12 },
    c: extra ?? { model: "o3-mini", max_tokens: 13 },
    d: allow && { model: "o3-mini", max_tokens: 14 },
    e: <object>{ model: "o3-mini", max_tokens: 15 },
    f: { ...{ g: [{ model: "o3-mini", max_tokens: 16 }] } },
  });
}
`;
    expect(keptSites(inMemoryProject('src/held.ts', selected('proxy')))).toEqual([]);
    expect(keptSites(inMemoryProject('src/plain.ts', selected('client'))).sort()).toEqual([
      'o3-mini:11',
      'o3-mini:12',
      'o3-mini:13',
      'o3-mini:14',
      'o3-mini:15',
      'o3-mini:16',
    ]);
  });

  it('holds everything written inside a held call\'s arguments, by position, whatever the shape', () => {
    // Indexing, a property read, a callback's return, a ternary's condition, a comparison: the
    // guard asks only WHERE the parameter is written. A rule that listed shapes missed a new one
    // in every review round of PR #50.
    const project = inMemoryProject(
      'src/anywhere.ts',
      `${HEADER}
export async function run(other: object, mode: "fast" | "slow", i: number) {
  return proxy.chat.completions.create({
    model: "o3-mini",
    messages: [],
    a: { fast: [{ model: "o1-mini", max_tokens: 31 }], slow: [] }[mode],
    b: [[{ model: "o1-mini", max_tokens: 32 }], []][i],
    c: ({ list: [{ model: "o1-mini", max_tokens: 33 }] }).list,
    d: () => ({ model: "o1-mini", max_tokens: 34 }),
    e: { model: "o1-mini", max_tokens: 35 } ? 1 : 2,
    f: { model: "o1-mini", max_tokens: 36 } === other,
  });
}
`,
    );
    expect(keptSites(project)).toEqual([]);
  });

  it('holds the nested requests of a call whose own model is an expression the scan sees through', () => {
    // The scan holds `opts.model || "o3-mini"`, `"o3-mini" as const` and a ternary of literals
    // at a proxy call; the guard has to find those literals too, not only a bare one.
    const project = inMemoryProject(
      'src/expr.ts',
      `${HEADER}
export async function run(opts: { model?: string }, fast: boolean) {
  await proxy.chat.completions.create({ model: opts.model || "o3-mini", messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 21 }] });
  await proxy.chat.completions.create({ model: "o3-mini" as const, messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 22 }] });
  await proxy.chat.completions.create({ model: fast ? "o3-mini" : "o4-mini", messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 23 }] });
  return client.chat.completions.create({ model: opts.model || "o3-mini", messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 24 }] });
}
`,
    );
    expect(keptSites(project)).toEqual(['o3-mini:24']);
  });

  it('holds every real request fed a gateway-prefixed const, and nothing fed a plain one', () => {
    const fed = (model: string) => `${HEADER}
const MODEL = "${model}";
export async function run() {
  return client.chat.completions.create({ model: MODEL, messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 5 }] });
}
`;
    expect(keptSites(inMemoryProject('src/gw.ts', fed('openai/o3-mini')))).toEqual([]);
    expect(keptSites(inMemoryProject('src/plain.ts', fed('o3-mini')))).toEqual(['o3-mini:5']);
  });

  it('keeps a standalone object fed a held const outside an example tree', () => {
    const registry: LlmRegistry = [
      ...HELD_REGISTRY,
      { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['o3'] },
    ];
    const project = inMemoryProject(
      'src/standalone.ts',
      `${HEADER}
const MODEL = "o3-mini";
export const settings = { model: MODEL, temperature: 0 };
export async function run() {
  return proxy.chat.completions.create({ model: MODEL, messages: [] });
}
`,
    );
    expect(keptSites(project, registry)).toEqual(['o3-mini:0']);
  });

  it('holds a call written inside a held call\'s arguments with it, and keeps the same call outside', () => {
    const project = inMemoryProject(
      'src/retry.ts',
      `${HEADER}
export async function run() {
  await proxy.chat.completions.create({
    model: "o3-mini",
    messages: [],
    onRetry: () => client.chat.completions.create({ model: "o1-mini", max_tokens: 2 }),
  });
  return client.chat.completions.create({ model: "o1-mini", max_tokens: 3 });
}
`,
    );
    expect(keptSites(project)).toEqual(['o1-mini:3']);
  });

  it('holds a wrapper class the scan holds, and not a catalog row or a const-fed wrapper it does not', () => {
    // max_tokens is itself a catalog sibling key, so this needs a rule on another parameter:
    // temperature, removed on o3 here. The scan holds `new Wrapper({ model: "…" })` (wrapper
    // constructor) but does not count a `new` as a consumer of a const, so a const-fed wrapper
    // is not a held call, and audit does not list it as one either.
    const registry: LlmRegistry = [
      ...HELD_REGISTRY,
      { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['o3'] },
    ];
    const project = inMemoryProject(
      'src/wrap.ts',
      `${HEADER}
declare class Wrapper { constructor(o: object); }
const MODEL = "o3-mini";
export async function run() {
  await proxy.chat.completions.create({ model: MODEL, messages: [] });
  const held = new Wrapper({ model: "o3-mini", temperature: 0 });
  const card = new Wrapper({ model: "o3-mini", temperature: 1, label: "o3 mini" });
  const fedByConst = new Wrapper({ model: MODEL, temperature: 2 });
  return { held, card, fedByConst };
}
`,
    );
    expect(keptSites(project, registry).sort()).toEqual(['o3-mini:1', 'o3-mini:2']);
  });

  // REGRESSION (review of PR #50, round four): the guard re-derived "held" from how the model was
  // written and missed these spellings; the scan resolves all of them to the call it holds.
  it('holds a held call\'s nested requests however its model is spelled', () => {
    const project = inMemoryProject(
      'src/spellings.ts',
      `${HEADER}
const model = "o3-mini";
const NN_MODEL: string | undefined = "o3-mini";
class Agent {
  model = "o3-mini";
  run() {
    return proxy.chat.completions.create({ model: this.model, messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 41 }] });
  }
}
export async function run() {
  await proxy.chat.completions.create({ model, messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 42 }] });
  await proxy.chat.completions.create({ model: NN_MODEL!, messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 43 }] });
  await proxy.chat.completions.create({ "model": "o3-mini", messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 44 }] });
  await proxy.chat.completions.create({ modelName: "o3-mini", messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 45 }] });
  return new Agent().run();
}
`,
    );
    expect(keptSites(project)).toEqual([]);
  });

  it('holds a held call whose model is assigned in a constructor', () => {
    // Its own file: a module-level `const model` would also feed `this.model` by name.
    const project = inMemoryProject(
      'src/assigned.ts',
      `${HEADER}
class Assigned {
  model: string;
  constructor() { this.model = "o3-mini"; }
  run() {
    return proxy.chat.completions.create({ model: this.model, messages: [], fallbacks: [{ model: "o1-mini", max_tokens: 46 }] });
  }
}
export const run = () => new Assigned().run();
`,
    );
    expect(keptSites(project)).toEqual([]);
  });

  it('holds what is written inside a held factory call\'s arguments', () => {
    const project = inMemoryProject(
      'examples/factory.ts',
      `${HEADER}
declare function openai(id: string, settings?: object): unknown;
export const judge = openai("o3-mini", { fallbacks: [{ model: "o1-mini", max_tokens: 47 }] });
`,
    );
    expect(keptSites(project)).toEqual([]);
  });

  it('skips a held call and keeps an ordinary one in the same file', () => {
    const project = inMemoryProject(
      'src/calls.ts',
      `${HEADER}
export async function run() {
  const held = await proxy.chat.completions.create({ model: "o3-mini", max_tokens: 1 });
  const plain = await client.chat.completions.create({ model: "o1-mini", max_tokens: 2 });
  return { held, plain };
}
`,
    );
    expect(keptSites(project)).toEqual(['o1-mini:2']);
  });

  // REGRESSION (review of PR #50, 2026-10-07): the first version keyed on the model LITERAL, and
  // the scan holds a shared declaration when ANY consumer is held, so the direct call lost a
  // parameter fix nobody held. Base made that edit; it must stand.
  it('keeps the ordinary consumer of a const that a held consumer shares', () => {
    const project = inMemoryProject(
      'src/shared.ts',
      `${HEADER}
const MODEL = "o3-mini";
export async function run() {
  const viaProxy = await proxy.chat.completions.create({ model: MODEL, max_tokens: 1 });
  const direct = await client.chat.completions.create({ model: MODEL, max_tokens: 2 });
  return { viaProxy, direct };
}
`,
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    // The precondition the bug needed: the scan held the shared declaration itself.
    expect(held.map((m) => m.location.line)).toEqual([4]);
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });

  it('keeps an ordinary call on the same line as a held call with the same model', () => {
    const project = inMemoryProject(
      'src/line.ts',
      `${HEADER}
export async function run() {
  return [await proxy.chat.completions.create({ model: "o3-mini", max_tokens: 1 }), await client.chat.completions.create({ model: "o3-mini", max_tokens: 2 })];
}
`,
    );
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });

  it('skips every consumer of a const in an example tree', () => {
    const project = inMemoryProject(
      'examples/demo.ts',
      `${HEADER}
const MODEL = "o3-mini";
export async function demo() {
  const a = await client.chat.completions.create({ model: MODEL, max_tokens: 1 });
  const b = await client.chat.completions.create({ model: "o3-mini", max_tokens: 2 });
  return { a, b };
}
`,
    );
    expect(keptSites(project)).toEqual([]);
  });

  it('in an example tree, keeps a standalone config object fed a held const, as the scan does', () => {
    // An inline `{ model: "o3-mini", max_tokens }` that is not a request is example DATA to the
    // scan, never held; the same object fed through a held const must be judged the same way.
    const project = inMemoryProject(
      'examples/cfg.ts',
      `${HEADER}
const MODEL = "o3-mini";
export const cfg = { model: MODEL, max_tokens: 43 };
export async function demo() {
  return client.chat.completions.create({ model: MODEL, max_tokens: 1 });
}
`,
    );
    expect(keptSites(project)).toEqual(['o3-mini:43']);
  });

  it('skips a direct call the scan held for its parameters, though its surface is ordinary', () => {
    // A first-party client inside a function: classifyCallSurface alone says "model_arg". The
    // scan held it anyway, for a parameter no rule covers on the replacement, so the call's OWN
    // held literal has to decide; re-judging the surface would let its max_tokens be renamed.
    const project = inMemoryProject(
      'src/coupled.ts',
      `${HEADER}
export async function run() {
  return client.chat.completions.create({ model: "o3-mini", max_tokens: 1, temperature: 0 });
}
`,
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    expect(held).toHaveLength(1);
    expect(keptSites(project)).toEqual([]);
  });

  it('keeps a consumer in another file of a global held in an example tree', () => {
    // Two classic scripts (no import/export) share one global scope, so `MODEL` in src/ resolves
    // to the declaration in examples/. The scan judged that declaration by the calls in ITS file.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'examples/models.ts',
      [
        'declare const OpenAI: any;',
        'var demoClient = new OpenAI();',
        'var MODEL = "o3-mini";',
        'function demo() { return demoClient.chat.completions.create({ model: MODEL, max_tokens: 1 }); }',
        '',
      ].join('\n'),
    );
    project.createSourceFile(
      'src/run.ts',
      'function run(client: any) { return client.chat.completions.create({ model: MODEL, max_tokens: 2 }); }\n',
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    expect(held.map((m) => m.location.file.replace(/^.*\/(examples|src)\//, '$1/'))).toEqual(['examples/models.ts']);
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });

  it('keeps every site when nothing was held', () => {
    const project = inMemoryProject(
      'src/plain.ts',
      `${HEADER}
export async function run() {
  return client.chat.completions.create({ model: "o3-mini", max_tokens: 2 });
}
`,
    );
    expect(withoutHeldCalls(findParamSites(project, HELD_REGISTRY), [])).toHaveLength(1);
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });
});

describe('model resolution', () => {
  it('resolves the model through a same-file const (best effort)', () => {
    const source = `
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
export async function run(messages: any) {
  const m = "claude-opus-5";
  return anthropic.messages.create({ model: m, temperature: 0, messages });
}
`.trimStart();
    const project = inMemoryProject('src/const-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    // Const-bound model resolved to claude-opus-5 -> temperature removed.
    expect(edits).toEqual([
      { kind: 'param_removal', param: 'temperature', model: 'claude-opus-5' },
    ]);
    const text = project.getSourceFileOrThrow('src/const-model.ts').getFullText();
    expect(text).toContain('{ model: m, messages }');
    expect(text).not.toContain('temperature');
  });

  it('SKIPS a site whose model cannot be resolved to a concrete string', () => {
    // Model comes from an env var: unresolvable -> never guessed, never edited.
    const source = `
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
export async function run(messages: any) {
  return anthropic.messages.create({ model: process.env.MODEL as string, temperature: 0, messages });
}
`.trimStart();
    const project = inMemoryProject('src/env-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toHaveLength(0);
    const text = project.getSourceFileOrThrow('src/env-model.ts').getFullText();
    // Untouched: an unprovable model is left exactly as the developer wrote it.
    expect(text).toContain('temperature: 0');
  });

  it('SKIPS a file annotated mendr: ignore-file or mendr: model-catalog', () => {
    // ADDED 2026-10-07: the model-id scan never edits these files, and the param pass did.
    for (const annotation of ['ignore-file', 'model-catalog']) {
      const source = `// mendr: ${annotation}\nexport const MODELS = [{ model: "o1-mini", max_tokens: 4096, label: "o1 mini" }];\n`;
      const project = inMemoryProject('src/catalog.ts', source);
      expect(findParamSites(project, REGISTRY), annotation).toHaveLength(0);
      expect(applyParamFixes(project, REGISTRY), annotation).toHaveLength(0);
      expect(project.getSourceFileOrThrow('src/catalog.ts').getFullText()).toBe(source);
    }
    // Control: the same row without the annotation is a param site.
    const plain = inMemoryProject('src/catalog.ts', 'export const MODELS = [{ model: "o1-mini", max_tokens: 4096 }];\n');
    expect(findParamSites(plain, REGISTRY)).toHaveLength(1);
  });

  it('SKIPS an object literal that has the param but no model property', () => {
    const source = `
export const opts = { temperature: 0, max_tokens: 100 };
`.trimStart();
    const project = inMemoryProject('src/no-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toHaveLength(0);
    expect(project.getSourceFileOrThrow('src/no-model.ts').getFullText()).toContain(
      'temperature: 0',
    );
  });
});

describe('applyParamFixesToProject (diff)', () => {
  it('produces a unified diff with per-kind counts, touching only changed files', () => {
    const source = `
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
const client = new OpenAI();
const anthropic = new Anthropic();
export async function run(messages: any) {
  await anthropic.messages.create({ model: "claude-opus-5", temperature: 0, messages });
  await client.chat.completions.create({ model: "o1", max_tokens: 100 });
}
`.trimStart();
    const project = inMemoryProject('src/mixed.ts', source);
    // An unaffected file must NOT appear in the diff.
    project.createSourceFile('src/other.ts', 'export const greeting = "hello world";\n');

    const result = applyParamFixesToProject(project, REGISTRY);

    expect(result.removed).toBe(1);
    expect(result.renamed).toBe(1);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toContain('mixed.ts');
    expect(result.diff).toMatch(/^-.*temperature: 0/m);
    expect(result.diff).toMatch(/^\+.*max_completion_tokens: 100/m);
    expect(result.diff).not.toContain('other.ts');
  });

  it('is a no-op (empty diff) when no model-coupled param is present', () => {
    const project = inMemoryProject(
      'src/clean.ts',
      'export const cfg = { model: "gpt-4o", max_tokens: 100 };\n',
    );
    const result = applyParamFixesToProject(project, REGISTRY);

    expect(result.removed).toBe(0);
    expect(result.renamed).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.diff).toBe('');
  });
});
