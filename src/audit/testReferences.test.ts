import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { findTestReferences } from './testReferences.js';

// Test-only references: a retiring id in a test/spec/fixture file is surfaced,
// but ALWAYS Tier C and flagged testFile — never a migration candidate.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-testref-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('findTestReferences', () => {
  it('finds retiring ids in TS/JS and Python test files, all Tier C + testFile', () => {
    const dir = repo({
      'src/app.test.ts': 'import OpenAI from "openai";\nconst c = new OpenAI();\ntest("x", async () => { await c.chat.completions.create({ model: "gpt-4", messages: [] }); });\n',
      'tests/thing_test.py': 'import openai\ndef test_x():\n    openai.chat.completions.create(model="gpt-3.5-turbo")\n',
    });
    const refs = findTestReferences(dir, REG);
    const byModel = Object.fromEntries(refs.map((r) => [r.value, r]));
    expect(refs.every((r) => r.tier === 'C' && r.testFile === true)).toBe(true);
    expect(byModel['gpt-4']?.file).toMatch(/app\.test\.ts$/);
    expect(byModel['gpt-3.5-turbo']?.file).toMatch(/thing_test\.py$/);
  });

  it('does NOT pick up production files (only test/spec/fixture paths)', () => {
    const dir = repo({
      'src/app.ts': 'import OpenAI from "openai";\nconst c = new OpenAI();\nexport const f = () => c.chat.completions.create({ model: "gpt-4", messages: [] });\n',
    });
    expect(findTestReferences(dir, REG)).toEqual([]);
  });

  it('ignores a mention inside a comment (AST string literals only, TS)', () => {
    const dir = repo({ 'src/x.test.ts': '// uses "gpt-4" somewhere\nexport const n = 1;\n' });
    expect(findTestReferences(dir, REG)).toEqual([]);
  });

  it('matches a provider-prefixed id form in a test file', () => {
    const dir = repo({ 'src/x.spec.ts': 'export const m = "openai/gpt-4";\n' });
    const refs = findTestReferences(dir, REG);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ value: 'openai/gpt-4', tier: 'C', testFile: true });
    expect(refs[0]!.entry.deprecated).toBe('gpt-4');
  });
});
