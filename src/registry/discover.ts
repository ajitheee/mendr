// Scheduled discovery — find newly-announced deprecations, propose NOTHING live.
//
// This module fetches each provider's own deprecation page and turns the rows
// it can read CONFIDENTLY into CandidateEntry objects. It is deliberately the
// least-powerful thing that could work:
//
//   - NO LLM. Extraction is regex + table parsing over the fetched text. An LLM
//     would raise recall and destroy determinism: the same page would yield
//     different candidates on different runs, and a hallucinated model id would
//     be indistinguishable from a real one.
//   - NO FILESYSTEM. This module imports no fs API at all. Everything it
//     produces is returned as data; the CLI decides what to write, and the only
//     file the discover CLI path writes is candidates.json. That is what makes
//     "discover cannot touch the active registry" a STRUCTURAL claim rather
//     than a promise (see discover.test.ts, which asserts it against this
//     module's own source text).
//   - NO GUESSING. Every row that is not unambiguously (one deprecated id) ->
//     (one replacement id) is SKIPPED with a stated reason. Ambiguity is
//     reported to a human, never resolved by this parser.
//
// Even a perfectly-parsed candidate is inert: candidates carry no verification
// stamp, live in a file the fix engine never reads, and reach the active
// registry only via `mendr candidates promote <id...>`.

import type { CandidateEntry, LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { canonicalizeId } from './normalize.js';
import { captureDocument, clampExcerpt, type CapturedDocument } from './evidence.js';

/** Providers discovery knows how to read. */
export const DISCOVER_PROVIDERS = ['openai', 'anthropic', 'google'] as const;
export type DiscoverProvider = (typeof DISCOVER_PROVIDERS)[number];

/**
 * The curated deprecation page per provider — the same URLs the registry's
 * existing `sourceUrl` fields point at. Curated, not crawled: an unknown page
 * layout produces garbage rows, and this list is short enough for a human to
 * own.
 */
export const PROVIDER_SOURCES: Record<DiscoverProvider, string> = {
  openai: 'https://developers.openai.com/api/docs/deprecations',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  google: 'https://ai.google.dev/gemini-api/docs/deprecations',
};

/**
 * Model-id prefixes we accept PER PROVIDER. A deprecation table's model column
 * also holds API names, endpoints, beta headers and product names ("Videos
 * API", "/v1/engines", "OpenAI-Beta: realtime=v1"); requiring a known model
 * prefix is the cheapest reliable way to keep those out. Precision over recall:
 * a real model id we do not recognize is simply not proposed, which costs a
 * human one manual entry — a bogus one costs trust in the whole queue.
 */
const PROVIDER_ID_PREFIXES: Record<DiscoverProvider, RegExp> = {
  openai: /^(?:gpt|o[1-9]|chatgpt|codex|text-|code-|davinci-|babbage-|curie-|ada-|whisper-|tts-|dall-e|omni-)/,
  anthropic: /^claude-/,
  google: /^(?:gemini|palm|imagen|text-bison|chat-bison)/,
};

/**
 * The SHAPE a model id must have on top of its provider prefix: lowercase
 * alphanumerics with at least one `-`/`.` separator. The separator requirement
 * is what rejects bare product words ("ada", "babbage") that share a prefix
 * with a real family.
 */
const MODEL_ID_SHAPE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;

/** Header of the column naming the DEPRECATED model. */
const DEPRECATED_HEADER = /\bmodel\b/i;
/** Header of the column naming the REPLACEMENT (checked first — it also says "model"). */
const REPLACEMENT_HEADER = /\b(?:replacement|substitute)\b/i;
/** Header of the shutdown/retirement date column ("Release date" must NOT match). */
const DATE_HEADER = /\b(?:shutdown|retirement|deactivation|sunset)\b/i;
/** A price column also says "model"; it is never the id column. */
const PRICE_HEADER = /\bprice\b/i;

/** A row this parser refused, and why — surfaced so a human can do it by hand. */
export interface DiscoverySkip {
  provider: DiscoverProvider;
  /** The row (or table header) text as read, clamped for display. */
  row: string;
  reason: string;
}

/** Everything one discovery run produced. Data only — the caller writes. */
export interface DiscoveryResult {
  candidates: CandidateEntry[];
  /** The fetched pages, so the caller can commit snapshots alongside the refs. */
  documents: CapturedDocument[];
  skipped: DiscoverySkip[];
  /** Per-provider diagnostics (row counts, fetch failures). */
  notes: string[];
}

/** Inputs to a run. Both dedupe corpora are passed IN; nothing is loaded here. */
export interface DiscoverOptions {
  /** The active registry, for dedupe ONLY — this module never writes to it. */
  activeRegistry: LlmRegistry;
  /** Already-queued candidates, so a monthly run does not re-propose them. */
  existingCandidates: readonly CandidateEntry[];
  fetchImpl?: typeof fetch;
  /** Injected clock (ISO string) so a run is reproducible in tests. */
  now?: () => string;
}

/** Strip tags/entities from one HTML cell and collapse its whitespace. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split one `<tr>` into its cell texts (header and body cells alike). */
function rowCells(rowHtml: string): string[] {
  return (rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText);
}

/**
 * Unicode dashes (provider pages use U+2011 non-breaking hyphens inside dates)
 * normalized to ASCII `-`, so one date regex covers every spelling.
 */
function normalizeDashes(text: string): string {
  return text.replace(/[‐-―−]/g, '-');
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Pull an ISO date out of a date cell, or undefined when there is none.
 * Accepts `2026-09-28` and `October 23, 2026` / `Jan 20, 2027`. Cells like "No
 * shutdown date announced" yield undefined — and that is fine, `shutdownDate`
 * is optional on a registry entry. Hedged phrasing ("at earliest", "not sooner
 * than") is preserved verbatim in the candidate's `note`, so the reviewer sees
 * the qualifier the date alone would lose.
 */
export function parseShutdownDate(cell: string): string | undefined {
  const text = normalizeDashes(cell);
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = text.match(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\b/);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[2].padStart(2, '0')}`;
  }
  return undefined;
}

/**
 * The model ids inside one cell. A cell may legitimately list several
 * (`gpt-4-0613 | gpt-4 , gpt-4-completions`), which is exactly the ambiguity
 * the caller refuses to resolve — it needs the COUNT, not a pick.
 */
function modelIdsIn(cell: string, provider: DiscoverProvider): string[] {
  const prefix = PROVIDER_ID_PREFIXES[provider];
  const tokens = normalizeDashes(cell).split(/[\s,|/()]+/);
  const ids: string[] = [];
  for (const raw of tokens) {
    // Trailing footnote markers/punctuation are display, not part of the id.
    const token = raw.toLowerCase().replace(/[.,;:*]+$/, '');
    if (!MODEL_ID_SHAPE.test(token) || !prefix.test(token)) continue;
    if (!ids.includes(token)) ids.push(token);
  }
  return ids;
}

/** Which column holds what, resolved from a table's header row. */
interface ColumnMap {
  deprecated: number;
  replacement: number;
  date?: number;
}

/**
 * Map a table's columns from its header row, or explain why the table is
 * unreadable. EXACTLY ONE deprecated column and EXACTLY ONE replacement column
 * are required: two matches means we would have to guess which one is which,
 * and guessing is the thing this parser does not do. Tables with no replacement
 * column (Anthropic's "active models" list, OpenAI's date/update changelogs)
 * fall out here — correctly, since a `model_id` entry cannot exist without a
 * replacement.
 */
function mapColumns(headers: string[]): ColumnMap | string {
  const replacements: number[] = [];
  const deprecateds: number[] = [];
  let date: number | undefined;
  headers.forEach((header, i) => {
    if (REPLACEMENT_HEADER.test(header)) {
      replacements.push(i);
      return;
    }
    if (DEPRECATED_HEADER.test(header) && !PRICE_HEADER.test(header)) deprecateds.push(i);
    if (date === undefined && DATE_HEADER.test(header)) date = i;
  });
  if (replacements.length !== 1) {
    return `table has ${replacements.length} replacement columns (need exactly 1): [${headers.join(' | ')}]`;
  }
  if (deprecateds.length !== 1) {
    return `table has ${deprecateds.length} deprecated-model columns (need exactly 1): [${headers.join(' | ')}]`;
  }
  return { deprecated: deprecateds[0], replacement: replacements[0], date };
}

/** One row successfully read off a provider page. */
export interface DiscoveredRow {
  deprecated: string;
  replacement: string;
  shutdownDate?: string;
  /** The row as printed on the page — the excerpt a reviewer reads. */
  rowText: string;
}

/**
 * Extract every confidently-readable deprecation row from one provider's page
 * HTML. Exported for tests: this is the whole determinism claim, so it is
 * exercised directly against fixture markup with no network in sight.
 */
export function extractRows(
  html: string,
  provider: DiscoverProvider,
): { rows: DiscoveredRow[]; skipped: DiscoverySkip[] } {
  const rows: DiscoveredRow[] = [];
  const skipped: DiscoverySkip[] = [];

  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const trs: string[] = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (trs.length < 2) continue;
    const headers = rowCells(trs[0]);
    const columns = mapColumns(headers);
    if (typeof columns === 'string') {
      // Not a deprecation table (or not one we can read). Noted once per table,
      // not once per row — a changelog table would otherwise flood the report.
      skipped.push({ provider, row: clampExcerpt(headers.join(' | ')), reason: columns });
      continue;
    }

    for (const tr of trs.slice(1)) {
      const cells = rowCells(tr);
      const rowText = clampExcerpt(cells.join(' | '));
      const depCell = cells[columns.deprecated] ?? '';
      const replCell = cells[columns.replacement] ?? '';

      const depIds = modelIdsIn(depCell, provider);
      const replIds = modelIdsIn(replCell, provider);
      if (depIds.length === 0) continue; // section heading / spacer row, not a claim
      if (depIds.length > 1) {
        skipped.push({
          provider,
          row: rowText,
          reason: `deprecated cell names ${depIds.length} model ids (${depIds.join(', ')}) -- ambiguous, needs a human`,
        });
        continue;
      }
      if (replIds.length === 0) {
        skipped.push({
          provider,
          row: rowText,
          reason: `no usable replacement model id in "${clampExcerpt(replCell) || '(empty)'}"`,
        });
        continue;
      }
      if (replIds.length > 1) {
        skipped.push({
          provider,
          row: rowText,
          reason: `replacement cell offers ${replIds.length} model ids (${replIds.join(', ')}) -- ambiguous, needs a human`,
        });
        continue;
      }
      if (canonicalizeId(depIds[0]) === canonicalizeId(replIds[0])) {
        skipped.push({ provider, row: rowText, reason: 'row maps a model id to itself' });
        continue;
      }

      rows.push({
        deprecated: depIds[0],
        replacement: replIds[0],
        shutdownDate:
          columns.date === undefined ? undefined : parseShutdownDate(cells[columns.date] ?? ''),
        rowText,
      });
    }
  }
  return { rows, skipped };
}

/** Stable, human-typeable id for a candidate: `<provider>:<canonical model id>`. */
export function candidateIdFor(provider: string, deprecated: string): string {
  return `${provider}:${canonicalizeId(deprecated)}`;
}

/**
 * Fetch each provider's deprecation page, capture evidence for it, and turn the
 * readable rows into candidates. Deduped against BOTH the active registry and
 * the existing queue, so a monthly run proposes only what is genuinely new.
 *
 * A fetch failure for one provider is NOTED, not thrown: a scheduled job that
 * dies because one docs site was down would silently stop discovering anything.
 */
export async function discoverCandidates(
  providers: readonly DiscoverProvider[],
  opts: DiscoverOptions,
): Promise<DiscoveryResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const proposedAt = now();
  const today = proposedAt.slice(0, 10);

  const known = new Set<string>(
    opts.activeRegistry
      .filter((e): e is LlmModelIdDeprecation => e.kind === 'model_id')
      .map((e) => canonicalizeId(e.deprecated)),
  );
  for (const c of opts.existingCandidates) known.add(canonicalizeId(c.deprecated));

  const candidates: CandidateEntry[] = [];
  const documents: CapturedDocument[] = [];
  const skipped: DiscoverySkip[] = [];
  const notes: string[] = [];

  for (const provider of providers) {
    const url = PROVIDER_SOURCES[provider];
    let doc: CapturedDocument;
    try {
      doc = await captureDocument(url, opts.fetchImpl, now);
    } catch (err) {
      notes.push(`${provider} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    documents.push(doc);

    const { rows, skipped: rowSkips } = extractRows(doc.text, provider);
    skipped.push(...rowSkips);

    let added = 0;
    for (const row of rows) {
      const canonical = canonicalizeId(row.deprecated);
      if (known.has(canonical)) continue; // already in the registry or the queue
      known.add(canonical); // and never twice within one run

      candidates.push({
        provider,
        kind: 'model_id',
        deprecated: row.deprecated,
        replacement: row.replacement,
        // A shutdown date in the past means calls already fail; a future one is
        // an early warning. Derived from the INJECTED clock, so a run is
        // reproducible. No date at all leaves the lifecycle unclaimed.
        status:
          row.shutdownDate === undefined
            ? undefined
            : row.shutdownDate <= today
              ? 'retired'
              : 'deprecated',
        shutdownDate: row.shutdownDate,
        sourceUrl: url,
        note: `discovered from the ${provider} deprecation table; row read as: ${row.rowText}`,
        // NO verification block. Discovery states what a page said, never what
        // is trustworthy — `mendr candidates verify` classifies, and only
        // `mendr candidates promote` (run by a person) makes anything active.
        evidence: [{ ...doc.ref, excerpt: row.rowText }],
        candidateId: candidateIdFor(provider, row.deprecated),
        proposedBy: 'discovery',
        proposedAt,
      });
      added++;
    }
    notes.push(
      `${provider}: ${rows.length} readable rows, ${added} new candidates, ${rowSkips.length} skipped`,
    );
  }

  return { candidates, documents, skipped, notes };
}
