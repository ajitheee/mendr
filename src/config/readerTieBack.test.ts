import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfigReaders, looksLikeEnvVar } from './readerTieBack.js';

// Reader tie-back proves the one config→code link it can prove soundly: an
// env-var selector whose exact name is read in source. These pin what counts
// as an env-var key and where a read is (and is not) recognised.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-tieback-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('looksLikeEnvVar', () => {
  it('accepts UPPER_SNAKE names with an underscore, rejects generic and lowercase keys', () => {
    expect(looksLikeEnvVar('OPENAI_MODEL')).toBe(true);
    expect(looksLikeEnvVar('LLM_MODEL')).toBe(true);
    expect(looksLikeEnvVar('GEMINI_SUMMARIZE_MODEL')).toBe(true);
    expect(looksLikeEnvVar('model')).toBe(false);
    expect(looksLikeEnvVar('MODEL')).toBe(false); // no underscore: too generic
    expect(looksLikeEnvVar('modelName')).toBe(false);
    expect(looksLikeEnvVar(null)).toBe(false);
  });
});

describe('findConfigReaders — TypeScript / JavaScript', () => {
  it('finds process.env, bracket access, import.meta.env and Deno.env.get reads', () => {
    const dir = repo({
      'src/a.ts': 'export const m = process.env.OPENAI_MODEL ?? "gpt-4";\n',
      'src/b.js': 'const k = process.env["LLM_MODEL"];\nmodule.exports = { k };\n',
      'src/c.mjs': 'export const v = import.meta.env.VITE_MODEL;\n',
      'src/d.ts': 'export const d = Deno.env.get("DENO_MODEL");\n',
    });
    const readers = findConfigReaders(dir, ['OPENAI_MODEL', 'LLM_MODEL', 'VITE_MODEL', 'DENO_MODEL']);
    expect(readers.get('OPENAI_MODEL')?.[0]?.file).toMatch(/a\.ts$/);
    expect(readers.get('OPENAI_MODEL')?.[0]?.via).toContain('process.env.OPENAI_MODEL');
    expect(readers.get('LLM_MODEL')?.length).toBe(1);
    expect(readers.get('VITE_MODEL')?.length).toBe(1);
    expect(readers.get('DENO_MODEL')?.length).toBe(1);
  });

  it('does NOT match a mention inside a comment or an unrelated string (AST, not text)', () => {
    const dir = repo({
      'src/a.ts': '// reads process.env.OPENAI_MODEL somewhere\nconst note = "set process.env.OPENAI_MODEL in prod";\nexport const x = 1;\n',
    });
    expect(findConfigReaders(dir, ['OPENAI_MODEL']).has('OPENAI_MODEL')).toBe(false);
  });

  it('ignores keys that are not env-var shaped, even if present in code', () => {
    const dir = repo({ 'src/a.ts': 'export const m = process.env.model;\n' });
    expect(findConfigReaders(dir, ['model']).size).toBe(0);
  });
});

describe('findConfigReaders — Python', () => {
  it('finds os.getenv, os.environ.get and os.environ[] reads', () => {
    const dir = repo({
      'app.py': 'import os\nMODEL = os.getenv("OPENAI_MODEL", "gpt-4")\nOTHER = os.environ.get("LLM_MODEL")\nTHIRD = os.environ["GEMINI_MODEL"]\n',
    });
    const readers = findConfigReaders(dir, ['OPENAI_MODEL', 'LLM_MODEL', 'GEMINI_MODEL']);
    expect(readers.get('OPENAI_MODEL')?.[0]?.file).toMatch(/app\.py$/);
    expect(readers.get('LLM_MODEL')?.length).toBe(1);
    expect(readers.get('GEMINI_MODEL')?.length).toBe(1);
  });

  it('returns an empty map when no env-var keys are supplied', () => {
    const dir = repo({ 'app.py': 'x = 1\n' });
    expect(findConfigReaders(dir, ['model', 'temperature']).size).toBe(0);
  });
});
