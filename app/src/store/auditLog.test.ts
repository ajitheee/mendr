import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory.js';
import { sanitizeDetail, sanitizeEntry } from './auditLog.js';

describe('audit-log sanitizer — never findings, secrets or source', () => {
  it('keeps scalars and drops objects/arrays that could carry content', () => {
    const clean = sanitizeDetail({
      count: 3,
      ok: true,
      conclusion: 'exposure_detected',
      nothing: null,
      report: { investigations: [{ model: 'gpt-4', snippet: 'const k = "sk-secret"' }] }, // dropped
      files: ['src/private.ts'], // dropped
    });
    expect(clean).toEqual({ count: 3, ok: true, conclusion: 'exposure_detected', nothing: null });
    expect(JSON.stringify(clean)).not.toContain('sk-secret');
    expect(JSON.stringify(clean)).not.toContain('private.ts');
  });

  it('truncates long strings and repo/actor', () => {
    const e = sanitizeEntry({ event: 'audit_received', installationId: 1, repo: 'a'.repeat(500), actor: 'b'.repeat(500), detail: { s: 'c'.repeat(500) } });
    expect(e.repo!.length).toBe(200);
    expect(e.actor!.length).toBe(200);
    expect((e.detail.s as string).length).toBe(200);
  });
});

describe('MemoryStore audit log', () => {
  it('appends and lists events newest-first, scoped by installation', async () => {
    const s = new MemoryStore();
    await s.appendAuditLog({ event: 'installation_connected', installationId: 1, repo: null, actor: 'octocat', detail: { repositories: 2 } });
    await s.appendAuditLog({ event: 'audit_received', installationId: 1, repo: 'acme/api', actor: 'ci', detail: { conclusion: 'exposure_detected', patch: 1 } });
    await s.appendAuditLog({ event: 'audit_received', installationId: 2, repo: 'other/x', actor: 'ci', detail: {} });
    const all = await s.listAuditLog();
    expect(all.map((e) => e.event)).toEqual(['audit_received', 'audit_received', 'installation_connected']);
    const one = await s.listAuditLog({ installationId: 1 });
    expect(one.map((e) => e.repo)).toEqual(['acme/api', null]);
    expect(one[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
