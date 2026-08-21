import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRef, LlmModelIdDeprecation } from '../types.js';
import { snapshotName } from './evidence.js';
import { canonicalizeId, familyOf } from './normalize.js';
import { checkDeprecationClaim } from './claimCheck.js';

// The SOURCE half of the promote gate, rule by rule. The only impurity is rule
// (e)'s existence check, so every test builds a real (empty) temp snapshot dir
// and writes the files it wants to exist — no mocks, no fs stubs.

function liveSet(...ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const id of ids) {
    set.add(canonicalizeId(id));
    set.add(familyOf(id));
  }
  return set;
}

const HASH = `sha256:${'a'.repeat(64)}`;

const REF: EvidenceRef = {
  sourceUrl: 'https://example.test/deprecations',
  contentHash: HASH,
  retrievedAt: '2026-08-20T12:00:00.000Z',
  excerpt: 'October 23, 2026 | gpt-4-0613 | gpt-5.6-sol',
};

/** A snapshot dir that really contains the files the given refs name. */
function snapshotDirWith(...refs: EvidenceRef[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-claimcheck-'));
  for (const ref of refs) writeFileSync(join(dir, snapshotName(ref)), 'the stored page text');
  return dir;
}

const BACKED_DIR = snapshotDirWith(REF);
const EMPTY_DIR = snapshotDirWith();

function entry(over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0613',
    replacement: 'gpt-5.6-sol',
    status: 'retired',
    evidence: [REF],
    ...over,
  };
}

/** The catalogs list the replacement and one very-much-alive model. */
const LIVE = liveSet('gpt-5.6-sol', 'gpt-4o-mini');

describe('checkDeprecationClaim', () => {
  it('passes a retired id the catalogs do not list, quoted and snapshotted', () => {
    const result = checkDeprecationClaim(entry(), { liveIds: LIVE, snapshotDir: BACKED_DIR });
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it('passes an announced deprecation: still live, but dated and quoted', () => {
    // The case that makes "live" NOT a contradiction on its own: gpt-4o-mini is
    // in the catalogs AND has a published shutdown date. Both are true.
    const result = checkDeprecationClaim(
      entry({
        deprecated: 'gpt-4o-mini',
        status: 'deprecated',
        shutdownDate: '2026-10-23',
        evidence: [{ ...REF, excerpt: 'October 23, 2026 | gpt-4o-mini | gpt-5.6-sol' }],
      }),
      { liveIds: LIVE, snapshotDir: BACKED_DIR },
    );
    expect(result.ok).toBe(true);
  });

  it('(a) REFUSES a candidate with no status -- an unstated lifecycle is an unproven claim', () => {
    const result = checkDeprecationClaim(entry({ status: undefined }), {
      liveIds: LIVE,
      snapshotDir: BACKED_DIR,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no "status".*unstated lifecycle is an unproven claim/);
  });

  it('(b) REFUSES `retired` when the deprecated id is LIVE in the catalogs', () => {
    const result = checkDeprecationClaim(
      entry({
        deprecated: 'gpt-4o-mini',
        status: 'retired',
        evidence: [{ ...REF, excerpt: 'gpt-4o-mini is retired' }],
      }),
      { liveIds: LIVE, snapshotDir: BACKED_DIR },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(
      /claims calls to "gpt-4o-mini" fail today; the catalogs say otherwise/,
    );
  });

  it('(b) does NOT fire on a family match -- a retired dated snapshot may share a live alias', () => {
    // claude-3-opus-20240229 is retired while the bare `claude-3-opus` family
    // is still served. Family matching here would refuse the most common
    // legitimate entry in the registry, so the rule matches by identity only.
    const result = checkDeprecationClaim(
      entry({
        provider: 'anthropic',
        deprecated: 'claude-3-opus-20240229',
        replacement: 'claude-opus-4-8',
        status: 'retired',
        evidence: [{ ...REF, excerpt: 'claude-3-opus-20240229 | claude-opus-4-8' }],
      }),
      { liveIds: liveSet('claude-3-opus', 'claude-opus-4-8'), snapshotDir: BACKED_DIR },
    );
    expect(result.ok).toBe(true);
  });

  it('(c) REFUSES `deprecated` with no shutdownDate -- an announcement has a date', () => {
    const result = checkDeprecationClaim(entry({ status: 'deprecated' }), {
      liveIds: LIVE,
      snapshotDir: BACKED_DIR,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(
      /status "deprecated" with no "shutdownDate".*nothing to warn a user with/,
    );
  });

  it('(d) REFUSES when no excerpt names the deprecated id (the fabricated-quote path)', () => {
    const result = checkDeprecationClaim(
      entry({ evidence: [{ ...REF, excerpt: 'January 5, 2026 | some-other-model | gpt-5.6-sol' }] }),
      { liveIds: LIVE, snapshotDir: BACKED_DIR },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(
      /no evidence excerpt quotes "gpt-4-0613".*not proof of that model's deprecation/,
    );
  });

  it('(d) REFUSES an evidence ref with no excerpt at all', () => {
    const bare: EvidenceRef = { ...REF, excerpt: undefined };
    const result = checkDeprecationClaim(entry({ evidence: [bare] }), {
      liveIds: LIVE,
      snapshotDir: snapshotDirWith(bare),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no evidence excerpt quotes/);
  });

  it('(d) matches case-insensitively and across `.` vs `-` version separators', () => {
    const result = checkDeprecationClaim(
      entry({
        provider: 'google',
        deprecated: 'gemini-2-0-flash',
        evidence: [{ ...REF, excerpt: 'Retired: Gemini-2.0-Flash on February 5, 2026' }],
      }),
      { liveIds: LIVE, snapshotDir: BACKED_DIR },
    );
    expect(result.ok).toBe(true);
  });

  it('(e) REFUSES a ref whose snapshot was never stored -- it cannot be checked offline', () => {
    const result = checkDeprecationClaim(entry(), { liveIds: LIVE, snapshotDir: EMPTY_DIR });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      `evidence ref is unbacked (no snapshot stored for ${HASH}) -- cannot be checked offline`,
    );
  });

  it('(e) refuses when ANY of several refs is unbacked, naming that hash', () => {
    const other: EvidenceRef = { ...REF, contentHash: `sha256:${'b'.repeat(64)}` };
    const result = checkDeprecationClaim(entry({ evidence: [REF, other] }), {
      liveIds: LIVE,
      snapshotDir: BACKED_DIR, // holds REF's snapshot, not `other`'s
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain(other.contentHash);
    expect(result.reasons.join(' ')).not.toContain(`stored for ${REF.contentHash}`);
  });

  it('reports EVERY broken rule at once, not just the first', () => {
    // No status, a quote about another model, and no snapshot on disk.
    const result = checkDeprecationClaim(
      entry({ status: undefined, evidence: [{ ...REF, excerpt: 'a row about claude-2.0' }] }),
      { liveIds: LIVE, snapshotDir: EMPTY_DIR },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(3);
  });

  it('refuses a candidate carrying no evidence array at all', () => {
    const result = checkDeprecationClaim(entry({ evidence: undefined }), {
      liveIds: LIVE,
      snapshotDir: BACKED_DIR,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no evidence excerpt quotes/);
  });
});
