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
    gates: { typeCheck: 'pass', build: 'not-configured', tests: 'pass', eval: 'not-configured' },
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
      sha: SHA,
      generatedAt: '2026-09-07T07:00:00Z',
      verdict: 'verified',
      gates: { typeCheck: 'pass', build: 'not-configured', tests: 'pass', eval: 'not-configured' },
      behavioralTested: false,
      migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 2, files: ['src/ai.ts', 'src/summarize.ts'] }],
      changedFiles: ['src/ai.ts', 'src/summarize.ts'],
      notes: ['Behavior was not verified.'],
      diff: null,
    });
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
    expect(r.gates).toEqual({ typeCheck: 'not-configured', build: 'not-configured', tests: 'not-configured', eval: 'not-configured' });
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
