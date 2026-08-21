// Registry evidence — capture, hash, and snapshot the documents a claim rests on.
//
// The impure half of the provenance story (types live in types.ts, validation
// in usage/llmRegistry.ts). Everything network- or clock-dependent is behind an
// injected seam — `fetchImpl` and `now` — so tests are hermetic and the
// retrievedAt stamp is deterministic.
//
// WHY a hash AND a snapshot, when either alone seems enough:
//   - the HASH is the tamper check. It is computed over the NORMALIZED document
//     (see normalizeForHash), so a reviewer who refetches can prove the page
//     still says what it said (same hash) or has drifted (different hash).
//   - the SNAPSHOT is the offline record. Provider deprecation pages get
//     rewritten and reorganized; once that happens the hash can only tell you
//     something changed, never what it used to say.
// Snapshots are COMMITTED — they are the audit trail, and an audit trail that
// only exists on the machine that ran the job is not an audit trail. The size
// cap is what keeps that affordable: a provider docs page is ~1MB of markup and
// there is one snapshot per capture.
//
// WHY THE HASH IS NOT OVER THE RAW BYTES (measured, not theoretical):
//   the Anthropic and Google deprecation pages ship a per-response CSP
//   `nonce="..."` on every script tag. Hashing raw bytes meant EVERY refetch of
//   an UNCHANGED page produced a different hash — so "drift" fired every single
//   run, a fresh snapshot landed in the repo every scheduled run forever, and
//   the one signal the hash exists to give (this page changed) became noise.
//   normalizeForHash strips exactly the per-response noise (nonces, script
//   bodies, SRI hashes, whitespace runs) and nothing else: a real edit to the
//   deprecation table still changes the hash.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRef } from '../types.js';
import { EVIDENCE_EXCERPT_MAX_CHARS } from '../types.js';
import { resolveRegistryAsset } from '../usage/llmRegistry.js';

/** Where committed snapshots live, relative to the package root. */
export const EVIDENCE_DIR_RELATIVE = join('registries', 'evidence');

/** The on-disk snapshot directory, found by the shared `registries/` walk-up. */
export function resolveEvidenceDir(): string {
  return resolveRegistryAsset(EVIDENCE_DIR_RELATIVE);
}

/**
 * Hard cap on one stored snapshot file, marker included.
 *
 * 1MB, raised from 200KB after a near-miss worth stating: Anthropic's cited row
 * sits at char ~168k of a ~973k document, i.e. 32KB from falling outside the
 * stored snapshot entirely — the evidence for the claim would have been
 * silently absent from the file that exists to hold it. A whole provider docs
 * page now fits; when something still does not, the excerpt window below
 * guarantees the cited row survives regardless of where on the page it sits.
 */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** How much of the document is kept around a cited excerpt when truncating. */
export const SNAPSHOT_EXCERPT_WINDOW_BYTES = 64 * 1024;

/** Share of the byte budget the head of the document gets before the windows. */
const SNAPSHOT_HEAD_SHARE = 0.5;

/** Slack held back for the "N chars dropped here" markers between windows. */
const MARKER_RESERVE_BYTES = 1024;

/** Shortest excerpt token usable as an anchor (a model id, not "the" or "|"). */
const MIN_ANCHOR_TOKEN_CHARS = 6;

/**
 * The LAST line of any truncated snapshot. It names the cap AND restates what
 * the hash covers, so nobody re-hashes the truncated file and concludes the
 * evidence is broken. (For an UNtruncated snapshot the check does work — run it
 * through {@link normalizeForHash} first, which is what was hashed.)
 */
export const SNAPSHOT_TRUNCATION_MARKER =
  '\n\n[mendr: snapshot truncated at 1MB -- contentHash covers the FULL normalized document, not this file]\n';

/** One "…and here is what is missing" marker, placed where the gap actually is. */
function droppedMarker(chars: number, what: string): string {
  return `\n\n[mendr: ${chars.toLocaleString('en-US')} chars dropped here -- ${what}]\n\n`;
}

/** `sha256:` + hex digest of `text`, the one hash spelling the loader accepts. */
export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Reduce a fetched document to the part of it that is actually a CLAIM, so the
 * hash tracks meaning instead of per-response noise.
 *
 * WHAT IS STRIPPED, and why each one is noise rather than content:
 *   - `nonce="..."`      a fresh CSP nonce on every response (Anthropic, Google).
 *                        Two identical pages differ in every script tag without it.
 *   - `<script>` BODIES  build hashes, session ids, hydration payloads: the
 *                        churniest bytes on the page and never the deprecation
 *                        table a claim is read from. The empty `<script></script>`
 *                        is kept so a script's PRESENCE still registers.
 *   - `integrity="..."`  SRI hashes, which rotate with every asset rebuild.
 *   - whitespace runs    reflow/minification differences.
 * Everything a human would call "what the page says" — the prose, the tables,
 * the ids, the dates — is untouched, so a real edit still changes the hash.
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>')
    .replace(/\snonce\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a source sentence/row into an excerpt: whitespace collapsed and
 * clamped to {@link EVIDENCE_EXCERPT_MAX_CHARS} (the loader rejects longer).
 */
export function clampExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EVIDENCE_EXCERPT_MAX_CHARS) return flat;
  return `${flat.slice(0, EVIDENCE_EXCERPT_MAX_CHARS - 3)}...`;
}

/** A capture that also hands back the fetched text (for parsing + snapshotting). */
export interface CapturedDocument {
  ref: EvidenceRef;
  /**
   * The FULL document text as fetched — RAW, not normalized. The hash on `ref`
   * is over `normalizeForHash(text)`; this is the readable page the parser reads
   * and the snapshot stores.
   */
  text: string;
}

/**
 * Fetch `url`, hash the body, and stamp the retrieval time.
 *
 * Returns the text as well as the ref because every real caller needs both:
 * discover.ts parses the text and saveSnapshot stores it. Re-fetching to get
 * the body back would risk hashing one response and reading another.
 */
export async function captureDocument(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<CapturedDocument> {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      // Provider docs are localized off Accept-Language, and the deterministic
      // table parser reads ENGLISH column headers. Asking for English keeps a
      // run reproducible instead of varying with the runner's egress IP.
      'accept-language': 'en',
    },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  return {
    // Hashed through normalizeForHash so a page that only changed its CSP nonce
    // reads as UNCHANGED. Any comparison against this hash — including a
    // refetch drift check — must normalize the same way or it compares nothing.
    ref: { sourceUrl: url, contentHash: hashText(normalizeForHash(text)), retrievedAt: now() },
    text,
  };
}

/** Fetch `url` and return only its EvidenceRef (see {@link captureDocument}). */
export async function captureEvidence(
  url: string,
  fetchImpl?: typeof fetch,
  now?: () => string,
): Promise<EvidenceRef> {
  return (await captureDocument(url, fetchImpl, now)).ref;
}

/** The bare hex digest of a ref's `sha256:`-prefixed contentHash. */
function digestOf(ref: EvidenceRef): string {
  return ref.contentHash.startsWith('sha256:') ? ref.contentHash.slice(7) : ref.contentHash;
}

/**
 * Snapshot filename for a ref: the first 12 hex chars of its digest. Content-
 * addressed over the NORMALIZED document, so re-capturing an unchanged page
 * resolves to the same filename and saveSnapshot leaves it alone — the commit
 * stays empty. Only real drift shows up, as a new snapshot under a new name.
 */
export function snapshotName(ref: EvidenceRef): string {
  return `${digestOf(ref).slice(0, 12)}.txt`;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes. A byte-level cut can land
 * mid-codepoint, so the decoded tail's replacement char is dropped rather than
 * written — a snapshot must be valid UTF-8 a human can open.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const slice = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  const decoded = new TextDecoder('utf-8').decode(slice);
  // U+FFFD as an escape, so this source file stays pure ASCII.
  return decoded.endsWith('�') ? decoded.slice(0, -1) : decoded;
}

/** A half-open `[start, end)` character range of the source document. */
interface CharRange {
  start: number;
  end: number;
}

/**
 * Where in `text` a cited excerpt lives, or -1.
 *
 * CONSTRAINT that shapes this: an excerpt is a table ROW re-assembled from cell
 * text (`"October 23, 2026 | gpt-4-0613 | gpt-5.6-sol"`), so it is almost never
 * a literal substring of the surrounding markup — the cells have tags between
 * them. A direct hit is tried first (plain-text docs), then the excerpt's
 * longest distinctive token, which in practice is the model id: the exact thing
 * a reviewer opens the snapshot to find.
 */
function findExcerptAnchor(text: string, excerpt: string): number {
  const haystack = text.toLowerCase();
  const flat = excerpt.replace(/\s+/g, ' ').trim().toLowerCase();
  if (flat.length === 0) return -1;
  const direct = haystack.indexOf(flat);
  if (direct >= 0) return direct;
  const tokens = flat
    .split(/[^a-z0-9._-]+/)
    .filter((t) => t.length >= MIN_ANCHOR_TOKEN_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const at = haystack.indexOf(token);
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * Ranges to retain around each cited excerpt that falls BEYOND the head, in
 * document order, overlaps merged, clipped to `budgetBytes`.
 */
function excerptWindows(
  text: string,
  excerpts: readonly string[],
  headEnd: number,
  budgetBytes: number,
): CharRange[] {
  const half = Math.floor(SNAPSHOT_EXCERPT_WINDOW_BYTES / 2);
  const found: CharRange[] = [];
  for (const excerpt of excerpts) {
    const at = findExcerptAnchor(text, excerpt);
    // Not found, or already inside the head we are keeping anyway.
    if (at < 0 || at < headEnd) continue;
    found.push({ start: Math.max(headEnd, at - half), end: Math.min(text.length, at + half) });
  }
  found.sort((a, b) => a.start - b.start);

  const merged: CharRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  const kept: CharRange[] = [];
  let spent = 0;
  for (const range of merged) {
    const slice = text.slice(range.start, range.end);
    const size = Buffer.byteLength(slice, 'utf8');
    if (spent + size <= budgetBytes) {
      kept.push(range);
      spent += size;
      continue;
    }
    // Partial last window beats no last window: the anchor sits in its middle.
    const room = budgetBytes - spent;
    if (room > 0) {
      const clipped = truncateToBytes(slice, room);
      kept.push({ start: range.start, end: range.start + clipped.length });
    }
    break;
  }
  return kept;
}

/**
 * The bytes to store for `text`: the document itself when it fits, otherwise
 * the head plus a window around each cited excerpt, with a marker at every gap
 * naming how much was dropped there.
 *
 * WHY the windows exist: a head-only cut stores the top of the page and calls
 * it evidence. Anthropic's cited row sits at char ~168k — under the old 200KB
 * cap it was 32KB from being cut out of the very file that is supposed to prove
 * the claim, and nothing would have said so.
 */
function buildSnapshotBody(text: string, excerpts: readonly string[]): string {
  if (Buffer.byteLength(text, 'utf8') <= SNAPSHOT_MAX_BYTES) return text;

  const budget = SNAPSHOT_MAX_BYTES - Buffer.byteLength(SNAPSHOT_TRUNCATION_MARKER, 'utf8');
  const head = truncateToBytes(text, Math.floor(budget * SNAPSHOT_HEAD_SHARE));
  const windowBudget = budget - Buffer.byteLength(head, 'utf8') - MARKER_RESERVE_BYTES;
  const windows =
    windowBudget > 0 ? excerptWindows(text, excerpts, head.length, windowBudget) : [];

  // No excerpt to anchor on (or none past the head): keep as much of the top of
  // the document as the FULL budget allows, exactly as before.
  if (windows.length === 0) {
    return truncateToBytes(text, budget) + SNAPSHOT_TRUNCATION_MARKER;
  }

  let body = head;
  let cursor = head.length;
  for (const window of windows) {
    if (window.start > cursor) {
      const gap = window.start - cursor;
      body += droppedMarker(gap, 'markup between the head of the page and a cited row');
    }
    body += text.slice(window.start, window.end);
    cursor = window.end;
  }
  if (cursor < text.length) {
    body += droppedMarker(text.length - cursor, 'tail of the page, after the last cited row');
  }
  // Belt and braces: the budget arithmetic above should already fit, but the
  // cap is a HARD promise about a committed file, not an estimate.
  const cap = SNAPSHOT_MAX_BYTES - Buffer.byteLength(SNAPSHOT_TRUNCATION_MARKER, 'utf8');
  if (Buffer.byteLength(body, 'utf8') > cap) body = truncateToBytes(body, cap);
  return body + SNAPSHOT_TRUNCATION_MARKER;
}

/** Extra context for a capture: which excerpts this document was cited for. */
export interface SnapshotOptions {
  /**
   * The excerpts registry/candidate entries quote from this document. The
   * region around each is retained when the document has to be truncated.
   */
  excerpts?: readonly string[];
}

/**
 * Write the fetched document under `dir` and return the path written. Files
 * larger than {@link SNAPSHOT_MAX_BYTES} are truncated with
 * {@link SNAPSHOT_TRUNCATION_MARKER}, keeping the head plus a window around
 * each cited excerpt; the ref's hash still describes the whole normalized
 * document, never this file.
 *
 * AN EXISTING FILE IS LEFT ALONE. The name is the digest of the normalized
 * document, so a file already sitting there IS this capture — rewriting it
 * would replace identical content with bytes that differ only in the page's
 * per-response noise (a fresh CSP nonce), and every scheduled run would commit
 * a diff that means nothing.
 */
export function saveSnapshot(
  dir: string,
  ref: EvidenceRef,
  text: string,
  opts: SnapshotOptions = {},
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, snapshotName(ref));
  if (existsSync(path)) return path;
  writeFileSync(path, buildSnapshotBody(text, opts.excerpts ?? []));
  return path;
}

/** Read a previously saved snapshot back, or undefined when it was never stored. */
export function loadSnapshot(dir: string, ref: EvidenceRef): string | undefined {
  const path = join(dir, snapshotName(ref));
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Is a ref older than `days`? An UNPARSEABLE `retrievedAt` counts as stale: a
 * stamp we cannot read is not proof of freshness, and the safe direction for a
 * freshness check is always "re-verify".
 */
export function evidenceIsStale(ref: EvidenceRef, days: number, now: Date): boolean {
  const retrieved = Date.parse(ref.retrievedAt);
  if (Number.isNaN(retrieved)) return true;
  return now.getTime() - retrieved > days * 24 * 60 * 60 * 1000;
}
