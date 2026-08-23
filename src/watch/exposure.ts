import { relative } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry, ModelLifecycle, TierBReason } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import {
  effectiveVerificationState,
  type EffectiveVerificationState,
} from '../usage/llmRegistry.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from '../usage/scanRepo.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { collectPythonFiles, findPyModelIdLiterals, readPythonSources } from '../python/scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { usageVerdictState, type Tier, type UsageVerdict } from '../report/tiers.js';

// Phase 1 — Standing Watch: turn a one-shot scan into a resident record.
//
// EXPOSURE is the durable question the watch answers: which deprecated model ids
// does THIS repo's code touch, when does each die, and how serious is each
// occurrence? Every occurrence is classified into the SAME A/B/C tier fix-llm
// reports (classifyOccurrenceTier) and carries the same usage verdict, so the
// two surfaces never disagree. Each model additionally carries a MODEL-LEVEL
// disposition (the field that decides action — never `highestTier`, which exists
// only to order the list) and the registry's replacement verdict, so a consumer
// can never mistake a quarantined candidate replacement for a verified one.

/** A single matched occurrence, already classified into its terminal tier. */
export interface ExposureMatch {
  value: string;
  entry: LlmModelIdDeprecation;
  file: string;
  line: number;
  column: number;
  tier: Tier;
  /** The Tier B reason code, present iff `tier === 'B'`. */
  reason?: TierBReason;
  /** Was the occurrence itself confirmed a live model argument? (confirmed/unverified/n/a) */
  usageVerdict: UsageVerdict;
}

/** Where one occurrence sits, and how serious it is — persisted verbatim. */
export interface ExposureOccurrence {
  file: string;
  line: number;
  column: number;
  tier: Tier;
  reason?: TierBReason;
  usageVerdict: UsageVerdict;
}

/** How many occurrences of a model landed in each tier. */
export interface TierCounts {
  A: number;
  B: number;
  C: number;
}

/**
 * The MODEL-LEVEL action a reader should take. Decided from the tier mix, NOT
 * from `highestTier` (a model with both Tier A and Tier B has highestTier 'A'
 * but still needs review). This is the field downstream tools should branch on.
 */
export type ModelDisposition =
  | 'auto_fixable' // Tier A only — a verified swap exists
  | 'review_required' // Tier B present, no Tier A
  | 'mixed_review_required' // both Tier A and Tier B — a swap AND something to review
  | 'informational'; // Tier C only — data references, nothing to do

/** One deprecated model id the repo is exposed to, with its retirement facts. */
export interface ExposedModel {
  id: string;
  provider: string;
  entryId: string;
  status: ModelLifecycle | null;
  shutdownDate: string | null;
  replacement: string;
  /** The registry's verdict for the replacement mapping (verified/quarantined/…). */
  replacementVerdict: EffectiveVerificationState;
  /** Whether the engine may auto-apply this swap — false unless fully verified. */
  autoApplyAllowed: boolean;
  sourceUrl: string | null;
  /** Total matched occurrences across the repo (may exceed `locations.length`). */
  occurrences: number;
  /** Per-tier occurrence counts — the same A/B/C tiers fix-llm reports. */
  tierCounts: TierCounts;
  /**
   * The most severe tier present (A > B > C). ORDERING ONLY — do not branch on
   * it for action; use {@link disposition}, which does not hide a Tier B under a
   * Tier A.
   */
  highestTier: Tier;
  /** The model-level action to take (the field to branch on). */
  disposition: ModelDisposition;
  /** Sorted, capped sample of where the id appears, each with its tier. */
  locations: ExposureOccurrence[];
}

/** The computed watch state: the exposed models plus the scan's honest scope. */
export interface Exposure {
  models: ExposedModel[];
  filesScanned: number;
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
  if (parsed.toISOString().slice(0, 10) !== shutdownDate) return null;
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - nowUtc) / 86_400_000);
}

/**
 * The nearest UPCOMING deadline (today or future), in days, or null when nothing
 * is still upcoming. This is what "nearest deadline" should mean — the soonest
 * thing about to break — not the most-overdue past date.
 */
export function nearestUpcomingDeadlineDays(
  models: readonly ExposedModel[],
  now: Date,
): number | null {
  let nearest: number | null = null;
  for (const model of models) {
    const days = daysUntil(model.shutdownDate, now);
    if (days === null || days < 0) continue;
    if (nearest === null || days < nearest) nearest = days;
  }
  return nearest;
}

/** The most-overdue deadline as a positive number of days, or null when none is overdue. */
export function mostOverdueDays(models: readonly ExposedModel[], now: Date): number | null {
  let most: number | null = null;
  for (const model of models) {
    const days = daysUntil(model.shutdownDate, now);
    if (days === null || days >= 0) continue;
    const overdue = -days;
    if (most === null || overdue > most) most = overdue;
  }
  return most;
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

/** The model-level disposition from its tier mix (see {@link ModelDisposition}). */
export function dispositionOf(counts: TierCounts): ModelDisposition {
  const hasA = counts.A > 0;
  const hasB = counts.B > 0;
  if (hasA && hasB) return 'mixed_review_required';
  if (hasB) return 'review_required';
  if (hasA) return 'auto_fixable';
  return 'informational';
}

/**
 * Order models RISK FIRST, then nearest deadline. Highest tier (A before B
 * before C) leads; within a tier the soonest date leads (dated before undated);
 * ties break on entry id. Pure over the model (dates order as strings).
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
 * Grouped by `entryId`; each model accumulates per-tier counts, its highest tier
 * (for ordering) and its disposition (for action), and the list is risk-first.
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
        replacementVerdict: effectiveVerificationState(match.entry),
        autoApplyAllowed: match.entry.verification?.autoApplyAllowed ?? false,
        sourceUrl: match.entry.sourceUrl ?? null,
        occurrences: 0,
        tierCounts: { A: 0, B: 0, C: 0 },
        highestTier: 'C',
        disposition: 'informational',
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
      usageVerdict: match.usageVerdict,
    });
  }

  const models = [...byEntry.values()];
  for (const model of models) {
    model.highestTier = highestOf(model.tierCounts);
    model.disposition = dispositionOf(model.tierCounts);
    model.locations.sort(compareOccurrence);
    if (model.locations.length > MAX_LOCATIONS_PER_MODEL) {
      model.locations = model.locations.slice(0, MAX_LOCATIONS_PER_MODEL);
    }
  }
  models.sort(compareByRiskThenDeadline);
  return models;
}

/** Scan `repoPath` for every registry model-id occurrence (TS + Python), classified. */
export async function scanForExposure(
  repoPath: string,
  registry: LlmRegistry,
): Promise<{ matches: ExposureMatch[]; filesScanned: number; filesMatched: number }> {
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const prefilter = buildRegistryPrefilter(registry);

  const toMatch = (m: {
    value: string;
    deprecation: LlmModelIdDeprecation;
    location: { file: string; line: number; column: number };
    position: Parameters<typeof classifyOccurrenceTier>[0]['position'];
    reason?: string;
  }): ExposureMatch => {
    const t = classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason });
    return {
      value: m.value,
      entry: m.deprecation,
      file: rel(m.location.file),
      line: m.location.line,
      column: m.location.column,
      tier: t.tier,
      reason: t.reason,
      usageVerdict: usageVerdictState(t.tier, t.reason),
    };
  };

  const { project, totalFiles: tsFiles, matchedFiles: tsMatched } = loadPrefilteredProject(
    repoPath,
    prefilter,
  );
  const tsMatches = findModelIdLiterals(project, registry).map(toMatch);

  const pyFiles = collectPythonFiles(repoPath);
  const pySourcesAll = readPythonSources(pyFiles);
  const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];
  const pyMatches = (await findPyModelIdLiterals(pySources, registry)).map(toMatch);

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

/** Occurrence-level tier totals across the repo (item 6 in the review). */
export function occurrenceTierCounts(models: readonly ExposedModel[]): {
  tierA: number;
  tierB: number;
  tierC: number;
} {
  return {
    tierA: models.reduce((s, m) => s + m.tierCounts.A, 0),
    tierB: models.reduce((s, m) => s + m.tierCounts.B, 0),
    tierC: models.reduce((s, m) => s + m.tierCounts.C, 0),
  };
}

/** Model-level disposition totals across the repo (item 6 in the review). */
export function modelDispositionCounts(models: readonly ExposedModel[]): {
  reviewRequired: number;
  autoFixable: number;
  informational: number;
} {
  let reviewRequired = 0;
  let autoFixable = 0;
  let informational = 0;
  for (const m of models) {
    if (m.disposition === 'review_required' || m.disposition === 'mixed_review_required') {
      reviewRequired += 1;
    } else if (m.disposition === 'auto_fixable') {
      autoFixable += 1;
    } else {
      informational += 1;
    }
  }
  return { reviewRequired, autoFixable, informational };
}
