import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import { findModelIdLiterals } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import {
  collectTsSourceFiles,
  countScriptFilesByLanguage,
  countTsTestFiles,
  scriptLanguageOf,
} from './scanRepo.js';

// JavaScript rides the SAME syntactic scanner as TypeScript: ts-morph parses
// .js/.jsx/.mjs/.cjs into the same AST, so the literal/receiver rules apply
// unchanged. These lock the outcomes a real JS repo depends on.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

function tierIn(source: string, file: string, value = 'gpt-4') {
  const project = new Project({ useInMemoryFileSystem: false, compilerOptions: { allowJs: true, checkJs: false } });
  project.createSourceFile(file, source);
  const m = findModelIdLiterals(project, REG).find((x) => x.value === value || x.value.endsWith('/' + value));
  if (!m) return undefined;
  return { ...classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }), position: m.position, purpose: m.purpose };
}

const ESM = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask(text) {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n';

describe('the scanner reads JavaScript, not only TypeScript', () => {
  it('an ES-module .js first-party call site is Tier A, exactly like the .ts shape', () => {
    const t = tierIn(ESM, 'src/ai.js');
    expect(t?.tier).toBe('A');
    expect(t?.position).toBe('model_arg');
  });

  it('.mjs and .jsx call sites are Tier A too', () => {
    expect(tierIn(ESM, 'src/ai.mjs')?.tier).toBe('A');
    const jsx = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport function C() {\n  const p = client.chat.completions.create({ model: "gpt-4" });\n  return <div>{String(p)}</div>;\n}\n';
    expect(tierIn(jsx, 'src/C.jsx')?.tier).toBe('A');
  });

  it('a CommonJS require() call site is DETECTED, and conservatively not auto-patched', () => {
    // The receiver comes from require(), which the syntactic resolver does not
    // tie to a first-party SDK, so it is found but capped below Tier A — a safe
    // "review", never a wrong auto-fix.
    const cjs = 'const OpenAI = require("openai");\nconst client = new OpenAI();\nasync function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\nmodule.exports = { ask };\n';
    const t = tierIn(cjs, 'src/ai.cjs');
    expect(t).toBeDefined();
    expect(t?.tier).not.toBe('A');
  });

  it('a bare model literal in JS data is not a call site', () => {
    const t = tierIn('const MODELS = ["gpt-4", "gpt-4o"];\nexport default MODELS;\n', 'src/models.js');
    expect(t?.tier === 'A').toBe(false);
  });
});

describe('the repo walkers include JavaScript and skip generated/test files', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-js-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it('scriptLanguageOf classifies extensions and excludes .d.ts and .min.js', () => {
    expect(scriptLanguageOf('a.ts')).toBe('ts');
    expect(scriptLanguageOf('a.mts')).toBe('ts');
    expect(scriptLanguageOf('a.js')).toBe('js');
    expect(scriptLanguageOf('a.jsx')).toBe('js');
    expect(scriptLanguageOf('a.mjs')).toBe('js');
    expect(scriptLanguageOf('a.cjs')).toBe('js');
    expect(scriptLanguageOf('a.d.ts')).toBeNull();
    expect(scriptLanguageOf('vendor.min.js')).toBeNull();
    expect(scriptLanguageOf('a.go')).toBeNull();
  });

  it('collects JS source, counts it by language, and skips test/min/vendored files', () => {
    const dir = repo({
      'src/app.js': ESM,
      'src/worker.mjs': ESM,
      'src/ui.jsx': ESM,
      'src/legacy.cjs': ESM,
      'src/types.d.ts': 'export type X = string;\n',
      'src/vendor.min.js': ESM,
      'src/app.test.js': ESM,
      'node_modules/pkg/index.js': ESM,
      'src/app.ts': ESM,
    });
    const files = collectTsSourceFiles(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files.some((f) => f.endsWith('/src/app.js'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/worker.mjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/ui.jsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/legacy.cjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('.min.js'))).toBe(false);
    expect(files.some((f) => f.includes('app.test.js'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(countScriptFilesByLanguage(dir)).toEqual({ ts: 1, js: 4 });
    expect(countTsTestFiles(dir)).toBe(1); // app.test.js
  });
});
