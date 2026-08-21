import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { EvidenceRef } from '../types.js';
import { EVIDENCE_EXCERPT_MAX_CHARS } from '../types.js';
import {
  captureDocument,
  captureEvidence,
  clampExcerpt,
  evidenceIsStale,
  hashText,
  loadSnapshot,
  normalizeForHash,
  saveSnapshot,
  snapshotName,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_TRUNCATION_MARKER,
} from './evidence.js';

// Hermetic: every fetch goes through an injected `fetchImpl` and every
// timestamp through an injected clock, so nothing here touches the network or
// the wall clock.

/** A fetch stub that answers one URL with fixed text. */
function stubFetch(body: string, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const FIXED_NOW = () => '2026-08-20T12:00:00.000Z';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mendr-evidence-'));
}

describe('hashText', () => {
  it('is sha256 of the utf8 bytes, hex, sha256-prefixed', () => {
    const expected = `sha256:${createHash('sha256').update('hello', 'utf8').digest('hex')}`;
    expect(hashText('hello')).toBe(expected);
  });

  it('is stable across calls and sensitive to a one-character change', () => {
    expect(hashText('a deprecation page')).toBe(hashText('a deprecation page'));
    expect(hashText('a deprecation page')).not.toBe(hashText('a deprecation pagE'));
  });

  it('produces the shape the registry loader accepts', () => {
    expect(hashText('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('normalizeForHash', () => {
  // The measured failure this exists for: Anthropic and Google mint a fresh CSP
  // nonce per response, so hashing raw bytes reported drift on EVERY refetch of
  // an unchanged page — and a drift signal that always fires is not a signal.
  const page = (nonce: string): string =>
    `<html><head><script nonce="${nonce}" integrity="sha384-${nonce}">window.__x=${nonce};</script></head>` +
    `<body><table><tr><td>gpt-4-0613</td><td>2026-10-23</td></tr></table></body></html>`;

  it('hashes two documents that differ ONLY by a CSP nonce identically', () => {
    expect(page('abc123')).not.toBe(page('zzz999')); // the bytes really do differ
    expect(hashText(normalizeForHash(page('abc123')))).toBe(
      hashText(normalizeForHash(page('zzz999'))),
    );
  });

  it('still changes the hash when the CONTENT changes', () => {
    const edited = page('abc123').replace('2026-10-23', '2027-01-15');
    expect(hashText(normalizeForHash(page('abc123')))).not.toBe(
      hashText(normalizeForHash(edited)),
    );
  });

  it('keeps the script element itself, so a page gaining a script is not "unchanged"', () => {
    const normalized = normalizeForHash(page('abc123'));
    expect(normalized).toContain('<script></script>');
    expect(normalized).not.toContain('window.__x');
    expect(normalized).not.toContain('nonce');
    expect(normalized).not.toContain('integrity');
  });

  it('collapses whitespace runs (reflow/minification is not an edit)', () => {
    expect(normalizeForHash('a\n\n   b\t c')).toBe('a b c');
  });

  it('leaves the deprecation table text -- ids, dates, prose -- intact', () => {
    expect(normalizeForHash(page('abc123'))).toContain('<td>gpt-4-0613</td>');
  });
});

describe('captureEvidence', () => {
  it('records the url, the hash of the NORMALIZED body, and the injected timestamp', async () => {
    const ref = await captureEvidence(
      'https://example.test/deprecations',
      stubFetch('gpt-4-0613 is retired'),
      FIXED_NOW,
    );
    expect(ref).toEqual({
      sourceUrl: 'https://example.test/deprecations',
      contentHash: hashText(normalizeForHash('gpt-4-0613 is retired')),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('two captures of the same nonce-bearing page produce the SAME hash', async () => {
    // End to end through the real capture path: the same page, re-served with a
    // new nonce, is one snapshot in the repo and no drift -- not a fresh commit
    // every scheduled run.
    const served = (nonce: string): string =>
      `<html><head><script nonce="${nonce}"></script></head><body>claude-3-opus-20240229 retires 2026-01-05</body></html>`;
    const first = await captureDocument('https://example.test/d', stubFetch(served('n1')), FIXED_NOW);
    const second = await captureDocument('https://example.test/d', stubFetch(served('n2')), FIXED_NOW);
    expect(second.ref.contentHash).toBe(first.ref.contentHash);
    expect(snapshotName(second.ref)).toBe(snapshotName(first.ref));
    // The RAW text is still handed back verbatim -- the parser reads the page,
    // not the normalized form.
    expect(second.text).toContain('nonce="n2"');
  });

  it('throws on a non-OK response rather than hashing an error page', async () => {
    await expect(
      captureEvidence('https://example.test/gone', stubFetch('Not Found', false, 404), FIXED_NOW),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('captureDocument hands back the raw text behind the hash', async () => {
    const body = '<table><tr><td>claude-3-opus-20240229</td></tr></table>';
    const doc = await captureDocument('https://example.test/a', stubFetch(body), FIXED_NOW);
    expect(doc.text).toBe(body);
    expect(doc.ref.contentHash).toBe(hashText(normalizeForHash(doc.text)));
  });
});

describe('clampExcerpt', () => {
  it('collapses whitespace so a table row reads as one sentence', () => {
    expect(clampExcerpt('  October 23, 2026 |\n  gpt-4-0613  ')).toBe('October 23, 2026 | gpt-4-0613');
  });

  it('never exceeds the length the registry loader will accept', () => {
    const excerpt = clampExcerpt('x'.repeat(1000));
    expect(excerpt.length).toBe(EVIDENCE_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith('...')).toBe(true);
  });
});

describe('saveSnapshot / loadSnapshot', () => {
  it('round-trips a small document under a content-addressed name', () => {
    const dir = tempDir();
    const text = 'gpt-4-0613 -> gpt-5.6-sol';
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/a',
      contentHash: hashText(text),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const path = saveSnapshot(dir, ref, text);
    expect(path.endsWith(snapshotName(ref))).toBe(true);
    // The name is the first 12 hex chars of the digest — re-capturing an
    // unchanged page therefore rewrites the same file with the same bytes.
    expect(snapshotName(ref)).toBe(`${ref.contentHash.slice(7, 19)}.txt`);
    expect(loadSnapshot(dir, ref)).toBe(text);
  });

  it('returns undefined for a ref that was never snapshotted', () => {
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/missing',
      contentHash: hashText('never stored'),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    expect(loadSnapshot(tempDir(), ref)).toBeUndefined();
  });

  it('leaves an EXISTING snapshot untouched (same hash = same document)', () => {
    // Why this matters: the file name is the digest of the NORMALIZED document,
    // but the stored bytes are raw -- and the raw bytes carry a fresh CSP nonce
    // on every fetch. Rewriting would put a meaningless diff in the repo on
    // every scheduled run, which is the churn the content-addressing exists to
    // avoid.
    const dir = tempDir();
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/a',
      contentHash: hashText('page'),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    saveSnapshot(dir, ref, '<script nonce="n1"></script>the page');
    saveSnapshot(dir, ref, '<script nonce="n2"></script>the page');
    expect(loadSnapshot(dir, ref)).toBe('<script nonce="n1"></script>the page');
  });

  it('caps an oversized document at 1MB and says so in the file', () => {
    const dir = tempDir();
    const huge = 'a'.repeat(SNAPSHOT_MAX_BYTES * 2);
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/huge',
      contentHash: hashText(huge),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const path = saveSnapshot(dir, ref, huge);
    expect(SNAPSHOT_MAX_BYTES).toBe(1024 * 1024);
    expect(statSync(path).size).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(readFileSync(path, 'utf8').endsWith(SNAPSHOT_TRUNCATION_MARKER)).toBe(true);
  });

  it('RETAINS the region around a cited excerpt that sits past the head', () => {
    // The near-miss this closes: Anthropic's cited row sits at char ~168k of a
    // ~973k page. A head-only cut stores the top of the document and calls it
    // evidence -- the quoted row, the only part that proves anything, is the
    // first thing thrown away.
    const dir = tempDir();
    const filler = 'x'.repeat(900 * 1024);
    const row = '<tr><td>claude-3-opus-20240229</td><td>2026-01-05</td><td>claude-opus-4-8</td></tr>';
    const text = `HEAD OF PAGE${filler}${row}${'y'.repeat(900 * 1024)}TAIL`;
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/long',
      contentHash: hashText(text),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const path = saveSnapshot(dir, ref, text, {
      excerpts: ['January 5, 2026 | claude-3-opus-20240229 | claude-opus-4-8'],
    });
    const stored = readFileSync(path, 'utf8');

    expect(statSync(path).size).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(stored).toContain('HEAD OF PAGE'); // the head is still there
    expect(stored).toContain(row); // and so is the row it was cited for
    // The gap between them is NAMED, not silently closed.
    expect(stored).toMatch(/\[mendr: [\d,]+ chars dropped here -- markup between the head/);
    expect(stored).toMatch(/\[mendr: [\d,]+ chars dropped here -- tail of the page/);
    expect(stored.endsWith(SNAPSHOT_TRUNCATION_MARKER)).toBe(true);
  });

  it('falls back to a head-only cut when no excerpt can be located', () => {
    const dir = tempDir();
    const text = `HEAD OF PAGE${'x'.repeat(SNAPSHOT_MAX_BYTES * 2)}`;
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/long',
      contentHash: hashText(text),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const stored = readFileSync(
      saveSnapshot(dir, ref, text, { excerpts: ['a row that is not on this page at all'] }),
      'utf8',
    );
    expect(stored).toContain('HEAD OF PAGE');
    expect(stored).not.toContain('chars dropped here');
    expect(stored.endsWith(SNAPSHOT_TRUNCATION_MARKER)).toBe(true);
  });

  it('the hash still describes the FULL document, not the truncated file', () => {
    // The trap this test exists to close: a reviewer re-hashing the stored file
    // and concluding the evidence is corrupt. The marker says otherwise, and so
    // does this assertion.
    const dir = tempDir();
    const huge = `${'b'.repeat(SNAPSHOT_MAX_BYTES * 2)}TAIL`;
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/huge',
      contentHash: hashText(huge),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const stored = readFileSync(saveSnapshot(dir, ref, huge), 'utf8');
    expect(ref.contentHash).toBe(hashText(huge));
    expect(hashText(stored)).not.toBe(ref.contentHash);
  });

  it('truncates multi-byte text without leaving half a character behind', () => {
    const dir = tempDir();
    // Every char is 3 UTF-8 bytes, so the byte cut is guaranteed mid-codepoint.
    const text = 'あ'.repeat(SNAPSHOT_MAX_BYTES);
    const ref: EvidenceRef = {
      sourceUrl: 'https://example.test/jp',
      contentHash: hashText(text),
      retrievedAt: '2026-08-20T12:00:00.000Z',
    };
    const stored = readFileSync(saveSnapshot(dir, ref, text), 'utf8');
    expect(stored).not.toContain('�');
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });
});

describe('evidenceIsStale', () => {
  const ref = (retrievedAt: string): EvidenceRef => ({
    sourceUrl: 'https://example.test/a',
    contentHash: hashText('x'),
    retrievedAt,
  });

  it('is fresh inside the window', () => {
    expect(
      evidenceIsStale(ref('2026-08-01T00:00:00.000Z'), 30, new Date('2026-08-20T00:00:00Z')),
    ).toBe(false);
  });

  it('is stale outside the window', () => {
    expect(
      evidenceIsStale(ref('2026-01-01T00:00:00.000Z'), 30, new Date('2026-08-20T00:00:00Z')),
    ).toBe(true);
  });

  it('treats an unparseable timestamp as stale, never as fresh', () => {
    // A stamp we cannot read is not proof of freshness; the safe direction for
    // a freshness check is always "re-verify".
    expect(evidenceIsStale(ref('last tuesday'), 30, new Date('2026-08-20T00:00:00Z'))).toBe(true);
  });
});
