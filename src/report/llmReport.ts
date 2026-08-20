import { basename } from 'node:path';
import type { DataPurpose } from '../usage/scanLiterals.js';

// LLM mode — report shaping. The raw scan of a real repo produces 100+ data
// findings (LibreChat, ChatGPT-Next-Web are typical), and a per-hit listing
// buries the two findings that matter under a hundred that don't. This module
// collapses the informational (Tier C data) surface into ONE line per file so
// the whole fix-llm report stays ~30 lines, while --verbose keeps every hit
// reachable. Pure functions over plain views — the CLI relativizes paths and
// prints; tests drive these directly.

/** One data finding, already reduced to a display view (repo-relative file). */
export interface DataFindingView {
  /** Repo-relative display path (forward slashes). */
  file: string;
  /** The deprecated model-id value. */
  value: string;
  /** The replacement it WOULD map to (context only, never applied). */
  replacement: string;
  line: number;
  column: number;
  purpose?: DataPurpose;
  /** A per-match override of the generic review advice (e.g. the cast guard). */
  reason?: string;
}

/** All of one file's data findings, collapsed for the one-line-per-file view. */
export interface DataFileGroup {
  file: string;
  /** Total data hits in this file. */
  hits: number;
  /** id -> occurrence count, ordered by first sighting in the file. */
  idCounts: Map<string, number>;
  /** How many of the hits are runtime comparisons (the ones that gate logic). */
  comparisons: number;
  /** True when the catalog heuristic fired for this file. */
  catalogLike: boolean;
}

/**
 * The CATALOG HEURISTIC's filename half: a basename that advertises itself as
 * a model catalog / pricing table / constants module. Kept deliberately small
 * — a wrong "looks like a catalog" label only changes phrasing, never behavior.
 */
const CATALOG_BASENAME = /prices|models|constant|limits|llm-list|masks/i;

/** Distinct-id threshold for the catalog heuristic's content half. */
const CATALOG_DISTINCT_IDS = 10;

/**
 * Does this file LOOK like a model catalog? Either its basename says so, or it
 * holds more distinct deprecated ids in data positions than any live call site
 * plausibly would (a file listing >10 retired models is a catalog, not code
 * that calls them).
 */
export function isCatalogLike(file: string, distinctIds: number): boolean {
  return distinctIds > CATALOG_DISTINCT_IDS || CATALOG_BASENAME.test(basename(file));
}

/**
 * Group data findings by file, preserving first-sighting order of both files
 * and ids so the report reads in source order.
 */
export function groupDataFindingsByFile(findings: DataFindingView[]): DataFileGroup[] {
  const byFile = new Map<string, DataFileGroup>();
  for (const f of findings) {
    let group = byFile.get(f.file);
    if (!group) {
      group = { file: f.file, hits: 0, idCounts: new Map(), comparisons: 0, catalogLike: false };
      byFile.set(f.file, group);
    }
    group.hits++;
    group.idCounts.set(f.value, (group.idCounts.get(f.value) ?? 0) + 1);
    if (f.purpose === 'comparison') group.comparisons++;
  }
  for (const group of byFile.values()) {
    group.catalogLike = isCatalogLike(group.file, group.idCounts.size);
  }
  return [...byFile.values()];
}

/** How many id tokens the one-line-per-file view spells out before "...". */
const MAX_IDS_PER_LINE = 4;

/**
 * Render one file's collapsed line, e.g.:
 *   `lib/chat-setting-limits.ts -- 15 hits across 12 model ids (gpt-4 x2,
 *    gemini-pro x2, ...) [looks like a model catalog]`
 * Comparisons are the one purpose worth surfacing even collapsed — they can
 * gate runtime logic, so the line says so when any are present.
 */
export function formatDataFileGroupLine(group: DataFileGroup): string {
  const n = group.idCounts.size;
  const shown = [...group.idCounts.entries()]
    .slice(0, MAX_IDS_PER_LINE)
    .map(([id, count]) => (count > 1 ? `${id} x${count}` : id));
  if (n > MAX_IDS_PER_LINE) shown.push('...');
  const catalog = group.catalogLike ? ' [looks like a model catalog]' : '';
  const compare =
    group.comparisons > 0
      ? ` -- ${group.comparisons} runtime comparison${group.comparisons === 1 ? '' : 's'} (may gate logic, review)`
      : '';
  return (
    `${group.file} -- ${group.hits} hit${group.hits === 1 ? '' : 's'} across ` +
    `${n} model id${n === 1 ? '' : 's'} (${shown.join(', ')})${catalog}${compare}`
  );
}

/** The purpose-aware phrase replacing the old flat "used as data". */
export function purposePhrase(purpose?: DataPurpose): string {
  switch (purpose) {
    case 'comparison':
      return 'in a runtime comparison (== / ===)';
    case 'lookup_key':
      return 'used as a lookup key';
    case 'list_entry':
      return 'used as a list entry';
    case 'catalog_entry':
      return 'used as a config/catalog entry';
    default:
      return 'used as data';
  }
}

/** One full-detail (--verbose) line for a data finding. */
export function formatDataHitLine(d: DataFindingView): string {
  const where = `${d.file}:${d.line}:${d.column}`;
  // A guard-supplied reason (the type-cast rule) replaces the generic advice.
  const advice =
    d.reason ??
    (d.purpose === 'comparison'
      ? `may gate logic, review (would map to "${d.replacement}")`
      : `review manually (would map to "${d.replacement}" if it were a live model argument)`);
  return `deprecated model id "${d.value}" ${purposePhrase(d.purpose)} at ${where} -- ${advice}`;
}

/**
 * A model id's FAMILY: everything up to and including its first digit run
 * (`gpt-4.1` -> `gpt-4`, `gpt-5.6-sol` -> `gpt-5`, `claude-opus-4-8` ->
 * `claude-opus-4`); an id with no digits is its own family. Used only for the
 * mixed-replacement-target warning — coarse is fine, wrong is not.
 */
export function replacementFamily(id: string): string {
  const m = /^(.*?\d+)/.exec(id);
  return m ? m[1] : id;
}
