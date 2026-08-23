import { relative } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry, ModelLifecycle, TierBReason } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from '../usage/scanRepo.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { collectPythonFiles, findPyModelIdLiterals, readPythonSources } from '../python/scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { type Tier } from '../report/tiers.js';

// Phase 1 — Standing Watch: turn a one-shot scan into a resident record.
//
// EXPOSURE is the durable question the watch answers: which deprecated model
// ids does THIS repo's code touch, when does each die, and how serious is each
// occurrence? It is computed from the SAME analyzer the fix path uses
// (scanLiterals for TS, scanPy for Python) and each occurrence is classified by
// the SAME per-occurrence tier fix-llm reports (classifyOccurrenceTier) — no
// second, simplified classifier, so the two surfaces can never disagree about
// whether a given gpt-4 is a Tier B review item or Tier C data. The countdown is
// NOT stored: it is derived from `shutdownDate` at render time, so the committed
// `.mendr/exposure.json` changes only when real exposure changes, never merely
// because a day passed.

/** A single matched occurrence, already classified into its terminal tier. */
export interface ExposureMatch {
  /** The deprecated model-id value found (exact literal content). */
  value: string;
  /** The registry entry the value matched. */
  entry: LlmModelIdDeprecation;
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line of the literal. */
  line: number;
  /** 1-based column of the literal. */
  column: number;
  /** The terminal tier this occurrence lands in (A > B > C). */
  tier: Tier;
  /** The Tier B reason code, present iff `tier === 'B'`. */
  reason?: TierBReason;
}

/** Where one occurrence sits, and how serious it is — persisted verbatim. */
export interface ExposureOccurrence {
  file: string;
  line: number;
  column: number;
  tier: Tier;
  reason?: TierBReason;
}

/** How many occurrences of a model landed in each tier. */
export interface TierCounts {
  A: number;
  B: number;
  C: number;
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
  /** Per-tier occurrence counts — the same A/B/C tiers fix-llm reports. */
  tierCounts: TierCounts;
  /** The most severe tier present (A > B > C) — the model's risk level. */
  highestTier: Tier;
  /** Sorted, capped sample of where the id appears, each with its tier. */
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
 * when the date has passed, 0 on the day itself, null when undated or invalid.
 */
export function daysUntil(shutdownDate: string | null | undefined, now: Date): number | null {
  if (!shutdownDate) return null;
  const parsed = new Date(`${shutdownDate}T00:00:00Z`);
  const target = parsed.getTime();
  if (Number.isNaN(target)) return null;
  // V8 silently rolls an out-of-range day over ("2026-11-31" -> Dec 1); round-trip
  // and reject anything that did not survive, so a registry typo yields null.
  if (parsed.toISOString().slice(0, 10) !== shutdownDate) return null;
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - nowUtc) / 86_400_000);
}

/** A=0, B=1, C=2 — lower is more severe (drives risk-first ordering). */
function tierRank(t: Tier): number {
  return t === 'A' ? 0 : t === 'B' ? 1 : 2;
}

/** The most severe tier present in a count set (A > B > C). */
function highestOf(counts: TierCounts): Tier {
  if (counts.A > 0) return 'A';
  if (counts.B > 0) return 'B';
  return 'C';
}

/**
 * Order models RISK FIRST, then nearest deadline. Highest tier (A before B
 * before C) leads, so a review-required finding always sorts above informational
 * data even when the data id retired long ago; within a tier, the soonest
 * shutdown date leads (dated before undated); ties break on entry id for a total,
 * stable order. Pure over the model (dates order correctly as strings), so
 * foldExposure needs no clock.
 */
function compareByRiskThenDeadline(a: ExposedModel, b: ExposedModel): number {
  const risk = tierRank(a.highestTier) - tierRank(b.highestTier);
  if (risk !== 0) return risk;
  if (a.shutdownDate && b.shutdownDate) {
    if (a.shutdownDate !== b.shutdownDate) return a.shutdownDate < b.shutdownDate ? -1 : 1;
  } else if (a.shutdownDate) {
    return -1;
  } else if (b.shutdownDate) {
    return 1;
  }
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** Location order: by file, then line, then column — deterministic. */
function compareOccurrence(a: ExposureOccurrence, b: ExposureOccurrence): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/**
 * Fold classified matches into the exposed-model list. PURE over its inputs.
 * Grouped by `entryId`, so a value with two registry records becomes two
 * exposures (the multimap feeds both). Each model accumulates per-tier counts
 * and its highest tier, and the list is ordered risk-first.
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
        tierCounts: { A: 0, B: 0, C: 0 },
        highestTier: 'C',
        locations: [],
      };
      byEntry.set(entryId, model);
    }
    model.occurrences += 1;
    model.tierCounts[match.tier] += 1;
    model.locations.push({
      file: match.file,
      line: match.line,
      column: match.column,
      tier: match.tier,
      reason: match.reason,
    });
  }

  const models = [...byEntry.values()];
  for (const model of models) {
    model.highestTier = highestOf(model.tierCounts);
    model.locations.sort(compareOccurrence);
    if (model.locations.length > MAX_LOCATIONS_PER_MODEL) {
      model.locations = model.locations.slice(0, MAX_LOCATIONS_PER_MODEL);
    }
  }
  models.sort(compareByRiskThenDeadline);
  return models;
}

/**
 * Scan `repoPath` for every occurrence of a registry model-id, across TypeScript
 * and Python, and classify each into its terminal tier with the SHARED
 * classifier (so watch and fix-llm agree). Returns plain matches plus honest
 * file-scope counts.
 */
export async function scanForExposure(
  repoPath: string,
  registry: LlmRegistry,
): Promise<{ matches: ExposureMatch[]; filesScanned: number; filesMatched: number }> {
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const prefilter = buildRegistryPrefilter(registry);

  const { project, totalFiles: tsFiles, matchedFiles: tsMatched } = loadPrefilteredProject(
    repoPath,
    prefilter,
  );
  const tsMatches: ExposureMatch[] = findModelIdLiterals(project, registry).map((m) => {
    const t = classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
    return {
      value: m.value,
      entry: m.deprecation,
      file: rel(m.location.file),
      line: m.location.line,
      column: m.location.column,
      tier: t.tier,
      reason: t.reason,
    };
  });

  const pyFiles = collectPythonFiles(repoPath);
  const pySourcesAll = readPythonSources(pyFiles);
  const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];
  const pyMatches: ExposureMatch[] = (await findPyModelIdLiterals(pySources, registry)).map((m) => {
    const t = classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
    return {
      value: m.value,
      entry: m.deprecation,
      file: rel(m.location.file),
      line: m.location.line,
      column: m.location.column,
      tier: t.tier,
      reason: t.reason,
    };
  });

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

/** A ready auto-fix exists iff the model has a Tier A occurrence (verified live). */
export function hasReadyFix(model: ExposedModel): boolean {
  return model.tierCounts.A > 0;
}

/** Total unique occurrences across every exposed model. */
export function totalOccurrences(models: readonly ExposedModel[]): number {
  return models.reduce((sum, m) => sum + m.occurrences, 0);
}

/** The nearest upcoming (or overdue) deadline across dated models, in days. */
export function nearestDeadlineDays(models: readonly ExposedModel[], now: Date): number | null {
  let nearest: number | null = null;
  for (const model of models) {
    const days = daysUntil(model.shutdownDate, now);
    if (days === null) continue;
    if (nearest === null || days < nearest) nearest = days;
  }
  return nearest;
}
