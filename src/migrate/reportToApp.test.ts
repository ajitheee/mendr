import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_SCHEMA, type MigrationResult } from './migrate.js';

// CROSS-PACKAGE: what mendr-action sends to the App is built by
// mendr-action/scripts/build-report.mjs from the REAL migration artifact this
// package emits, and consumed by the App's REAL validator. This wires the three
// together so a field rename on any side fails here, not in a customer's CI —
// and proves exactly what leaves the runner: the swap's diff for display (unless
// withheld), never the CLI's internals.

import { validateMigrationReport } from '../../app/src/ingest/migrationReport.js';

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDER = join(MENDR_ROOT, 'mendr-action', 'scripts', 'build-report.mjs');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function artifact(): MigrationResult {
  return {
    schema: MIGRATION_SCHEMA,
    generatedBy: 'mendr',
    repo: 'acme/api',
    generatedAt: '2026-09-07T07:00:00Z',
    sha: 'a'.repeat(40),
    migrated: true,
    migrations: [{ provider: 'openai', model: 'gpt-4', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 2, files: ['src/ai.ts'] }],
    changedFiles: ['src/ai.ts'],
    diff: 'diff --git a/src/ai.ts b/src/ai.ts\n--- a/src/ai.ts\n+++ b/src/ai.ts\n-  model: "gpt-4",\n+  model: "gpt-5.6-sol",\n',
    verification: {
      // The words the CLI ACTUALLY emits (src/gates/status.ts). These were
      // hand-written in the old four-word vocabulary for a full release cycle
      // after the CLI stopped using it — and because tsconfig.json excludes
      // test files, tsc never saw the mismatch. That is how a cross-package
      // contract test stayed green over a broken contract.
      typeCheck: { status: 'passed' },
      build: { status: 'not_run', detail: 'no build script' },
      tests: { status: 'passed', command: 'npm test' },
      eval: { status: 'not_run' },
      behavioralTested: false,
      verdict: 'verified',
    },
    prReady: true,
    notes: ['Behavior was NOT verified: the gates prove it builds and your tests pass.'],
    applied: ['src/ai.ts'],
  };
}

function build(artifactPath: string, outcome: string, prUrl: string, env: Record<string, string> = {}): unknown {
  const out = execFileSync(process.execPath, [BUILDER, artifactPath, outcome, prUrl], { encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(out);
}

describe('mendr-action → App migration report', () => {
  it('builds a report the App accepts, carrying the outcome, PR, verdict, gates and swaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-report-'));
    created.push(dir);
    const path = join(dir, 'mendr-migration.json');
    writeFileSync(path, JSON.stringify(artifact()));
    const raw = JSON.stringify(build(path, 'migration-proposed', 'https://github.com/acme/api/pull/12'));
    const v = validateMigrationReport(raw, 1_000_000);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report).toMatchObject({
      outcome: 'migration-proposed',
      prUrl: 'https://github.com/acme/api/pull/12',
      sha: 'a'.repeat(40),
      verdict: 'verified',
      gates: { typeCheck: 'passed', build: 'not_run', tests: 'passed', eval: 'not_run' },
      behavioralTested: false,
      migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 2, files: ['src/ai.ts'] }],
      changedFiles: ['src/ai.ts'],
    });
  });

  it('carries a FAILED gate all the way to the App, as a failure', () => {
    // The regression this file exists to catch and did not. The CLI's five
    // words landed in src/ only; the App kept its own four-word list and
    // coerced everything it did not recognize to `not-configured`, which it
    // renders as "—". A build that ran and REJECTED the change was shown to
    // the customer as "there was nothing to run" — on the one surface an
    // external reviewer logs into. Every one of the five words must survive
    // the artifact → build-report.mjs → validator chain intact.
    const dir = mkdtempSync(join(tmpdir(), 'mendr-report-'));
    created.push(dir);
    const path = join(dir, 'mendr-migration.json');
    const a = artifact();
    a.verification = {
      ...a.verification,
      typeCheck: { status: 'passed' },
      build: { status: 'failed', detail: 'tsc exited 2' },
      tests: { status: 'inconclusive', detail: 'no installed node_modules' },
      eval: { status: 'skipped' },
      verdict: 'failed',
    };
    writeFileSync(path, JSON.stringify(a));
    const v = validateMigrationReport(JSON.stringify(build(path, 'pr-blocked', '')), 1_000_000);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.gates).toEqual({ typeCheck: 'passed', build: 'failed', tests: 'inconclusive', eval: 'skipped' });
  });

  it('carries the swap\'s diff for display — and the App keeps it as a diff — but never the CLI\'s internals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-report-'));
    created.push(dir);
    const path = join(dir, 'mendr-migration.json');
    writeFileSync(path, JSON.stringify(artifact()));
    const raw = JSON.stringify(build(path, 'migration-proposed', ''));
    expect(raw).toContain('diff --git a/src/ai.ts');
    expect(raw).not.toContain('"applied"');
    expect(raw).not.toContain('"prReady"');
    const v = validateMigrationReport(raw, 1_000_000);
    expect(v.ok && v.report.diff).toContain('+  model: "gpt-5.6-sol",');
  });

  it('withholds the diff when the workflow says send-diff: false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-report-'));
    created.push(dir);
    const path = join(dir, 'mendr-migration.json');
    writeFileSync(path, JSON.stringify(artifact()));
    const raw = JSON.stringify(build(path, 'migration-proposed', '', { MENDR_SEND_DIFF: 'false' }));
    expect(raw).not.toContain('diff --git');
    expect(raw).not.toContain('model: "gpt-4"');
    expect(raw).toContain('"diff":null');
  });

  it('reports an error outcome even with no artifact at all', () => {
    const v = validateMigrationReport(JSON.stringify(build('', 'error', '')), 1_000_000);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.report).toMatchObject({ outcome: 'error', prUrl: null, sha: null, verdict: null, gates: null, migrations: [], changedFiles: [], notes: [] });
  });
});
