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

describe('withoutHeldCalls: a call held at review is never edited, and only a held call is skipped', () => {
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
    return withoutHeldCalls(findParamSites(project, registry), held, registry).map(
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

  it('does not climb out of a ternary\'s condition or an operator that does not select a value', () => {
    const project = inMemoryProject(
      'src/cond.ts',
      `${HEADER}
export async function run(other: object) {
  return proxy.chat.completions.create({
    model: "o3-mini",
    messages: [],
    pick: { model: "o1-mini", max_tokens: 9 } ? 1 : 2,
    same: { model: "o1-mini", max_tokens: 8 } === other,
  });
}
`,
    );
    expect(keptSites(project).sort()).toEqual(['o1-mini:8', 'o1-mini:9']);
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

  it('stops climbing at the request: a call inside a held call\'s callback is its own call', () => {
    const project = inMemoryProject(
      'src/retry.ts',
      `${HEADER}
export async function run() {
  return proxy.chat.completions.create({
    model: "o3-mini",
    messages: [],
    onRetry: () => client.chat.completions.create({ model: "o1-mini", max_tokens: 2 }),
  });
}
`,
    );
    expect(keptSites(project)).toEqual(['o1-mini:2']);
  });

  it('holds a wrapper class fed a held const, and not a catalog row fed the same const', () => {
    // max_tokens is itself a catalog sibling key, so this branch needs a rule on another
    // parameter to be reachable at all: temperature, removed on o3 here.
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
  const w = new Wrapper({ model: MODEL, temperature: 0 });
  const card = new Wrapper({ model: MODEL, temperature: 1, label: "o3 mini" });
  return { w, card };
}
`,
    );
    expect(keptSites(project, registry)).toEqual(['o3-mini:1']);
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

  // REGRESSION (2026-10-07): the scan now holds a const, a `{ model }` shorthand or a quoted-key
  // request for its parameters, as it holds the inline twin. The param pass must see the same
  // request as held, or it would edit a call listed as "review required, no patch generated".
  it('skips a held call whose model is a `{ model }` shorthand', () => {
    const project = inMemoryProject(
      'src/shorthand.ts',
      `${HEADER}
export async function run() {
  const model = "o3-mini";
  return client.chat.completions.create({ model, max_tokens: 1, temperature: 0 });
}
`,
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    expect(held.map((m) => m.location.line)).toEqual([5]);
    // The param pass sees the shorthand's model (it did not before), so withoutHeldCalls decides.
    expect(findParamSites(project, HELD_REGISTRY).map((s) => s.model)).toEqual(['o3-mini']);
    expect(keptSites(project)).toEqual([]);
  });

  it('skips a held call written with quoted keys', () => {
    const project = inMemoryProject(
      'src/quoted.ts',
      `${HEADER}
export async function run() {
  return client.chat.completions.create({ "model": "o3-mini", "max_tokens": 1, "temperature": 0 });
}
`,
    );
    expect(findParamSites(project, HELD_REGISTRY)).toHaveLength(1);
    expect(keptSites(project)).toEqual([]);
  });

  it('judges each consumer of a const held for its parameters by its own parameters', () => {
    // Call a passes a parameter no rule covers on the replacement, so the scan holds MODEL; call
    // b passes none, and its own fix (max_tokens on o3-mini, which the rule names) stands.
    const project = inMemoryProject(
      'src/consumers.ts',
      `${HEADER}
const MODEL = "o3-mini";
export async function run() {
  const a = await client.chat.completions.create({ model: MODEL, max_tokens: 1, temperature: 0 });
  const b = await client.chat.completions.create({ model: MODEL, max_tokens: 2 });
  return { a, b };
}
`,
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    expect(held.map((m) => m.location.line)).toEqual([4]);
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });

  it('holds a direct consumer by its own parameters when the const was held at another call\'s surface', () => {
    // The proxy call holds MODEL at its surface; the scan never reached the parameter check. The
    // direct call with `temperature` would be held inline, so its request is not edited either.
    const project = inMemoryProject(
      'src/surface.ts',
      `${HEADER}
const MODEL = "o3-mini";
export async function run() {
  await proxy.chat.completions.create({ model: MODEL, messages: [] });
  await client.chat.completions.create({ model: MODEL, max_tokens: 1, temperature: 0 });
  return client.chat.completions.create({ model: MODEL, max_tokens: 2 });
}
`,
    );
    expect(keptSites(project)).toEqual(['o3-mini:2']);
  });

  // REGRESSION (2026-10-10): the scan now holds a call whose model is a fallback or a ternary branch
  // for its parameters, as it holds the bare literal. Its nested requests are skipped with it.
  it('skips the nested requests of a call held for its parameters through a fallback, and keeps an unheld twin\'s', () => {
    const project = inMemoryProject(
      'src/fallback.ts',
      `${HEADER}
export async function run(opts: { model?: string }) {
  await client.chat.completions.create({ model: opts.model || "o3-mini", temperature: 0, messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 41 }] });
  return client.chat.completions.create({ model: opts.model || "o3-mini", messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 42 }] });
}
`,
    );
    const held = findModelIdLiterals(project, HELD_REGISTRY).filter((m) => m.position === 'surface_capped');
    expect(held.map((m) => m.location.line)).toEqual([5]);
    expect(keptSites(project)).toEqual(['o3-mini:42']);
  });

  // REGRESSION (2026-10-10): `MODEL!` hid a held call's model from the guard, so the nested request
  // of a held proxy call was edited. The scan's sink rule has always read `MODEL!` as `MODEL`.
  it('holds the nested requests of a held call whose model is read through `!`', () => {
    const project = inMemoryProject(
      'src/nonnull.ts',
      `${HEADER}
const MODEL = "o3-mini";
export async function run() {
  await proxy.chat.completions.create({ model: MODEL!, messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 31 }] });
  return client.chat.completions.create({ model: MODEL!, messages: [], fallbacks: [{ model: "o3-mini", max_tokens: 32 }] });
}
`,
    );
    expect(keptSites(project)).toEqual(['o3-mini:32']);
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
    expect(withoutHeldCalls(findParamSites(project, HELD_REGISTRY), [], HELD_REGISTRY)).toHaveLength(1);
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

  // REGRESSION (2026-10-07): `getNameNode().getSymbol()` on a shorthand is the PROPERTY's symbol,
  // so `{ model }` never resolved, and a swap of `const model = '…'` left the request unfixed.
  it('resolves a `{ model }` shorthand through the variable it names', () => {
    const project = inMemoryProject(
      'src/shorthand.ts',
      'export async function run(client: any) {\n  const model = "o1-mini";\n  return client.chat.completions.create({ model, max_tokens: 100 });\n}\n',
    );
    expect(applyParamFixes(project, REGISTRY)).toEqual([
      { kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', model: 'o1-mini' },
    ]);
    expect(project.getSourceFileOrThrow('src/shorthand.ts').getFullText()).toContain(
      '{ model, max_completion_tokens: 100 }',
    );
  });

  // REGRESSION (2026-10-07): `getProperty(name)` compares a key as written, so a quoted key was
  // invisible: the model was swapped and `"max_tokens"` beside it never renamed.
  it('finds quoted keys, and renames them in their own quote style', () => {
    const project = inMemoryProject(
      'src/quoted.ts',
      [
        'export const a = (c: any) => c.chat.completions.create({ "model": "o1-mini", "max_tokens": 1 });',
        "export const b = (c: any) => c.chat.completions.create({ model: 'o1-mini', 'max_tokens': 2 });",
        '',
      ].join('\n'),
    );
    expect(applyParamFixes(project, REGISTRY)).toHaveLength(2);
    const text = project.getSourceFileOrThrow('src/quoted.ts').getFullText();
    expect(text).toContain('{ "model": "o1-mini", "max_completion_tokens": 1 }');
    expect(text).toContain("{ model: 'o1-mini', 'max_completion_tokens': 2 }");
  });

  // A quoted or computed key is how a JSON-shaped model table is usually written. Reading it as the
  // plain key is for following a swap into its request; outside a request it would rename a
  // catalog row's key, which breaks the row's readers and fixes no request.
  it('reads a quoted or computed key only in a request: a call argument or a request variable', () => {
    const project = inMemoryProject(
      'src/tables.ts',
      [
        'export const CATALOG = [{ "model": "o1-mini", "max_tokens": 65536, "label": "o1 mini" }];',
        'export const ROW = { ["model"]: "o1-mini", ["max_tokens"]: 7 };',
        'export const MIXED = { model: "o1-mini", "max_tokens": 8 };',
        'export const QUOTED_MODEL = { "model": "o1-mini", max_tokens: 9 };',
        'export async function viaVariable(c: any) {',
        '  const req = { "model": "o1-mini", "max_tokens": 10 };',
        '  return c.chat.completions.create(req);',
        '}',
        'export const viaCall = (c: any) => c.chat.completions.create(({ "model": "o1-mini", ["max_tokens"]: 11 }));',
        '',
      ].join('\n'),
    );
    expect(applyParamFixes(project, REGISTRY)).toHaveLength(2);
    const text = project.getSourceFileOrThrow('src/tables.ts').getFullText();
    expect(text).toContain('[{ "model": "o1-mini", "max_tokens": 65536, "label": "o1 mini" }]');
    expect(text).toContain('{ ["model"]: "o1-mini", ["max_tokens"]: 7 }');
    expect(text).toContain('{ model: "o1-mini", "max_tokens": 8 }');
    expect(text).toContain('{ "model": "o1-mini", max_tokens: 9 }');
    expect(text).toContain('const req = { "model": "o1-mini", "max_completion_tokens": 10 };');
    expect(text).toContain('({ "model": "o1-mini", ["max_completion_tokens"]: 11 })');
  });

  // The sink rule reads `MODEL!` as `MODEL`, so pass 1 swaps the const behind it; pass 2 has to
  // read the request's model there too, or the swap ships without its parameter fix.
  it('reads a model through a non-null `!`', () => {
    const project = inMemoryProject(
      'src/nonnull.ts',
      'const M = "o1-mini";\nexport const a = (c: any) => c.chat.completions.create({ model: M!, max_tokens: 6 });\n',
    );
    expect(applyParamFixes(project, REGISTRY)).toEqual([
      { kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', model: 'o1-mini' },
    ]);
    expect(project.getSourceFileOrThrow('src/nonnull.ts').getFullText()).toContain(
      '{ model: M!, max_completion_tokens: 6 }',
    );
  });

  it('reads a model through parentheses and a cast that masks nothing, never through one that does', () => {
    // Pass 1 swaps a literal behind `as string` / `as const` / parentheses, so pass 2 has to read
    // it there too. A cast to the repo's own type masks the id and pass 1 does not swap it.
    const project = inMemoryProject(
      'src/casts.ts',
      [
        'type ModelId = "o1-mini" | "gpt-4o";',
        'const M = "o1-mini" as const;',
        'export const a = (c: any) => c.chat.completions.create({ model: "o1-mini" as string, max_tokens: 1 });',
        'export const b = (c: any) => c.chat.completions.create({ model: ("o1-mini"), max_tokens: 2 });',
        'export const d = (c: any) => c.chat.completions.create({ model: M, max_tokens: 3 });',
        'export const e = (c: any) => c.chat.completions.create({ model: "o1-mini" as ModelId, max_tokens: 4 });',
        'export const f = (c: any) => c.chat.completions.create({ model: M as string, max_tokens: 5 });',
        '',
      ].join('\n'),
    );
    applyParamFixes(project, REGISTRY);
    const text = project.getSourceFileOrThrow('src/casts.ts').getFullText();
    expect(text).toContain('{ model: "o1-mini" as string, max_completion_tokens: 1 }');
    expect(text).toContain('{ model: ("o1-mini"), max_completion_tokens: 2 }');
    expect(text).toContain('{ model: M, max_completion_tokens: 3 }');
    expect(text).toContain('{ model: "o1-mini" as ModelId, max_tokens: 4 }');
    expect(text).toContain('{ model: M as string, max_completion_tokens: 5 }');
  });

  // REGRESSION (review of 402c1e4, 2026-10-07): a reassigned `let` is either model at run time, and
  // resolving it to its initializer removed `temperature` from a request that may go to Sonnet.
  // Written `{ model: model }` that was already so on 0df2dce; resolving the shorthand made
  // `{ model }` do it too.
  it('SKIPS a let or var that is reassigned, in every way a variable can be written', () => {
    const writes: Array<[string, string]> = [
      ['an if', "if (cheap) model = 'claude-sonnet-4-6';"],
      ['a compound assignment', "model ??= 'claude-sonnet-4-6';"],
      ['an increment', 'if (cheap) model++;'],
      ['an array destructuring assignment', "[model] = ['claude-sonnet-4-6'];"],
      ['an object destructuring assignment', "({ model } = { model: 'claude-sonnet-4-6' });"],
      ['a renamed destructuring assignment', "({ m: model } = { m: 'claude-sonnet-4-6' });"],
      ['a for-of head', "for (model of ['claude-sonnet-4-6']) break;"],
      ['a nested function', "const pick = () => { model = 'claude-sonnet-4-6'; }; pick();"],
    ];
    // One project, one file per variant: a type checker per project is what makes these slow.
    const project = new Project({ useInMemoryFileSystem: true });
    const files = new Map<string, string>();
    let n = 0;
    for (const kind of ['let', 'var']) {
      for (const [label, write] of writes) {
        for (const value of ['model', 'model: model']) {
          const file = `src/let${n++}.ts`;
          files.set(file, `${kind} / ${label} / ${value}`);
          project.createSourceFile(
            file,
            [
              'export async function run(anthropic: any, cheap: boolean) {',
              `  ${kind} model = 'claude-opus-5';`,
              `  ${write}`,
              `  return anthropic.messages.create({ ${value}, temperature: 0.2, max_tokens: 100 });`,
              '}',
              '',
            ].join('\n'),
          );
        }
      }
    }
    const sites = findParamSites(project, REGISTRY).map((s) => files.get(s.location.file.replace(/^\//, '')));
    expect(sites).toEqual([]);
    // Control, in the same project: without the write, the same request is a site.
    project.createSourceFile(
      'src/control.ts',
      "export async function run(anthropic: any) {\n  let model = 'claude-opus-5';\n  return anthropic.messages.create({ model, temperature: 0.2, max_tokens: 100 });\n}\n",
    );
    expect(findParamSites(project, REGISTRY).map((s) => s.location.file)).toEqual(['/src/control.ts']);
  }, 30_000);

  it('resolves a let that nothing reassigns, and is not fooled by a write to another binding of the name', () => {
    const source = [
      'export async function run(anthropic: any) {',
      "  let model = 'claude-opus-5';",
      '  return anthropic.messages.create({ model, temperature: 0.2, max_tokens: 100 });',
      '}',
      // A different `model` (a parameter) written elsewhere in the file.
      "export function other(model: string) { model = 'x'; return model; }",
      // `model++` on yet another binding, and a read in a comparison: neither writes the let.
      'export function counter() { let model = 0; model++; return model; }',
      "export const same = (m: string) => m === 'model';",
      '',
    ].join('\n');
    const project = inMemoryProject('src/let.ts', source);
    expect(applyParamFixes(project, REGISTRY)).toEqual([
      { kind: 'param_removal', param: 'temperature', model: 'claude-opus-5' },
    ]);
    expect(project.getSourceFileOrThrow('src/let.ts').getFullText()).toContain(
      'create({ model, max_tokens: 100 })',
    );
  });

  // `["max_tokens"]: 5` is `max_tokens` to the provider; the scan now reads it so, and the param
  // pass follows the swap the same way, keeping the computed form.
  it('finds a computed string key, and renames it keeping the brackets and quotes', () => {
    const project = inMemoryProject(
      'src/computed.ts',
      [
        'export const a = (c: any) => c.chat.completions.create({ model: "o1-mini", ["max_tokens"]: 1 });',
        "export const b = (c: any) => c.chat.completions.create({ ['model']: 'o1-mini', [`max_tokens`]: 2 });",
        'const k = "max_tokens";',
        'export const d = (c: any) => c.chat.completions.create({ model: "o1-mini", [k]: 3 });',
        '',
      ].join('\n'),
    );
    expect(applyParamFixes(project, REGISTRY)).toHaveLength(2);
    const text = project.getSourceFileOrThrow('src/computed.ts').getFullText();
    expect(text).toContain('{ model: "o1-mini", ["max_completion_tokens"]: 1 }');
    expect(text).toContain("{ ['model']: 'o1-mini', [`max_completion_tokens`]: 2 }");
    // A computed key whose name is not written there is not read.
    expect(text).toContain('{ model: "o1-mini", [k]: 3 }');
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
