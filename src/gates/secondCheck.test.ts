import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { applyLlmFixesToProject } from '../fix/llmFix.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { compareLinesPy, runSecondCheck, type SecondCheckOutcome } from './secondCheck.js';

// VERIFY TWICE (PLAN-30-DAYS.md, P2-F). Each failing case below is a patch the first check would
// pass: it type-checks, nothing is missing a symbol, no test calls the provider. Only a check that
// re-reads the patch against the registry can hold it.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'o1', replacement: 'gpt-5.6-sol', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', on_models: ['o1', 'gpt-5.6'] },
  { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['gpt-5.6'] },
];

const SRC = [
  'import OpenAI from "openai";',
  'const client = new OpenAI();',
  '// the two calls the product makes',
  'export const a = (messages: any) => client.chat.completions.create({ model: "o1", max_tokens: 500, messages });',
  'export const b = (messages: any) => client.chat.completions.create({ model: "o1", messages });',
  '',
].join('\n');

function project(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [name, text] of Object.entries(files)) p.createSourceFile(name, text);
  return p;
}

/** What the real codemod writes for these files. */
function writerOutput(files: Record<string, string>, onlySwapped = false): Record<string, string> {
  const p = project(files);
  applyLlmFixesToProject(p, REG, '/', { paramsOnSwappedCallsOnly: onlySwapped });
  return Object.fromEntries(Object.keys(files).map((f) => [f, p.getSourceFileOrThrow(f).getFullText()]));
}

function check(files: Record<string, string>, patched: Record<string, string>, onlySwapped = false): Promise<SecondCheckOutcome> {
  return runSecondCheck({
    repoPath: '/',
    registry: REG,
    freshTs: project(files),
    tsFiles: Object.entries(patched)
      .filter(([f, t]) => t !== files[f])
      .map(([f, t]) => ({ absPath: `/${f}`, newText: t })),
    pyFiles: [],
    paramsOnSwappedCallsOnly: onlySwapped,
  });
}

const kinds = (o: SecondCheckOutcome): string[] => o.problems.map((p) => p.kind);

describe('runSecondCheck — TypeScript', () => {
  it('passes the real codemod output, and says what it checked', async () => {
    const files = { 'src/r.ts': SRC };
    const patched = writerOutput(files);
    expect(patched['src/r.ts']).toContain('{ model: "gpt-5.6-sol", max_completion_tokens: 500, messages }');
    const out = await check(files, patched);
    expect(out.problems).toEqual([]);
    expect(out.status).toBe('passed');
    expect(out.detail).toMatch(/every edit matches a registry rule/);
  });

  it('holds a patch that missed a second call site', async () => {
    const files = { 'src/r.ts': SRC };
    const patched = SRC.replace('{ model: "o1", max_tokens: 500', '{ model: "gpt-5.6-sol", max_completion_tokens: 500');
    const out = await check(files, { 'src/r.ts': patched });
    expect(out.status).toBe('failed');
    expect(kinds(out)).toEqual(['missed_site']);
    expect(out.problems[0]).toMatchObject({ file: 'src/r.ts', line: 5 });
    expect(out.problems[0]!.detail).toContain('"o1" is still here');
  });

  it('holds a patch that also made an edit no rule names', async () => {
    const files = { 'src/r.ts': SRC };
    const patched = writerOutput(files)['src/r.ts']!.replace('max_completion_tokens: 500', 'max_completion_tokens: 600');
    const out = await check(files, { 'src/r.ts': patched });
    expect(out.status).toBe('failed');
    expect(kinds(out)).toEqual(['out_of_scope_edit']);
    expect(out.problems[0]).toMatchObject({ line: 4 });
  });

  it('holds a patch that swapped the model and left a parameter the new model renames', async () => {
    const files = { 'src/r.ts': SRC };
    const patched = SRC.replaceAll('model: "o1"', 'model: "gpt-5.6-sol"');
    const out = await check(files, { 'src/r.ts': patched });
    expect(out.status).toBe('failed');
    expect(kinds(out)).toEqual(['param_rule_unmet']);
    expect(out.problems[0]!.detail).toBe('"max_tokens" is still sent to gpt-5.6-sol, which expects "max_completion_tokens"');
  });

  it('holds a patch that changed a comment', async () => {
    const files = { 'src/r.ts': SRC };
    const patched = writerOutput(files)['src/r.ts']!.replace('the two calls', 'both calls');
    const out = await check(files, { 'src/r.ts': patched });
    expect(kinds(out)).toEqual(['out_of_scope_edit']);
    expect(out.problems[0]!.detail).toBe('changed a comment');
  });

  it('holds a registry-named swap at a place the scan does not call a live model argument', async () => {
    const src = `${SRC}export const MODELS = ["o1", "gpt-4o"];\n`;
    const files = { 'src/r.ts': src };
    const patched = writerOutput(files)['src/r.ts']!.replace('["o1", "gpt-4o"]', '["gpt-5.6-sol", "gpt-4o"]');
    const out = await check(files, { 'src/r.ts': patched });
    expect(kinds(out)).toEqual(['out_of_scope_edit']);
    expect(out.problems[0]!.detail).toContain('where the scan found no live model argument');
  });

  it('allows a removal the rule names for the object’s own model, and nothing more', async () => {
    const src = [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export const c = (messages: any) => client.chat.completions.create({ model: "gpt-5.6-sol", temperature: 1, messages });',
      '',
    ].join('\n');
    const files = { 'src/c.ts': src };
    const patched = writerOutput(files)['src/c.ts']!;
    expect(patched).not.toContain('temperature');
    expect((await check(files, { 'src/c.ts': patched })).status).toBe('passed');

    const tooMuch = patched.replace('{ model: "gpt-5.6-sol", messages }', '{ model: "gpt-5.6-sol" }');
    const out = await check(files, { 'src/c.ts': tooMuch });
    expect(kinds(out)).toEqual(['out_of_scope_edit']);
    expect(out.problems[0]!.detail).toContain('"messages"');
  });

  it('holds a rename on a model the rule does not cover', async () => {
    const src = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport const d = () => client.chat.completions.create({ model: "gpt-4o", max_tokens: 5, messages: [] });\n';
    const files = { 'src/d.ts': src };
    const out = await check(files, { 'src/d.ts': src.replace('max_tokens', 'max_completion_tokens') });
    expect(kinds(out)).toEqual(['out_of_scope_edit']);
    expect(out.problems[0]!.detail).toBe('renamed "max_tokens" on gpt-4o, which the rule does not cover');
  });

  it('allows a rename written as a computed key, and holds a shorthand that was renamed', async () => {
    const head = ['import OpenAI from "openai";', 'const client = new OpenAI();', ''].join('\n');
    const computed = `${head}export const f = () => client.chat.completions.create({ model: "gpt-5.6-sol", ["max_tokens"]: 5, messages: [] });\n`;
    const files = { 'src/f.ts': computed };
    const patched = writerOutput(files)['src/f.ts']!;
    expect(patched).toContain('["max_completion_tokens"]: 5');
    expect((await check(files, { 'src/f.ts': patched })).status).toBe('passed');

    // `{ max_tokens }` sends the variable max_tokens; `{ max_completion_tokens }` sends a different one.
    const shorthand = `${head}const max_tokens = 5;\nexport const g = () => client.chat.completions.create({ model: "gpt-5.6-sol", max_tokens, messages: [] });\n`;
    const out = await check({ 'src/g.ts': shorthand }, { 'src/g.ts': shorthand.replace('max_tokens, messages', 'max_completion_tokens, messages') });
    expect(out.status).toBe('failed');
    expect(kinds(out)).toContain('out_of_scope_edit');
  });

  it('under --only, judges parameters only at the calls the patch swapped', async () => {
    // `e` is already on the new model. With --only the writer leaves its request alone, so the
    // second check must too; without --only the same text is a rule left unmet.
    const src = `${SRC}export const e = (messages: any) => client.chat.completions.create({ model: "gpt-5.6-sol", max_tokens: 9, messages });\n`;
    const files = { 'src/r.ts': src };
    const patched = writerOutput(files, true);
    expect(patched['src/r.ts']).toContain('{ model: "gpt-5.6-sol", max_tokens: 9, messages }');
    expect((await check(files, patched, true)).status).toBe('passed');
    expect(kinds(await check(files, patched, false))).toEqual(['param_rule_unmet']);
  });

  it('is not_run when nothing was patched', async () => {
    const out = await runSecondCheck({ repoPath: '/', registry: REG, tsFiles: [], pyFiles: [] });
    expect(out).toMatchObject({ status: 'not_run', problems: [] });
  });
});

describe('compareLinesPy', () => {
  const PY_REG: LlmRegistry = [
    { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', verification: autoApplyVerification() },
  ];
  const line = 'return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)';

  it('explains a swap inside a string literal', () => {
    expect(compareLinesPy(line, line.replace('gpt-3.5-turbo', 'gpt-5.6-terra'), PY_REG)).toEqual([{ line: 1, swapped: true, detail: '' }]);
  });
  it('rejects a change outside a string literal', () => {
    const [p] = compareLinesPy(line, line.replace('messages=p', 'messages=q'), PY_REG);
    expect(p).toMatchObject({ swapped: false, detail: 'changed code outside a string literal' });
  });
  it('rejects a string change no registry entry names', () => {
    const [p] = compareLinesPy(line, line.replace('gpt-3.5-turbo', 'gpt-4o'), PY_REG);
    expect(p!.detail).toBe('changed "gpt-3.5-turbo" to "gpt-4o", which no verified registry entry names');
  });
  it('rejects added lines', () => {
    expect(compareLinesPy(line, `${line}\nprint(1)`, PY_REG)[0]!.detail).toMatch(/added or removed lines/);
  });
});

describe('runSecondCheck — Python', () => {
  const PY_REG: LlmRegistry = [
    { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', verification: autoApplyVerification() },
  ];
  const PY = [
    'from openai import OpenAI',
    'client = OpenAI()',
    '',
    'def one(p):',
    '    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)',
    '',
    'def two(p):',
    '    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)',
    '',
  ].join('\n');

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function repo(text: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-second-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'app.py');
    writeFileSync(file, text);
    return { dir, file };
  }

  it('passes the real Python codemod output', async () => {
    const { dir, file } = repo(PY);
    const fixed = await applyPyModelIdFixesToSources([{ path: file, text: PY }], PY_REG, dir);
    expect(fixed.patchedFiles).toHaveLength(1);
    const out = await runSecondCheck({ repoPath: dir, registry: PY_REG, tsFiles: [], pyFiles: fixed.patchedFiles });
    expect(out.problems).toEqual([]);
    expect(out.status).toBe('passed');
  });

  it('holds a Python patch that missed a second call site', async () => {
    const { dir, file } = repo(PY);
    const once = PY.replace('model="gpt-3.5-turbo"', 'model="gpt-5.6-terra"');
    const out = await runSecondCheck({ repoPath: dir, registry: PY_REG, tsFiles: [], pyFiles: [{ absPath: file, newText: once }] });
    expect(out.status).toBe('failed');
    expect(kinds(out)).toEqual(['missed_site']);
    expect(out.problems[0]).toMatchObject({ file: 'app.py', line: 8 });
  });
});
