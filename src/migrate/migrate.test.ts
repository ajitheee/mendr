import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { computeVerdict, runMigration, type GateOutcome } from './migrate.js';

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-migrate-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const CALL = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask(){\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n';
const g = (status: GateOutcome['status']): GateOutcome => ({ status });

describe('computeVerdict — a PR-ready verdict needs a real run, not just a type-check', () => {
  it('any failing gate is failed', () => {
    expect(computeVerdict(g('pass'), g('pass'), g('fail'), g('pass'))).toBe('failed');
    expect(computeVerdict(g('fail'), g('pass'), g('pass'), g('not-configured'))).toBe('failed');
  });
  it('a real run passing (build/tests/eval) with no failure is verified', () => {
    expect(computeVerdict(g('pass'), g('pass'), g('inconclusive'), g('not-configured'))).toBe('verified');
    expect(computeVerdict(g('pass'), g('not-configured'), g('pass'), g('not-configured'))).toBe('verified');
    expect(computeVerdict(g('inconclusive'), g('not-configured'), g('not-configured'), g('pass'))).toBe('verified');
  });
  it('type-check passing while nothing executable ran is inconclusive, not verified', () => {
    expect(computeVerdict(g('pass'), g('not-configured'), g('inconclusive'), g('not-configured'))).toBe('inconclusive');
    expect(computeVerdict(g('inconclusive'), g('inconclusive'), g('inconclusive'), g('not-configured'))).toBe('inconclusive');
  });
});

describe('runMigration — plan without touching the working tree', () => {
  it('reports no_migration on a clean repo', async () => {
    const dir = repo({ 'a.ts': 'export const x = 1;\n', 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true });
    expect(r.migrated).toBe(false);
    expect(r.verification.verdict).toBe('no_migration');
    expect(r.prReady).toBe(false);
  });

  it('plans the swap and emits a git-applyable diff, proving nothing under --skip-verify', async () => {
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true });
    expect(r.migrated).toBe(true);
    expect(r.migrations).toEqual([
      expect.objectContaining({ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 1, files: ['client.ts'] }),
    ]);
    expect(r.diff).toContain('-  return client.chat.completions.create({ model: "gpt-4", messages: [] });');
    expect(r.diff).toContain('+  return client.chat.completions.create({ model: "gpt-5.6-sol", messages: [] });');
    expect(r.verification.verdict).toBe('inconclusive');
    expect(r.prReady).toBe(false);
    // the file on disk is unchanged (verify-and-report only)
    expect(require('node:fs').readFileSync(join(dir, 'client.ts'), 'utf8')).toContain('"gpt-4"');
  });

  it('also plans JavaScript call sites (step 7 rides through the migration engine)', async () => {
    const dir = repo({ 'client.mjs': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true });
    expect(r.migrations[0]).toMatchObject({ from: 'gpt-4', to: 'gpt-5.6-sol', files: ['client.mjs'] });
  });
});

describe('runMigration — sandbox verification with real build/test scripts', () => {
  function verifiableRepo(testExit: 0 | 1): string {
    const dir = repo({
      'client.ts': CALL,
      'package.json': JSON.stringify({
        name: 't',
        version: '1.0.0',
        scripts: {
          build: 'node -e "process.exit(0)"',
          test: testExit === 0 ? 'node -e "console.log(\'1 passed\')"' : 'node -e "process.exit(1)"',
        },
      }),
    });
    // A non-empty node_modules so the build/test gates attempt to run (they
    // junction it; the fake scripts need nothing from it).
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.keep'), '');
    return dir;
  }

  it('VERIFIED and PR-ready when the sandbox build and tests pass', async () => {
    const r = await runMigration(verifiableRepo(0), REG, {});
    expect(r.verification.build.status).toBe('pass');
    expect(r.verification.tests.status).toBe('pass');
    expect(r.verification.verdict).toBe('verified');
    expect(r.prReady).toBe(true);
    expect(r.verification.behavioralTested).toBe(false); // no eval command
  }, 120_000);

  it('FAILED and not PR-ready when the sandbox tests fail', async () => {
    const r = await runMigration(verifiableRepo(1), REG, {});
    expect(r.verification.tests.status).toBe('fail');
    expect(r.verification.verdict).toBe('failed');
    expect(r.prReady).toBe(false);
  }, 120_000);

  it('--write applies to the working tree ONLY on a verified verdict', async () => {
    const dir = verifiableRepo(0);
    const before = require('node:fs').readFileSync(join(dir, 'client.ts'), 'utf8');
    expect(before).toContain('"gpt-4"');
    const r = await runMigration(dir, REG, { write: true });
    expect(r.verification.verdict).toBe('verified');
    expect(r.applied).toEqual(['client.ts']);
    expect(require('node:fs').readFileSync(join(dir, 'client.ts'), 'utf8')).toContain('"gpt-5.6-sol"');
  }, 120_000);

  it('--write writes NOTHING when a gate fails, leaving the tree untouched', async () => {
    const dir = verifiableRepo(1);
    const r = await runMigration(dir, REG, { write: true });
    expect(r.verification.verdict).toBe('failed');
    expect(r.applied).toEqual([]);
    expect(require('node:fs').readFileSync(join(dir, 'client.ts'), 'utf8')).toContain('"gpt-4"');
  }, 120_000);

  it('--write with --skip-verify proves nothing and applies nothing', async () => {
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { write: true, skipVerify: true });
    expect(r.applied).toEqual([]);
    expect(require('node:fs').readFileSync(join(dir, 'client.ts'), 'utf8')).toContain('"gpt-4"');
  });
});
