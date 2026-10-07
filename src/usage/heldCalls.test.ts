import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import { findModelIdLiterals, type LiteralMatch } from './scanLiterals.js';
import { TS_IN_HELD_CALL_REASON } from './tsSurface.js';

// ONE CALL, ONE VERDICT (holdWholeCalls). The scan records on each held match the calls it holds,
// and holds every other model value written inside those calls or declared and fed into one.
// Before this, a held call could still be patched in part: the plain branch of a mixed ternary
// and a factory call nested in a held request were Tier A swaps inside a call the same report
// listed as held (review of PR #50, round four). audit, watch and fix-llm all read this verdict,
// and the param pass reads the same heldCalls, so every surface agrees on what a held call is.

const REGISTRY: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o3-mini',
    replacement: 'gpt-5.6-sol',
    verification: autoApplyVerification(),
  },
];
const HEADER = [
  'import OpenAI from "openai";',
  'import { openai } from "@ai-sdk/openai";',
  'const client = new OpenAI();',
  'const proxy = new OpenAI({ baseURL: "https://llm-proxy.internal/v1" });',
].join('\n');

function scan(source: string): LiteralMatch[] {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('src/calls.ts', `${HEADER}\n${source}`);
  return findModelIdLiterals(project, REGISTRY);
}
const HEADER_LINES = HEADER.split('\n').length;
/** `line:position[:in-held]` for each match, lines counted from the source passed to scan(). */
const verdicts = (matches: LiteralMatch[]) =>
  matches.map(
    (m) =>
      `${m.location.line - HEADER_LINES}:${m.position}${m.reason === TS_IN_HELD_CALL_REASON ? ':in-held' : ''}`,
  );

describe('holdWholeCalls: a held call is held as a whole', () => {
  it('holds the plain branch of a ternary whose other branch is a gateway id', () => {
    const matches = scan(`export async function run(useGw: boolean) {
  return client.chat.completions.create({ model: useGw ? "openai/o3-mini" : "o3-mini", messages: [] });
}
`);
    expect(verdicts(matches)).toEqual(['2:surface_capped', '2:surface_capped:in-held']);
  });

  it('holds a model-factory call written inside a held request, and keeps the same call outside', () => {
    const matches = scan(`export async function run() {
  await proxy.chat.completions.create({ model: "o3-mini", messages: [], judge: openai("o3-mini") });
  return openai("o3-mini");
}
`);
    expect(verdicts(matches)).toEqual(['2:surface_capped', '2:surface_capped:in-held', '3:model_arg']);
  });

  it('holds a declaration that feeds a held call, and leaves one that feeds only ordinary calls', () => {
    const matches = scan(`const PLAIN_MODEL = "o3-mini";
const OTHER_MODEL = "o3-mini";
export async function run(flag: boolean) {
  await client.chat.completions.create({ model: flag ? "openai/o3-mini" : PLAIN_MODEL, messages: [] });
  return client.chat.completions.create({ model: OTHER_MODEL, messages: [] });
}
`);
    expect(verdicts(matches)).toEqual(['1:surface_capped:in-held', '2:model_arg', '4:surface_capped']);
  });

  it('records the calls a held match holds: its own call, or only the capped consumers of a const', () => {
    const matches = scan(`const MODEL = "o3-mini";
export async function run() {
  await proxy.chat.completions.create({ model: "o3-mini", messages: [] });
  await proxy.chat.completions.create({ model: MODEL, messages: [] });
  return client.chat.completions.create({ model: MODEL, messages: [] });
}
`);
    const held = (line: number) =>
      (matches.find((m) => m.location.line - HEADER_LINES === line)?.heldCalls ?? []).map(
        (c) => c.getStartLineNumber() - HEADER_LINES,
      );
    expect(held(3)).toEqual([3]);
    // The const is held because of the proxy consumer; the direct consumer stays an ordinary call.
    expect(held(1)).toEqual([4]);
  });

  it('changes nothing in a file with no held call', () => {
    const matches = scan(`export async function run() {
  return client.chat.completions.create({ model: "o3-mini", messages: [], judge: openai("o3-mini") });
}
`);
    expect(verdicts(matches)).toEqual(['2:model_arg', '2:model_arg']);
  });
});
