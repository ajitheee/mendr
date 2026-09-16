import { describe, expect, it } from 'vitest';
import type { Finding } from '../audit/fingerprint.js';
import { fingerprint, identityOf } from '../audit/fingerprint.js';
import {
  applySuppressions,
  formatSuppressionLines,
  isExpired,
  parseSuppressions,
  SUPPRESSIONS_SCHEMA,
  type Suppression,
  type SuppressionFile,
} from './suppress.js';

// A scanner nobody can argue with is a scanner people turn off. Suppression is how the person
// who owns the code says "I looked, this is not a dependency" in a file their colleagues review.
// Everything below exists to keep that from becoming a way to hide a real exposure.

function finding(path: string, model: string, line = 10): Finding {
  const identity = identityOf({
    provider: 'openai',
    model,
    path,
    key: null,
    evidenceType: 'code_call_site',
  });
  return {
    fingerprint: fingerprint(identity),
    provider: 'openai',
    model,
    path,
    key: null,
    evidenceType: 'code_call_site',
    surface: 'code',
    lines: [line],
    occurrences: 1,
    tiers: ['A'],
    tierByLine: { [line]: 'A' },
    decision: 'patch',
    entryId: `openai.${model}.retirement-2026-10-23`,
    shutdownDate: '2026-10-23',
  } as unknown as Finding;
}

function suppressionFor(f: Finding, extra: Partial<Suppression> = {}): Suppression {
  return {
    fingerprint: f.fingerprint,
    identity: identityOf({
      provider: f.provider,
      model: f.model,
      path: f.path,
      key: null,
      evidenceType: 'code_call_site',
    }),
    model: f.model,
    path: f.path,
    reason: 'pricing table, not a call site',
    author: 'ajith',
    createdAt: '2026-09-15',
    ...extra,
  };
}

const file = (s: Suppression[]): SuppressionFile => ({ schema: SUPPRESSIONS_SCHEMA, suppressions: s });

describe('applySuppressions', () => {
  it('moves a matched finding out of the actionable set and reports it', () => {
    const a = finding('src/pricing.ts', 'gpt-4');
    const b = finding('src/ai.ts', 'gpt-4');
    const out = applySuppressions([a, b], file([suppressionFor(a)]), '2026-09-15');
    expect(out.suppressed.map((s) => s.finding.path)).toEqual(['src/pricing.ts']);
    expect(out.active.map((f) => f.path)).toEqual(['src/ai.ts']);
    expect(out.inactive).toEqual([]);
  });

  // Identity is semantic, so an unrelated edit above the finding must not un-suppress it.
  it('survives a line move, because identity is not positional', () => {
    const before = finding('src/pricing.ts', 'gpt-4', 42);
    const after = finding('src/pricing.ts', 'gpt-4', 108);
    const out = applySuppressions([after], file([suppressionFor(before)]), '2026-09-15');
    expect(out.suppressed).toHaveLength(1);
    expect(out.active).toEqual([]);
  });

  it('does not suppress a different model in the same file', () => {
    const a = finding('src/ai.ts', 'gpt-4');
    const other = finding('src/ai.ts', 'gpt-3.5-turbo');
    const out = applySuppressions([a, other], file([suppressionFor(a)]), '2026-09-15');
    expect(out.active.map((f) => f.model)).toEqual(['gpt-3.5-turbo']);
  });

  it('an expired suppression stops applying and the finding is actionable again', () => {
    const a = finding('src/ai.ts', 'gpt-4');
    const out = applySuppressions(
      [a],
      file([suppressionFor(a, { expiresAt: '2026-09-14' })]),
      '2026-09-15',
    );
    expect(out.suppressed).toEqual([]);
    expect(out.active).toHaveLength(1);
    expect(out.inactive[0]?.reason).toBe('expired');
  });

  it('still applies on its expiry date, and stops the day after', () => {
    const a = finding('src/ai.ts', 'gpt-4');
    const s = file([suppressionFor(a, { expiresAt: '2026-09-15' })]);
    expect(applySuppressions([a], s, '2026-09-15').suppressed).toHaveLength(1);
    expect(applySuppressions([a], s, '2026-09-16').suppressed).toEqual([]);
  });

  it('reports a suppression whose finding no longer exists, instead of accumulating it', () => {
    const gone = finding('src/deleted.ts', 'gpt-4');
    const out = applySuppressions([finding('src/ai.ts', 'gpt-4')], file([suppressionFor(gone)]), '2026-09-15');
    expect(out.inactive[0]?.reason).toBe('no_matching_finding');
    expect(out.active).toHaveLength(1);
  });
});

describe('parseSuppressions — a malformed file must never hide a finding', () => {
  it('unparseable JSON yields no suppressions rather than throwing', () => {
    expect(parseSuppressions('{ not json').suppressions).toEqual([]);
  });

  it('drops an entry with no reason — that is not a reviewed decision', () => {
    const txt = JSON.stringify({
      schema: SUPPRESSIONS_SCHEMA,
      suppressions: [{ fingerprint: 'abc', author: 'ajith', createdAt: '2026-09-15' }],
    });
    expect(parseSuppressions(txt).suppressions).toEqual([]);
  });

  it('drops an entry with no author', () => {
    const txt = JSON.stringify({
      schema: SUPPRESSIONS_SCHEMA,
      suppressions: [{ fingerprint: 'abc', reason: 'x', createdAt: '2026-09-15' }],
    });
    expect(parseSuppressions(txt).suppressions).toEqual([]);
  });

  it('drops an entry whose dates are not ISO dates', () => {
    const mk = (extra: Record<string, unknown>) =>
      JSON.stringify({
        schema: SUPPRESSIONS_SCHEMA,
        suppressions: [{ fingerprint: 'abc', reason: 'x', author: 'a', createdAt: '2026-09-15', ...extra }],
      });
    expect(parseSuppressions(mk({ expiresAt: 'soon' })).suppressions).toEqual([]);
    expect(parseSuppressions(mk({ createdAt: 'yesterday' })).suppressions).toEqual([]);
  });

  it('keeps a well-formed entry', () => {
    const txt = JSON.stringify({
      schema: SUPPRESSIONS_SCHEMA,
      suppressions: [
        { fingerprint: 'abc', reason: 'fixture', author: 'ajith', createdAt: '2026-09-15', expiresAt: '2026-12-01' },
      ],
    });
    const s = parseSuppressions(txt).suppressions;
    expect(s).toHaveLength(1);
    expect(s[0]?.expiresAt).toBe('2026-12-01');
  });
});

describe('the report always says what was suppressed', () => {
  it('names the reason, the author and the expiry on every suppressed finding', () => {
    const a = finding('src/pricing.ts', 'gpt-4', 42);
    const out = applySuppressions([a], file([suppressionFor(a, { expiresAt: '2026-12-01' })]), '2026-09-15');
    const lines = formatSuppressionLines(out, '2026-09-15').join('\n');
    expect(lines).toContain('Suppressed (1)');
    expect(lines).toContain('never makes a run read as clean');
    expect(lines).toContain('src/pricing.ts:42');
    expect(lines).toContain('pricing table, not a call site');
    expect(lines).toContain('ajith');
    expect(lines).toContain('expires 2026-12-01');
  });

  it('says plainly that an expired suppression made its finding actionable again', () => {
    const a = finding('src/ai.ts', 'gpt-4');
    const out = applySuppressions([a], file([suppressionFor(a, { expiresAt: '2026-01-01' })]), '2026-09-15');
    expect(formatSuppressionLines(out, '2026-09-15').join('\n')).toContain('ACTIONABLE again');
  });

  it('tells the reader where to delete a stale entry', () => {
    const gone = finding('src/deleted.ts', 'gpt-4');
    const out = applySuppressions([], file([suppressionFor(gone)]), '2026-09-15');
    const lines = formatSuppressionLines(out, '2026-09-15').join('\n');
    expect(lines).toContain('Stale suppressions (1)');
    expect(lines).toContain('.mendr/suppressions.json');
  });

  it('prints nothing when there is nothing to say', () => {
    expect(formatSuppressionLines(applySuppressions([], file([]), '2026-09-15'), '2026-09-15')).toEqual([]);
  });
});

describe('isExpired', () => {
  it('no expiry never expires', () => {
    expect(isExpired({ expiresAt: undefined } as Suppression, '2099-01-01')).toBe(false);
  });
});
