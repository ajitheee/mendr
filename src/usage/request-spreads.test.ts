import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findModelIdLiterals } from './scanLiterals.js';
import { autoApplyVerification } from './llmRegistry.js';
import { runMigration } from '../migrate/migrate.js';
import type { LlmRegistry } from '../types.js';

const registry: LlmRegistry = [{ provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'gpt-5.6-sol', verification: autoApplyVerification() }];
const prefix = 'import OpenAI from "openai"; const client = new OpenAI();\n';
// Inline, fallback and conditional requests use the same safety controls.
const sources = [
  'export async function ask(options: object) { return client.chat.completions.create({ model: "gpt-4-0613", messages: [], ...options }); }',
  'export async function ask(options: object) { return client.chat.completions.create({ ...options, model: "gpt-4-0613", messages: [] }); }',
  'export async function ask(options: object) { const req = { model: "gpt-4-0613", messages: [], ...options }; return client.chat.completions.create(req); }',
  'const MODEL = "gpt-4-0613"; export async function ask(options: object) { return client.chat.completions.create({ model: MODEL, messages: [], ...options }); }',
  'const model = "gpt-4-0613"; export async function ask(options: object) { return client.chat.completions.create({ model, messages: [], ...options }); }',
  'export async function ask(options: object, override?: {model: string; messages: unknown[]}) { return client.chat.completions.create(override ?? { model: "gpt-4-0613", messages: [], ...options }); }',
  'export async function ask(options: object, override?: {model: string; messages: unknown[]}) { return client.chat.completions.create(override || { ...options, model: "gpt-4-0613", messages: [] }); }',
  'export async function ask(options: object, useOptions: boolean) { return client.chat.completions.create(useOptions ? { model: "gpt-4-0613", messages: [], ...options } : { model: "gpt-5.6-sol", messages: [] }); }',
  'export async function ask(options: object, override?: {model: string; messages: unknown[]}) { return client.chat.completions.create((override ?? ({ model: "gpt-4-0613", messages: [], ...options }))); }',
];
describe('opaque request spreads cannot earn automatic migration', () => {
  it.each(sources)('holds model and parameter uncertainty: %s', source => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile('src/app.ts', prefix + source);
    const [match] = findModelIdLiterals(p, registry);
    expect(match.position).toBe('surface_capped');
    expect(match.reason).toMatch(/spread.*model.*parameters/i);
  });
  it('keeps an explicit request eligible', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile('src/app.ts', prefix + 'export async function ask() { return client.chat.completions.create({ model: "gpt-4-0613", messages: [] }); }');
    expect(findModelIdLiterals(p, registry)[0].position).toBe('model_arg');
    for (const request of [
      'override ?? { model: "gpt-4-0613", messages: [] }',
      'override || { model: "gpt-4-0613", messages: [] }',
      'useDefault ? { model: "gpt-4-0613", messages: [] } : {}',
    ]) {
      const explicit = new Project({ useInMemoryFileSystem: true });
      explicit.createSourceFile('src/app.ts', prefix + `export async function ask(override?: object, useDefault = true) { return client.chat.completions.create(${request}); }`);
      expect(findModelIdLiterals(explicit, registry)[0].position).toBe('model_arg');
    }
  });
  it.each([sources[0], ...sources.slice(5)])('refuses a real migration write rather than trusting a passing local eval: %s', async request => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-request-spreads-'));
    const file = join(dir, 'src/app.ts');
    try {
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'node_modules/openai'), { recursive: true });
      const source = prefix + request;
      writeFileSync(file, source);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'synthetic' }));
      writeFileSync(join(dir, 'node_modules/openai/package.json'), JSON.stringify({ name: 'openai', types: 'index.d.ts' }));
      writeFileSync(join(dir, 'node_modules/openai/index.d.ts'), 'declare class OpenAI { chat: { completions: { create(body: {model: string; messages: unknown[]}): Promise<unknown> } } }; export default OpenAI;');
      writeFileSync(join(dir, 'eval.cjs'), 'require("node:assert/strict").ok(true);');
      const r = await runMigration(dir, registry, { write: true, evalCommand: 'node eval.cjs' });
      expect(r.verification.verdict).toBe('held_for_review');
      expect(r.prReady).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
