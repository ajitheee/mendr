import { describe, expect, it } from 'vitest';
import { MAX_MIGRATIONS, MAX_NOTES, MIGRATION_REPORT_SCHEMA, prNumber, validateMigrationReport } from './migrationReport.js';

// The migration report is WHITELISTED: whatever the action (or anyone holding a
// valid run token) sends, only the named fields survive, redacted and capped.

const SHA = 'a'.repeat(40);
function full(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: MIGRATION_REPORT_SCHEMA,
    outcome: 'migration-proposed',
    prUrl: 'https://github.com/acme/api/pull/12',
    sha: SHA,
    generatedAt: '2026-09-07T07:00:00Z',
    verdict: 'verified',
    gates: { typeCheck: 'passed', build: 'not_run', tests: 'passed', eval: 'not_run' },
    behavioralTested: false,
    migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 2, files: ['src/ai.ts', 'src/summarize.ts'] }],
    changedFiles: ['src/ai.ts', 'src/summarize.ts'],
    notes: ['Behavior was not verified.'],
    ...over,
  };
}
const ok = (v: ReturnType<typeof validateMigrationReport>) => {
  if (!v.ok) throw new Error(v.message);
  return v.report;
};

describe('validateMigrationReport', () => {
  it('keeps exactly the whitelisted fields of a full report', () => {
    const r = ok(validateMigrationReport(JSON.stringify(full()), 1_000_000));
    expect(r).toEqual({
      schema: MIGRATION_REPORT_SCHEMA,
      outcome: 'migration-proposed',
      prUrl: 'https://github.com/acme/api/pull/12',
      branch: null,
      sha: SHA,
      generatedAt: '2026-09-07T07:00:00Z',
      verdict: 'verified',
      gates: { typeCheck: 'passed', build: 'not_run', tests: 'passed', eval: 'not_run' },
      behavioralTested: false,
      migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 2, files: ['src/ai.ts', 'src/summarize.ts'] }],
      changedFiles: ['src/ai.ts', 'src/summarize.ts'],
      heldForReview: null,
      notes: ['Behavior was not verified.'],
      diff: null,
      registry: null,
    });
  });

  // v0.5.10-alpha known issue: a run whose only findings were held calls was reported as `clean`,
  // and the App closed the approval as "nothing left to migrate". The action now reports
  // `held-for-review` with a count, and the App takes the count over the word.
  it('accepts a held-for-review run with its count, and never reads it as clean', () => {
    const held = ok(
      validateMigrationReport(
        JSON.stringify(full({ outcome: 'held-for-review', verdict: 'held_for_review', prUrl: null, migrations: [], changedFiles: [], heldForReview: 3 })),
        1_000_000,
      ),
    );
    expect(held).toMatchObject({ outcome: 'held-for-review', verdict: 'held_for_review', heldForReview: 3, prUrl: null });

    // A `clean` that carries held calls is not clean.
    expect(ok(validateMigrationReport(JSON.stringify(full({ outcome: 'clean', verdict: 'no_migration', heldForReview: 2 })), 1_000_000)).outcome).toBe('held-for-review');
    // A clean run with nothing held stays clean; an older action that sent no count stays as it said.
    expect(ok(validateMigrationReport(JSON.stringify(full({ outcome: 'clean', verdict: 'no_migration', heldForReview: 0 })), 1_000_000)).outcome).toBe('clean');
    expect(ok(validateMigrationReport(JSON.stringify(full({ outcome: 'clean', verdict: 'no_migration' })), 1_000_000))).toMatchObject({ outcome: 'clean', heldForReview: null });
  });

  it('keeps the held count only as a bounded whole number, never a list', () => {
    const count = (v: unknown) => ok(validateMigrationReport(JSON.stringify(full({ heldForReview: v })), 1_000_000)).heldForReview;
    expect(count(0)).toBe(0);
    expect(count(12)).toBe(12);
    expect(count(-1)).toBeNull();
    expect(count(2.5)).toBeNull();
    expect(count('4')).toBeNull();
    expect(count(10_000_001)).toBeNull();
    // The list itself is not part of the report: it carries file paths and the scanner's
    // sentences, and the App has every held call from the audit already.
    const r = ok(validateMigrationReport(JSON.stringify(full({ heldForReview: [{ file: 'src/a.ts', line: 3 }], skipped: [{ file: 'src/a.ts' }] })), 1_000_000));
    expect(r.heldForReview).toBeNull();
    expect(JSON.stringify(r)).not.toContain('src/a.ts');
  });

  it('still refuses an outcome it does not know', () => {
    const v = validateMigrationReport(JSON.stringify(full({ outcome: 'held' })), 1_000_000);
    expect(v.ok).toBe(false);
  });

  it('keeps the registry provenance field by field, and drops a malformed one whole', () => {
    const registry = { source: 'snapshot', version: 'sha256:0123456789abcdef', publishedAt: '2026-09-09T04:00:00Z', ageDays: 0.44, maxAgeDays: 14, freshness: 'fresh', extra: 'dropped' };
    const r = ok(validateMigrationReport(JSON.stringify(full({ registry })), 1_000_000));
    expect(r.registry).toEqual({ source: 'snapshot', version: 'sha256:0123456789abcdef', publishedAt: '2026-09-09T04:00:00Z', ageDays: 0.4, maxAgeDays: 14, freshness: 'fresh' });
    expect(ok(validateMigrationReport(JSON.stringify(full({ registry: { ...registry, source: 'internet' } })), 1_000_000)).registry).toBeNull();
    expect(ok(validateMigrationReport(JSON.stringify(full({ registry: { ...registry, freshness: 'fresh-ish' } })), 1_000_000)).registry).toBeNull();
    expect(ok(validateMigrationReport(JSON.stringify(full({ registry: 'sha256:abc' })), 1_000_000)).registry).toBeNull();
    const unknownAge = ok(validateMigrationReport(JSON.stringify(full({ registry: { ...registry, source: 'file', publishedAt: null, ageDays: 'n/a', freshness: 'stale' } })), 1_000_000)).registry;
    expect(unknownAge).toMatchObject({ source: 'file', publishedAt: null, ageDays: -1, freshness: 'stale' });
  });

  it('keeps the swap\'s diff — only when it is shaped like one — and drops every unknown key', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-model: "gpt-4"\n+model: "gpt-5.6-sol"';
    const r = ok(validateMigrationReport(JSON.stringify(full({ diff, applied: ['x'], extra: { nested: true } })), 1_000_000));
    expect(r.diff).toBe(diff);
    const json = JSON.stringify(r);
    expect(json).not.toContain('applied');
    expect(json).not.toContain('nested');
    // a file's contents dressed up as "diff" are not kept
    expect(ok(validateMigrationReport(JSON.stringify(full({ diff: 'export const key = "sk-live";\n' })), 1_000_000)).diff).toBeNull();
    expect(ok(validateMigrationReport(JSON.stringify(full({ diff: '' })), 1_000_000)).diff).toBeNull();
    expect(ok(validateMigrationReport(JSON.stringify(full({ diff: 42 })), 1_000_000)).diff).toBeNull();
  });

  it('redacts secrets in the diff and caps it with a visible mark', () => {
    const leaky = 'diff --git a/x b/x\n+  apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"\n';
    expect(ok(validateMigrationReport(JSON.stringify(full({ diff: leaky })), 1_000_000)).diff).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    const huge = `diff --git a/x b/x\n${'+x\n'.repeat(60_000)}`;
    const capped = ok(validateMigrationReport(JSON.stringify(full({ diff: huge })), 10_000_000)).diff ?? '';
    expect(capped.length).toBeLessThan(101_000);
    expect(capped.endsWith('… (truncated by Mendr at 100000 characters)')).toBe(true);
  });

  it('redacts secrets and caps text in the fields it keeps', () => {
    const r = ok(validateMigrationReport(JSON.stringify(full({ notes: ['key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 leaked', 'x'.repeat(2000)] })), 1_000_000));
    expect(r.notes[0]).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.notes[0]).toContain('REDACTED');
    expect(r.notes[1]!.length).toBeLessThanOrEqual(400);
  });

  it('caps the lists', () => {
    const migrations = Array.from({ length: MAX_MIGRATIONS + 5 }, (_, i) => ({ provider: 'openai', from: `m${i}`, to: 'n', language: 'ts', sites: 1, files: [] }));
    const notes = Array.from({ length: MAX_NOTES + 5 }, (_, i) => `note ${i}`);
    const r = ok(validateMigrationReport(JSON.stringify(full({ migrations, notes })), 10_000_000));
    expect(r.migrations.length).toBe(MAX_MIGRATIONS);
    expect(r.notes.length).toBe(MAX_NOTES);
  });

  it('tolerates a minimal error report (no artifact) and normalizes odd values', () => {
    const r = ok(validateMigrationReport(JSON.stringify({ schema: MIGRATION_REPORT_SCHEMA, outcome: 'error', sha: 'not-a-sha', generatedAt: 'yesterday', gates: { typeCheck: 'bogus' }, migrations: [{ provider: 'x' }, 'junk'] }), 1_000_000));
    expect(r).toMatchObject({ outcome: 'error', prUrl: null, sha: null, generatedAt: null, verdict: null, behavioralTested: false, migrations: [], changedFiles: [], notes: [] });
    // An unrecognized word and three absent ones all land on `inconclusive`,
    // not on `not_run`. The App cannot know there was nothing to run; it only
    // knows the report did not say. The old default claimed the former.
    expect(r.gates).toEqual({ typeCheck: 'inconclusive', build: 'inconclusive', tests: 'inconclusive', eval: 'inconclusive' });
  });

  it('still accepts a report from a CLI that predates the vocabulary merge', () => {
    // Customers pin the CLI in a workflow file committed to their own repo, so
    // the old four words keep arriving long after the tag moves. Dropping them
    // would blank a real dashboard.
    const r = ok(validateMigrationReport(JSON.stringify(full({ gates: { typeCheck: 'pass', build: 'not-configured', tests: 'fail', eval: 'inconclusive' } })), 1_000_000));
    expect(r.gates).toEqual({ typeCheck: 'passed', build: 'not_run', tests: 'failed', eval: 'inconclusive' });
  });

  it.each([
    ['not JSON', 'nope', 400, /not JSON/],
    ['an array', '[]', 400, /not a JSON object/],
    ['the wrong schema', JSON.stringify(full({ schema: 'mendr-audit/v3' })), 400, /schema must be/],
    ['an unknown outcome', JSON.stringify(full({ outcome: 'merged' })), 400, /outcome/],
    ['a non-PR url', JSON.stringify(full({ prUrl: 'https://evil.example/login' })), 400, /prUrl/],
    ['a javascript: url', JSON.stringify(full({ prUrl: 'javascript:alert(1)' })), 400, /prUrl/],
  ])('rejects %s', (_n, raw, status, re) => {
    const v = validateMigrationReport(raw, 1_000_000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(status);
      expect(v.message).toMatch(re);
    }
  });

  it('refuses an oversized body before parsing', () => {
    const v = validateMigrationReport(JSON.stringify(full()), 50);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(413);
  });
});

describe('prNumber', () => {
  it('extracts #N from a pull request url', () => {
    expect(prNumber('https://github.com/acme/api/pull/12')).toBe('#12');
    expect(prNumber('https://github.com/acme/api')).toBe('');
  });
});
