import { relative } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry, ModelLifecycle } from '../types.js';
import { isVerified } from '../usage/llmRegistry.js';
import { displayEntryId } from '../registry/entryId.js';
import {
  buildRegistryPrefilter,
  loadPrefilteredProject,
} from '../usage/scanRepo.js';
import { findModelIdLiterals, type LiteralPosition } from '../usage/scanLiterals.js';
import { collectPythonFiles, findPyModelIdLiterals, readPythonSources } from '../python/scanPy.js';

// Phase 1 — Standing Watch: turn a one-shot scan into a resident record.
//
// EXPOSURE is the durable question the watch answers: which deprecated model
// ids does THIS repo's code touch, and when does each one die? It is computed
// from the SAME value-driven analyzer the fix path uses (scanLiterals for TS,
// scanPy for Python) joined to the bundled registry's retirement dates — no new
// detection, no type resolution, no network. The countdown is NOT stored: it is
// derived from `shutdownDate` vs the current day at render time, so the
// committed `.mendr/exposure.json` changes only when the repo's real exposure
// changes (a model added/removed, a registry date moved), never merely because
// a day passed. That churn-free property is the whole point — the first daily
// "one line changed" commit is the start of the Dependabot fatigue we exist to
// avoid.

/** A single matched occurrence of a deprecated id, reduced to plain data. */
export interface ExposureMatch {
  /** The deprecated model-id value found (exact literal content). */
  value: string;
  /** The registry entry the value matched. */
  entry: LlmModelIdDeprecation;
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line of the literal. */
  line: number;
  /** AST/CST position: `model_arg` is a live call site, everything else is not. */
  position: LiteralPosition;
}

/** Where one exposed id sits, as persisted in `.mendr/exposure.json`. */
export interface ExposureOccurrence {
  file: string;
  line: number;
  position: LiteralPosition;
}

/** One deprecated model id the repo is exposed to, with its retirement facts. */
export interface ExposedModel {
  /** The deprecated model-id value (what appears in the code). */
  id: string;
  provider: string;
  /** Stable registry id — the argument to `mendr evidence <id>`. */
  entryId: string;
  /** Source-id lifecycle per the provider's docs, when the registry carries one. */
  status: ModelLifecycle | null;
  /** ISO date (YYYY-MM-DD) calls stop working, or null when the provider gave none. */
  shutdownDate: string | null;
  /** The id the registry migrates to. */
  replacement: string;
  /** The provider doc the retirement was read from, when the entry carries one. */
  sourceUrl: string | null;
  /** Total matched occurrences across the repo (may exceed `locations.length`). */
  occurrences: number;
  /** How many of those sit in a live model-argument position (`model_arg`). */
  liveOccurrences: number;
  /** Sorted, capped sample of where the id appears. */
  locations: ExposureOccurrence[];
}

/** The computed watch state: the exposed models plus the scan's honest scope. */
export interface Exposure {
  models: ExposedModel[];
  /** Total source files the walker visited (TS + Python). */
  filesScanned: number;
  /** How many of those matched the registry pre-filter and were parsed. */
  filesMatched: number;
}

/** Most locations persisted per model — keeps the committed file bounded. */
export const MAX_LOCATIONS_PER_MODEL = 50;

/**
 * Whole days from `now` (at UTC day granularity) until `shutdownDate`. Negative
 * when the date has passed, 0 on the day itself, null when the entry is undated.
 * Day granularity is deliberate and documented: GitHub cron drifts and this is
 * never an exact-time promise.
 */
export function daysUntil(shutdownDate: string | null | undefined, now: Date): number | null {
  if (!shutdownDate) return null;
  const parsed = new Date(`${shutdownDate}T00:00:00Z`);
  const target = parsed.getTime();
  if (Number.isNaN(target)) return null;
  // `Number.isNaN` catches bad months and formats, but V8 SILENTLY ROLLS OVER an
  // out-of-range day ("2026-11-31" -> Dec 1), which would ship a plausible but
  // WRONG countdown for a one-character registry typo. Round-trip the parsed
  // date back to YYYY-MM-DD and reject anything that did not survive unchanged.
  if (parsed.toISOString().slice(0, 10) !== shutdownDate) return null;
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - nowUtc) / 86_400_000);
}

/**
 * Order two exposed models for display and for the persisted file: soonest real
 * deadline first (dated before undated), then by entry id so the order is
 * total and stable regardless of scan order.
 */
function compareByDeadline(a: ExposedModel, b: ExposedModel): number {
  if (a.shutdownDate && b.shutdownDate) {
    if (a.shutdownDate !== b.shutdownDate) return a.shutdownDate < b.shutdownDate ? -1 : 1;
  } else if (a.shutdownDate) {
    return -1;
  } else if (b.shutdownDate) {
    return 1;
  }
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** Location order: by file, then line — deterministic across machines. */
function compareOccurrence(a: ExposureOccurrence, b: ExposureOccurrence): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/**
 * Fold raw matches into the exposed-model list. PURE over its inputs — a test
 * drives it with a handful of matches and gets the exact grouping, counting and
 * ordering the shipped scan gets, without touching disk or the parser.
 *
 * Grouped by `entryId` so that when two matches carry two distinct registry
 * records for one value, each becomes its own exposure with its own deadline.
 * The scanners feed this every matching record: they index the registry by
 * `deprecated` value as a MULTIMAP (scanLiterals/scanPy) and emit one match per
 * matching entry, so a value that legitimately has two records (two providers,
 * or two retirement waves — which the entry-id scheme is built to allow) reaches
 * this fold under BOTH ids, and neither deadline is dropped. (This was once a
 * first-wins index that silently lost the second record's deadline; the shipped
 * registry has no duplicate values, so the second record is exercised only by
 * tests today, but the path is live end to end.)
 */
export function foldExposure(matches: readonly ExposureMatch[]): ExposedModel[] {
  const byEntry = new Map<string, ExposedModel>();
  for (const match of matches) {
    const entryId = displayEntryId(match.entry);
    let model = byEntry.get(entryId);
    if (!model) {
      model = {
        id: match.entry.deprecated,
        provider: match.entry.provider,
        entryId,
        status: match.entry.status ?? null,
        shutdownDate: match.entry.shutdownDate ?? null,
        replacement: match.entry.replacement,
        sourceUrl: match.entry.sourceUrl ?? null,
        occurrences: 0,
        liveOccurrences: 0,
        locations: [],
      };
      byEntry.set(entryId, model);
    }
    model.occurrences += 1;
    if (match.position === 'model_arg') model.liveOccurrences += 1;
    model.locations.push({ file: match.file, line: match.line, position: match.position });
  }

  const models = [...byEntry.values()];
  for (const model of models) {
    model.locations.sort(compareOccurrence);
    if (model.locations.length > MAX_LOCATIONS_PER_MODEL) {
      model.locations = model.locations.slice(0, MAX_LOCATIONS_PER_MODEL);
    }
  }
  models.sort(compareByDeadline);
  return models;
}

/**
 * Scan `repoPath` for every occurrence of a registry model-id, across TypeScript
 * and Python, reusing the fix path's exact walkers and pre-filter. Returns plain
 * matches plus the honest file-scope counts.
 */
export async function scanForExposure(
  repoPath: string,
  registry: LlmRegistry,
): Promise<{ matches: ExposureMatch[]; filesScanned: number; filesMatched: number }> {
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const prefilter = buildRegistryPrefilter(registry);

  // TypeScript: walk + text pre-filter + parse only the hit files.
  const { project, totalFiles: tsFiles, matchedFiles: tsMatched } = loadPrefilteredProject(
    repoPath,
    prefilter,
  );
  const tsMatches: ExposureMatch[] = findModelIdLiterals(project, registry).map((m) => ({
    value: m.value,
    entry: m.deprecation,
    file: rel(m.location.file),
    line: m.location.line,
    position: m.position,
  }));

  // Python: read once, parse only the files whose text contains a token.
  const pyFiles = collectPythonFiles(repoPath);
  const pySourcesAll = readPythonSources(pyFiles);
  const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];
  const pyMatches: ExposureMatch[] = (await findPyModelIdLiterals(pySources, registry)).map((m) => ({
    value: m.value,
    entry: m.deprecation,
    file: rel(m.location.file),
    line: m.location.line,
    position: m.position,
  }));

  return {
    matches: [...tsMatches, ...pyMatches],
    filesScanned: tsFiles + pyFiles.length,
    filesMatched: tsMatched + pySources.length,
  };
}

/** Compute the full watch exposure for a repo (scan + fold). */
export async function computeExposure(repoPath: string, registry: LlmRegistry): Promise<Exposure> {
  const { matches, filesScanned, filesMatched } = await scanForExposure(repoPath, registry);
  return { models: foldExposure(matches), filesScanned, filesMatched };
}

/** Does a live (`model_arg`) occurrence of this model have a ready Tier A fix? */
export function hasReadyFix(model: ExposedModel, registry: LlmRegistry): boolean {
  if (model.liveOccurrences === 0) return false;
  const entry = registry.find(
    (d): d is LlmModelIdDeprecation => d.kind === 'model_id' && displayEntryId(d) === model.entryId,
  );
  return entry !== undefined && isVerified(entry);
}
