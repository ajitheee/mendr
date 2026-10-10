import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import { findModelIdLiterals } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { TS_REQUEST_VARIABLE_REASON } from './tsSurface.js';

// A REQUEST OBJECT BUILT IN A VARIABLE, THEN PASSED BY NAME.
//
// Found on a real repository (2026-10-09): a Node server builds
//
//     const arr = { messages: [...], model: '<retiring id>' };
//     … await chatGPT.chat.completions.create(arr);
//
// and mendr v0.5.8-alpha filed the id as a catalog value (Tier C). `fix-llm` then reported
// 0 A / 0 B and printed no diff, which tells a team there is nothing to do about a call that
// stops working on the shutdown date. The fixtures below are written for this suite; none is
// copied from that repository.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'anthropic', kind: 'model_id', deprecated: 'claude-3-haiku-20240307', replacement: 'claude-haiku-4-5', status: 'deprecated', shutdownDate: '2026-11-01', verification: autoApplyVerification() },
];

function verdict(source: string, file = 'src/app.ts', value = 'gpt-4') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  project.createSourceFile(file, source);
  const m = findModelIdLiterals(project, REG).find((x) => x.value === value);
  if (!m) return undefined;
  return { ...classifyOccurrenceTier(m), position: m.position, reason: m.reason, purpose: m.purpose };
}

const OPENAI = 'import OpenAI from "openai";\nconst client = new OpenAI();\n';

describe('a request object built in a variable and passed to a provider request', { timeout: 60_000 }, () => {
  it('is a live call, not catalog data, when the client is assigned later (the Node server shape)', () => {
    const v = verdict(
      [
        "let llm;",
        "if (process.env.LLM_KEY) {",
        "  const { OpenAI } = require('openai');",
        "  llm = new OpenAI({ apiKey: process.env.LLM_KEY });",
        "}",
        "function register(socket) {",
        "  socket.on('ask', async ({ text }, cb) => {",
        "    const req = {",
        "      messages: [{ role: 'user', content: text }],",
        "      model: 'gpt-4',",
        "    };",
        "    const out = await llm.chat.completions.create(req);",
        "    cb(out.choices[0].message.content);",
        "  });",
        "}",
        "module.exports = { register };",
        '',
      ].join('\n'),
      'src/server.js',
    );
    expect(v?.tier).toBe('B');
    expect(v?.position).toBe('surface_capped');
    // The client is a `let` assigned inside an `if`: it cannot be resolved here, and the reason
    // says so instead of calling the id data.
    expect(v?.reason).toContain('unknown_wrapper');
  });

  it('is a safe swap when the object is the whole request to a resolved first-party client', () => {
    const v = verdict(
      `${OPENAI}export async function ask(text: string) {\n  const req = { model: "gpt-4", messages: [{ role: "user", content: text }] };\n  return client.chat.completions.create(req);\n}\n`,
    );
    expect(v?.tier).toBe('A');
    expect(v?.position).toBe('model_arg');
  });

  it('follows the Anthropic endpoint too, and judges the client like an inline argument', () => {
    const v = verdict(
      'import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic();\nexport async function ask() {\n  const params = { model: "claude-3-haiku-20240307", messages: [] };\n  return client.messages.create(params);\n}\n',
      'src/app.ts',
      'claude-3-haiku-20240307',
    );
    expect(v?.tier).toBe('A');
  });

  it('is held when the client is a proxy, exactly as an inline argument would be', () => {
    const v = verdict(
      'import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "http://localhost:4000/v1" });\nexport async function ask() {\n  const req = { model: "gpt-4", messages: [] };\n  return client.chat.completions.create(req);\n}\n',
    );
    expect(v?.tier).toBe('B');
    expect(v?.reason).toContain('proxy');
  });

  it('is held when the object is spread into the request, whose other keys the literal does not show', () => {
    const v = verdict(
      `${OPENAI}export async function ask() {\n  const base = { model: "gpt-4", messages: [] };\n  return client.chat.completions.create({ ...base, max_tokens: 10 });\n}\n`,
    );
    expect(v?.tier).toBe('B');
    expect(v?.reason).toBe(TS_REQUEST_VARIABLE_REASON);
  });

  it('is held when the variable is also used some other way', () => {
    const logged = verdict(
      `${OPENAI}export async function ask() {\n  const req = { model: "gpt-4", messages: [] };\n  console.log(req);\n  return client.chat.completions.create(req);\n}\n`,
    );
    expect(logged?.tier).toBe('B');
    expect(logged?.reason).toBe(TS_REQUEST_VARIABLE_REASON);
    const changed = verdict(
      `${OPENAI}export async function ask(t: number) {\n  const req: any = { model: "gpt-4", messages: [] };\n  req.temperature = t;\n  return client.chat.completions.create(req);\n}\n`,
    );
    expect(changed?.tier).toBe('B');
    expect(changed?.reason).toBe(TS_REQUEST_VARIABLE_REASON);
  });

  it('is held for a `let`, an exported const, or an object that is only a fallback value', () => {
    for (const source of [
      `${OPENAI}export async function ask() {\n  let req = { model: "gpt-4", messages: [] };\n  return client.chat.completions.create(req);\n}\n`,
      `${OPENAI}export const REQ = { model: "gpt-4", messages: [] };\nexport async function ask() {\n  return client.chat.completions.create(REQ);\n}\n`,
      `${OPENAI}export async function ask(o?: any) {\n  const req = o ?? { model: "gpt-4", messages: [] };\n  return client.chat.completions.create(req);\n}\n`,
    ]) {
      const v = verdict(source);
      expect(v?.tier).toBe('B');
      expect(v?.reason).toBe(TS_REQUEST_VARIABLE_REASON);
    }
  });

  it('is capped at module level, where the request fires at import', () => {
    const v = verdict(`${OPENAI}const req = { model: "gpt-4", messages: [] };\nexport const answer = await client.chat.completions.create(req);\n`);
    expect(v?.tier).toBe('B');
  });
});

describe('following a variable stays linear in the size of the file', () => {
  // The first version resolved every reference by walking every statement of its scopes, once
  // per matched literal: 800 module-level model objects in a 4,800-line file took 327 s. Here
  // 400 objects in a 2,400-line file; the quadratic version is over a minute, this is about one
  // second, and the budget sits far from both.
  it('classifies hundreds of standalone model objects in one large file within budget', () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`const card${i} = { model: "gpt-4", tag: "t${i}" };`);
    for (let i = 0; i < 2000; i++) lines.push(`function f${i}(a: string) { return a + card${i % 400}.tag; }`);
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('src/cards.ts', lines.join('\n'));
    const started = performance.now();
    const matches = findModelIdLiterals(project, REG);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(matches).toHaveLength(400);
    expect(matches.every((m) => m.position === 'data')).toBe(true);
  }, 120_000);
});

describe('an object that never reaches a provider request stays data', { timeout: 60_000 }, () => {
  it('an object nothing passes anywhere', () => {
    const v = verdict('export function preset() {\n  const p = { model: "gpt-4", messages: [] };\n  return p.messages.length;\n}\n');
    expect(v?.tier).toBe('C');
  });

  it('an object handed to a function that is not a provider endpoint', () => {
    for (const call of ['console.log(card)', 'res.json(card)', 'save(card)', 'JSON.stringify(card)']) {
      const v = verdict(
        `${OPENAI}declare const res: any; declare function save(x: unknown): void;\nexport function show() {\n  const card = { model: "gpt-4", label: "GPT-4" };\n  ${call};\n}\n`,
      );
      expect(v?.tier, call).toBe('C');
    }
  });

  it('a model-picker list, even next to a real request', () => {
    const v = verdict(
      `${OPENAI}const MODELS = ["gpt-4", "gpt-4o"];\nexport async function ask(m: string) {\n  const req = { model: m, messages: [] };\n  return client.chat.completions.create(req);\n}\n`,
    );
    expect(v?.tier).toBe('C');
    expect(v?.purpose).toBe('list_entry');
  });

  it('a same-named binding in another scope is not the object that is sent', () => {
    const v = verdict(
      `${OPENAI}const req = { model: "gpt-4", label: "default" };\nexport async function ask(req: any) {\n  return client.chat.completions.create(req);\n}\n`,
    );
    expect(v?.tier).toBe('C');
  });

  // Not followed on purpose: a row of a list is a model card far more often than a request,
  // and the list is the shape the catalog rule exists for.
  it('a row of a list is not followed, even when one row is later spread into a request', () => {
    const v = verdict(
      `${OPENAI}const CARDS = [{ model: "gpt-4", label: "GPT-4" }];\nexport async function ask() {\n  return client.chat.completions.create({ ...CARDS[0], messages: [] });\n}\n`,
    );
    expect(v?.tier).toBe('C');
  });
});
