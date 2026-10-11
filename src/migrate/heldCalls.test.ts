import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { renderPrBody } from '../report/prBody.js';
import { runMigration } from './migrate.js';
import { renderMigrationReport } from './report.js';

// THE v0.5.10-alpha KNOWN ISSUE: `migrate` and the Action did not disclose held calls.
//
// A repository whose only findings were calls held for review got
// "NO MIGRATION — no verified Tier-A swap was found." with an empty `skipped` list, and the Action
// read that as clean and closed an open Mendr pull request with "no deprecated model ids remain".
// v0.5.10-alpha holds more calls (a `const` or `{ model }` request passing `max_tokens`, Python
// calls passing it), so it happened more often. These tests pin the fix at the migrate layer:
// every held call is listed with its reason code and the scanner's sentence, and a run whose
// retiring ids were all held has its own verdict, `held_for_review`, which is never `no_migration`.
//
// Hermetic: a three-record registry, temp-dir repositories, `skipVerify` (no sandbox runs).

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', on_models: ['o1', 'o3', 'gpt-5.6'] },
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-held-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** A request read through a const, passing `max_tokens`: held as `param_behaviour_change` on line 3. */
const HELD_TS = [
  'import OpenAI from "openai";',
  'const client = new OpenAI();',
  'const MODEL = "gpt-3.5-turbo";',
  'export async function ask() {',
  '  return client.chat.completions.create({ model: MODEL, max_tokens: 20, messages: [] });',
  '}',
  '',
].join('\n');

/** The same call in Python: held as `param_behaviour_change` on line 5. */
const HELD_PY = [
  'from openai import OpenAI',
  'client = OpenAI()',
  '',
  'def title(p):',
  '    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)',
  '',
].join('\n');

/** A plain call with nothing a rule reads: a Tier A swap. */
const PLAIN_TS = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function go(){\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n';

describe('a repository whose only findings are held calls', { timeout: 60_000 }, () => {
  it('is held_for_review, never no_migration, and lists every held call with its code and sentence', async () => {
    const dir = repo({ 'package.json': '{"name":"t"}', 'src/ask.ts': HELD_TS, 'app/llm.py': HELD_PY });
    const r = await runMigration(dir, REG, { skipVerify: true });

    expect(r.migrated).toBe(false);
    expect(r.diff).toBe('');
    expect(r.verification.verdict).toBe('held_for_review');
    expect(r.prReady).toBe(false);
    expect(r.skipped.map((s) => [s.file, s.line, s.model, s.code, s.language])).toEqual([
      ['app/llm.py', 5, 'gpt-3.5-turbo', 'param_behaviour_change', 'py'],
      ['src/ask.ts', 3, 'gpt-3.5-turbo', 'param_behaviour_change', 'ts'],
    ]);
    for (const s of r.skipped) {
      expect(s.replacement).toBe('gpt-5.6-terra');
      // The scanner's own sentence, which names the parameter, not only the generic one.
      expect(s.reason).toContain('max_tokens');
    }
    expect(r.notes.join('\n')).toContain('2 places in the code use a retiring model id that Mendr held for a person to review');
  });

  it('says so in the human report, call by call, and never says NO MIGRATION', async () => {
    const dir = repo({ 'package.json': '{"name":"t"}', 'src/ask.ts': HELD_TS, 'app/llm.py': HELD_PY });
    const text = renderMigrationReport(await runMigration(dir, REG, { skipVerify: true })).join('\n');

    expect(text).toContain('HELD FOR REVIEW — nothing was migrated, and this repository is not clean');
    expect(text).toContain('Held for review (2)');
    expect(text).toContain('  src/ask.ts:3  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]');
    expect(text).toContain('  app/llm.py:5  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]');
    expect(text).not.toContain('NO MIGRATION');
  });

  it('is held_for_review under --only when the approved model is the held one, and no_migration when it is not', async () => {
    const files = { 'package.json': '{"name":"t"}', 'src/ask.ts': HELD_TS };
    const approvedHeld = await runMigration(repo(files), REG, { skipVerify: true, only: ['gpt-3.5-turbo'] });
    expect(approvedHeld.verification.verdict).toBe('held_for_review');
    expect(approvedHeld.skipped.map((s) => s.model)).toEqual(['gpt-3.5-turbo']);

    // The run looked at gpt-4 only, and there is none: nothing to migrate for what was approved.
    const approvedOther = await runMigration(repo(files), REG, { skipVerify: true, only: ['gpt-4'] });
    expect(approvedOther.verification.verdict).toBe('no_migration');
    expect(approvedOther.skipped).toEqual([]);
  });
});

describe('a repository with nothing held', { timeout: 60_000 }, () => {
  it('with no retiring id is no_migration, with an empty list', async () => {
    const r = await runMigration(repo({ 'package.json': '{"name":"t"}', 'a.ts': 'export const x = 1;\n' }), REG, { skipVerify: true });
    expect(r.verification.verdict).toBe('no_migration');
    expect(r.skipped).toEqual([]);
    expect(renderMigrationReport(r).join('\n')).toContain('NO MIGRATION — no verified Tier-A swap was found, and nothing was held for review.');
  });

  it('with a retiring id only as data (a list of ids) is no_migration: Tier C is informational, not held', async () => {
    const r = await runMigration(repo({ 'package.json': '{"name":"t"}', 'models.ts': 'export const KNOWN_MODELS = ["gpt-4", "gpt-3.5-turbo"];\n' }), REG, { skipVerify: true });
    expect(r.verification.verdict).toBe('no_migration');
    expect(r.skipped).toEqual([]);
  });
});

describe('a migration that also holds calls', { timeout: 60_000 }, () => {
  it('swaps the plain call and lists the held one in the report and the pull request body', async () => {
    const dir = repo({ 'package.json': '{"name":"t"}', 'src/go.ts': PLAIN_TS, 'src/ask.ts': HELD_TS });
    const r = await runMigration(dir, REG, { skipVerify: true });

    expect(r.migrated).toBe(true);
    expect(r.migrations.map((m) => [m.from, m.to, m.files])).toEqual([['gpt-4', 'gpt-5.6-sol', ['src/go.ts']]]);
    expect(r.diff).not.toContain('src/ask.ts');
    expect(r.skipped.map((s) => [s.file, s.line, s.code])).toEqual([['src/ask.ts', 3, 'param_behaviour_change']]);

    expect(renderMigrationReport(r).join('\n')).toContain('Held for review (1)');
    const body = renderPrBody(r);
    expect(body).toContain('**Left alone (1)**');
    expect(body).toContain('merging this pull request does not resolve them');
    expect(body).toContain('- `src/ask.ts:3` `gpt-3.5-turbo` (`param_behaviour_change`) — ');
  });
});

describe('the held list goes through the sanitizer like the rest of the report', { timeout: 60_000 }, () => {
  // The no-migration report used to return before the sanitizer chokepoint. It carried no text
  // from the repository then; now it lists held calls by path, so it must pass through it too.
  it('redacts a credential-shaped path in a held-only report', async () => {
    const canary = 'ghp_MENDRCANARY00000000000000000000';
    const dir = repo({ 'package.json': '{"name":"t"}', [`${canary}/ask.ts`]: HELD_TS });
    const r = await runMigration(dir, REG, { skipVerify: true });
    expect(r.verification.verdict).toBe('held_for_review');
    const text = renderMigrationReport(r).join('\n');
    expect(text).toContain('Held for review (1)');
    expect(text).not.toContain('MENDRCANARY');
  });
});
