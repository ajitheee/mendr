import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { computeVerdict, runMigration, type GateOutcome, type MigrationRegistryInfo } from './migrate.js';
import { renderMigrationReport } from './report.js';

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
// Gate statuses are THE one vocabulary (src/gates/status.ts):
//   passed | failed | skipped | not_run | inconclusive
// The words migrate used to speak privately — `pass`, `fail`, `not-configured` —
// no longer exist, here or on any other surface.
const g = (status: GateOutcome['status']): GateOutcome => ({ status });

describe('computeVerdict — a PR-ready verdict needs a real run, not just a type-check', () => {
  it('any failing gate is failed', () => {
    expect(computeVerdict(g('passed'), g('passed'), g('failed'), g('passed'))).toBe('failed');
    expect(computeVerdict(g('failed'), g('passed'), g('passed'), g('not_run'))).toBe('failed');
  });
  it('a real run passing (build/tests/eval) with no failure is verified', () => {
    expect(computeVerdict(g('passed'), g('passed'), g('inconclusive'), g('not_run'))).toBe('verified');
    expect(computeVerdict(g('passed'), g('not_run'), g('passed'), g('not_run'))).toBe('verified');
    expect(computeVerdict(g('inconclusive'), g('not_run'), g('not_run'), g('passed'))).toBe('verified');
  });
  it('type-check passing while nothing executable ran is inconclusive, not verified', () => {
    expect(computeVerdict(g('passed'), g('not_run'), g('inconclusive'), g('not_run'))).toBe('inconclusive');
    expect(computeVerdict(g('inconclusive'), g('inconclusive'), g('inconclusive'), g('not_run'))).toBe('inconclusive');
    // `skipped` — we CHOSE not to run the gate (--skip-gates, policy) — is a
    // different silence from `not_run`, and neither may ever stand in for the
    // real pass a `verified` verdict requires.
    expect(computeVerdict(g('passed'), g('skipped'), g('skipped'), g('skipped'))).toBe('inconclusive');
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
  // The passing test script PRINTS A PARSEABLE SUMMARY ("1 passed") on purpose,
  // and that is now load-bearing: a command that merely exits 0 proves nothing
  // and is `inconclusive` (see the exit-0 test below). This fixture is the case
  // where a suite demonstrably ran, which is the only thing `passed` may mean.
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
    expect(r.verification.build.status).toBe('passed');
    expect(r.verification.tests.status).toBe('passed');
    expect(r.verification.verdict).toBe('verified');
    expect(r.prReady).toBe(true);
    expect(r.verification.behavioralTested).toBe(false); // no eval command
  }, 120_000);

  it('FAILED and not PR-ready when the sandbox tests fail', async () => {
    const r = await runMigration(verifiableRepo(1), REG, {});
    expect(r.verification.tests.status).toBe('failed');
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

  // BEHAVIOUR CHANGE: a test command that exits 0 without parseable results is
  // `inconclusive`, never `passed`. `"test": "exit 0"` used to be enough to make
  // a migration `verified` and PR-ready, with a pull-request body that told the
  // reviewer "your tests: passed" — when nobody's tests had run. `passed` now
  // requires a parsed summary with at least one test in it, and the gate carries
  // a `note` saying why it could not conclude.
  it('a test script that exits 0 without running a test is INCONCLUSIVE, so the migration is never PR-ready on it', async () => {
    const dir = repo({
      'client.ts': CALL,
      'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    // node_modules so the command genuinely RUNS: the inconclusive below has to
    // come from its unparseable output, not from a missing dependency tree
    // (which is inconclusive for an entirely different reason).
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.keep'), '');
    const r = await runMigration(dir, REG, {});
    expect(r.verification.tests.status).toBe('inconclusive');
    expect(r.verification.tests.detail).toContain('no test results could be parsed');
    expect(r.verification.verdict).not.toBe('verified');
    expect(r.prReady).toBe(false);
  }, 120_000);

  // BEHAVIOUR CHANGE: "no test script" is `not_run` — there was nothing to run,
  // and no amount of installing or retrying changes it — which is a different
  // state from `inconclusive` ("we tried and cannot say"). The two used to be
  // folded together here, and the caller recovered the difference by comparing
  // the gate's output against the literal string 'no test script'.
  it('a repo with no test script reports the test gate as NOT RUN, not inconclusive', async () => {
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, {});
    expect(r.verification.tests.status).toBe('not_run');
    expect(r.verification.tests.detail).toBe('no test script');
    expect(r.verification.build.status).toBe('not_run'); // no build script either
    // Nothing executable ran, so nothing was proven — whatever the type-check said.
    expect(r.verification.verdict).toBe('inconclusive');
    expect(r.prReady).toBe(false);
  }, 120_000);
});

describe('the registry the plan used rides in the artifact, and a stale one is called out', () => {
  const stale: MigrationRegistryInfo = { source: 'bundled', version: 'sha256:0123456789abcdef', publishedAt: '2026-08-01T00:00:00Z', ageDays: 39, maxAgeDays: 14, freshness: 'stale' };
  const fresh: MigrationRegistryInfo = { ...stale, source: 'snapshot', publishedAt: '2026-09-09T04:00:00Z', ageDays: 0.4, freshness: 'fresh' };

  it('records the provenance and adds the STALE note, in the human report too', async () => {
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true, registry: stale });
    expect(r.registry).toEqual(stale);
    expect(r.notes.some((n) => /STALE: a newer retirement or replacement may exist/.test(n))).toBe(true);
    const text = renderMigrationReport(r).join('\n');
    expect(text).toContain('Registry: bundled sha256:0123456789abcdef published 2026-08-01 — STALE (39 days old, max 14)');
  });

  it('a fresh registry is recorded without a warning; no registry given = nothing claimed', async () => {
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true, registry: fresh });
    expect(r.registry).toEqual(fresh);
    expect(r.notes.some((n) => /STALE/.test(n))).toBe(false);
    const none = await runMigration(dir, REG, { skipVerify: true });
    expect(none.registry).toBeUndefined();
    expect(renderMigrationReport(none).join('\n')).not.toContain('Registry:');
  });

  it('a clean repo still states a stale registry — absence of a migration is not proof either', async () => {
    const dir = repo({ 'a.ts': 'export const x = 1;\n', 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, { skipVerify: true, registry: stale });
    expect(r.migrated).toBe(false);
    expect(r.registry).toEqual(stale);
    expect(r.notes.some((n) => /STALE/.test(n))).toBe(true);
  });
});

// LEFT FAILING ON PURPOSE — a half-applied behaviour change, not a wording slip.
//
// V4 of MILESTONE-EXTERNAL-VALIDATION.md: a type-check that ran with the SDK
// types unresolved could not have failed, so it is `inconclusive`, never
// `passed`. `fix-llm` implements exactly that (`src/cli.ts:1102` —
// `typeResult.passed ? (ranBlind ? 'inconclusive' : 'passed') : 'failed'`).
// `migrate` was renamed into the new vocabulary but NOT converted: it still does
// `typeResult.passed ? 'passed' : 'failed'` (`src/migrate/migrate.ts:448`) and
// leaves the scope in a DETAIL string — the one surface V4 says gets dropped
// downstream (suppressed on the PR-body row, discarded by the App). So the two
// paths still print opposite words for the same dependency-less checkout, which
// V2 says they must not.
//
// Closing it is a one-line change in src/migrate/migrate.ts, which this agent is
// not permitted to make. The test states the rule the milestone requires rather
// than pinning the behaviour the milestone calls wrong.
describe('SUSPECTED GAP — migrate still reports a BLIND type-check as passed', () => {
  it('the type-check on a dependency-less checkout is inconclusive, with the unresolved package still named', async () => {
    // No node_modules: the `openai` types that would reject a bad model id are
    // not loaded, so nothing this gate looked at could have failed.
    const dir = repo({ 'client.ts': CALL, 'package.json': '{"name":"t"}' });
    const r = await runMigration(dir, REG, {});
    expect(r.verification.typeCheck.status).toBe('inconclusive');
    // Whatever the state, the packages stay named — the state must carry what
    // the detail string used to.
    expect(`${r.verification.typeCheck.detail ?? ''}\n${r.notes.join('\n')}`).toContain('openai');
    expect(r.verification.verdict).not.toBe('verified');
  }, 120_000);
});
