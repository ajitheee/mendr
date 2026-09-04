import { describe, expect, it } from 'vitest';
import { sampleReport } from '../../test/sampleReport.js';
import { countDecisions, sanitizeReport, SNIPPET_MAX_CHARS, SNIPPET_MAX_LINES, validateReport } from './validate.js';

describe('validateReport', () => {
  it('accepts a mendr-audit/v3 document', () => {
    const v = validateReport(JSON.stringify(sampleReport()), 1_000_000);
    expect(v.ok).toBe(true);
  });

  it.each([
    ['not JSON', 'nope', 400, /not JSON/],
    ['wrong schema', JSON.stringify({ ...sampleReport(), schema: 'mendr-audit/v2' }), 400, /schema/],
    ['bad conclusion', JSON.stringify({ ...sampleReport(), conclusion: 'fine' }), 400, /conclusion/],
    ['unknown decision', JSON.stringify(sampleReport({ investigations: [{ ...sampleReport().investigations[0]!, decision: 'autofix' as never }] })), 400, /decision/],
    ['location without line', JSON.stringify(sampleReport({ investigations: [{ ...sampleReport().investigations[1]!, locations: { selectors: [{ file: 'x' } as never], catalog: [] } }] })), 400, /file\/line/],
  ])('rejects %s', (_name, raw, status, re) => {
    const v = validateReport(raw, 1_000_000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(status);
      expect(v.message).toMatch(re);
    }
  });

  it('rejects oversized bodies with 413 before parsing', () => {
    const v = validateReport(JSON.stringify(sampleReport()), 100);
    expect(v).toMatchObject({ ok: false, status: 413 });
  });
});

describe('sanitizeReport never trusts the client', () => {
  it('redacts credential-shaped strings everywhere and caps snippets to the CLI limits', () => {
    const report = sampleReport();
    const loc = report.investigations[0]!.locations.selectors[0]!;
    loc.snippet!.lines.push('x'.repeat(500), 'nine', 'ten');
    (report as Record<string, unknown>).note = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
    const out = sanitizeReport(report);
    const json = JSON.stringify(out);
    expect(json).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(json).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
    const s = out.investigations[0]!.locations.selectors[0]!.snippet!;
    expect(s.lines.length).toBe(SNIPPET_MAX_LINES);
    expect(Math.max(...s.lines.map((l) => l.length))).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(s.lines[3]).toContain('gpt-4');
    // The original is untouched.
    expect(report.investigations[0]!.locations.selectors[0]!.snippet!.lines.length).toBe(10);
  });

  it('drops prototype-polluting keys and non-JSON values', () => {
    const report = sampleReport();
    (report as Record<string, unknown>).__proto__x = 1;
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as Record<string, unknown>;
    (report as Record<string, unknown>).extra = raw;
    const out = sanitizeReport(report) as Record<string, unknown>;
    expect(Object.keys(out.extra as object)).toEqual([]);
  });
});

describe('countDecisions', () => {
  it('counts the three states separately', () => {
    expect(countDecisions(sampleReport())).toEqual({ patch: 1, review: 1, informational: 1 });
  });
});
