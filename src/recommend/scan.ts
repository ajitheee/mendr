// The recommend pipeline: scan a repo for LIVE dead-model calls, extract each
// call's requirements, generate + filter candidates from the active catalog, and
// emit one RecommendationReceipt per dead model, ordered by deadline urgency.
//
// Composes the SAME scan primitives fix-llm and watch use (findModelIdLiterals /
// findPyModelIdLiterals via the shared prefilter + loader), so recommend's scope
// and matching agree with them by construction. Recommend keys on `model_arg`
// occurrences only — a live model argument is the thing you'd switch; a dead id
// in a data position is not a call to migrate.

import { relative } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry, TierBReason } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from '../usage/scanRepo.js';
import {
  AZURE_DEPLOYMENT_REASON,
  findModelIdLiterals,
  TYPE_CAST_REASON,
  USAGE_UNVERIFIED_REASON,
  type LiteralPosition,
} from '../usage/scanLiterals.js';
import { collectPythonFiles, findPyModelIdLiterals, readPythonSources } from '../python/scanPy.js';
import { daysUntil } from '../watch/exposure.js';

/** The human explanation for each Tier B review reason recommend surfaces. */
function reviewDetail(reason: TierBReason): string {
  switch (reason) {
    case 'usage_unverified':
      return USAGE_UNVERIFIED_REASON;
    case 'platform_blocked':
      return AZURE_DEPLOYMENT_REASON;
    case 'type_cast_masked':
      return TYPE_CAST_REASON;
    case 'replacement_unverified':
      return 'the replacement is not verified in the registry — review before migrating.';
    default:
      return 'review required — see watch/fix-llm for the full classification.';
  }
}
import type {
  ActiveModel,
  ExtractedRequirement,
  InformationalGroup,
  RecommendationReceipt,
  ReviewFinding,
} from './types.js';
import { extractRequirementsTs, mergeRequirements, unknownRequirements } from './requirements.js';
import { filterCandidates } from './filter.js';
import { buildReceipt } from './receipt.js';

type Provider = 'openai' | 'anthropic' | 'google';

/** One live dead-model occurrence with its per-site requirement profile. */
interface OccurrenceGroup {
  dead: LlmModelIdDeprecation;
  perOccurrence: ExtractedRequirement[][];
}

export interface RecommendScan {
  receipts: RecommendationReceipt[];
  /** Deprecated ids found in a position with no extractable requirements (review). */
  reviewRequired: ReviewFinding[];
  /** Deprecated ids found only in data positions, grouped by id. */
  informational: InformationalGroup[];
  /** Distinct physical model_arg call sites (not per-registry-entry). */
  liveCallSites: number;
  filesScanned: number;
  filesMatched: number;
}

export interface RecommendOptions {
  /** Draw candidates from this provider; default = each dead model's own provider. */
  candidateProvider?: Provider;
  sortBy: 'cost' | 'context' | null;
  now: Date;
}

/** Order receipts by deadline urgency: most-overdue/soonest first, undated last. */
function compareByDeadline(a: RecommendationReceipt, b: RecommendationReceipt): number {
  const da = a.deadlineDays === null ? Infinity : a.deadlineDays;
  const db = b.deadlineDays === null ? Infinity : b.deadlineDays;
  if (da !== db) return da - db;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** Scan `repoPath` and build recommendation receipts. */
export async function scanForRecommendations(
  repoPath: string,
  registry: LlmRegistry,
  catalog: readonly ActiveModel[],
  opts: RecommendOptions,
): Promise<RecommendScan> {
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const prefilter = buildRegistryPrefilter(registry);

  // Three buckets, so recommend never hides a finding watch/fix-llm would show:
  //   model_arg        -> a recommendation receipt (requirement extraction + filter)
  //   usage_unverified -> a review finding (can't prove it's a model call)
  //   azure_deployment -> a review finding (deployment alias, not a model id)
  //   data             -> informational (a config/list/comparison reference)
  // The scanner emits one match PER registry entry per node (a multimap). For
  // model_arg that fan-out is intentional (each receipt carries its own
  // deadline/replacement). For the review + informational buckets it is noise —
  // two registry entries for one id would duplicate a physical site — so those
  // buckets and the physical counts dedupe by (file:line:column).
  const groups = new Map<string, OccurrenceGroup>();
  const modelArgSites = new Set<string>();
  const reviewSeen = new Set<string>();
  const reviewRequired: ReviewFinding[] = [];
  const infoByDeprecated = new Map<
    string,
    { deprecated: string; entryId: string; provider: string; sites: Set<string> }
  >();

  const recordCall = (dead: LlmModelIdDeprecation, requirements: ExtractedRequirement[]): void => {
    const id = displayEntryId(dead);
    let g = groups.get(id);
    if (!g) {
      g = { dead, perOccurrence: [] };
      groups.set(id, g);
    }
    g.perOccurrence.push(requirements);
  };

  const bucket = (
    dead: LlmModelIdDeprecation,
    position: LiteralPosition,
    matchReason: string | undefined,
    loc: { file: string; line: number; column: number },
    requirements: () => ExtractedRequirement[],
  ): void => {
    const site = `${loc.file}:${loc.line}:${loc.column}`;
    if (position === 'model_arg') {
      recordCall(dead, requirements());
      modelArgSites.add(site);
      return;
    }
    // Route every non-live occurrence through the SHARED classifier, so recommend,
    // watch, and fix-llm assign the SAME tier to the same site — a type_cast_masked
    // `data` position is Tier B review, NOT informational, and never disappears.
    const t = classifyOccurrenceTier({ position, deprecation: dead, reason: matchReason });
    if (t.tier === 'B' && t.reason) {
      const key = `${site}:${t.reason}`;
      if (reviewSeen.has(key)) return; // one row per physical site, not per registry entry
      reviewSeen.add(key);
      reviewRequired.push({
        deprecated: dead.deprecated,
        entryId: displayEntryId(dead),
        provider: dead.provider,
        file: loc.file,
        line: loc.line,
        reason: t.reason,
        detail: reviewDetail(t.reason),
      });
    } else {
      // Tier C -> informational, grouped by the deprecated id STRING, distinct sites.
      let g = infoByDeprecated.get(dead.deprecated);
      if (!g) {
        g = { deprecated: dead.deprecated, entryId: displayEntryId(dead), provider: dead.provider, sites: new Set() };
        infoByDeprecated.set(dead.deprecated, g);
      }
      g.sites.add(site);
    }
  };

  // TypeScript — full requirement extraction over the live node for model_arg.
  const { project, totalFiles: tsFiles, matchedFiles: tsMatched } = loadPrefilteredProject(
    repoPath,
    prefilter,
  );
  for (const m of findModelIdLiterals(project, registry)) {
    const loc = { file: rel(m.location.file), line: m.location.line, column: m.location.column };
    bucket(m.deprecation, m.position, m.reason, loc, () => extractRequirementsTs(m.node, `${loc.file}:${loc.line}`));
  }

  // Python — model_arg surfaced with all-unknown requirements (M1 limitation).
  const pyFiles = collectPythonFiles(repoPath);
  const pySourcesAll = readPythonSources(pyFiles);
  const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];
  for (const m of await findPyModelIdLiterals(pySources, registry)) {
    const loc = { file: rel(m.location.file), line: m.location.line, column: m.location.column };
    bucket(m.deprecation, m.position, m.reason, loc, () =>
      unknownRequirements(`${loc.file}:${loc.line} — python call (requirements not analyzed in M1)`),
    );
  }

  const receipts: RecommendationReceipt[] = [];
  for (const { dead, perOccurrence } of groups.values()) {
    const candidateProvider = (opts.candidateProvider ?? (dead.provider as Provider)) as Provider;
    const requirements = mergeRequirements(perOccurrence);
    const filter = filterCandidates(dead, requirements, catalog, candidateProvider, opts.sortBy);
    receipts.push(
      buildReceipt({
        dead,
        candidateProvider,
        occurrences: perOccurrence.length,
        requirements,
        filter,
        sortBy: opts.sortBy,
        deadlineDays: daysUntil(dead.shutdownDate, opts.now),
      }),
    );
  }

  receipts.sort(compareByDeadline);
  reviewRequired.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line));
  const informational: InformationalGroup[] = [...infoByDeprecated.values()]
    .map((g) => ({ deprecated: g.deprecated, entryId: g.entryId, provider: g.provider, occurrences: g.sites.size }))
    .sort((a, b) => (a.deprecated < b.deprecated ? -1 : a.deprecated > b.deprecated ? 1 : 0));

  return {
    receipts,
    reviewRequired,
    informational,
    liveCallSites: modelArgSites.size,
    filesScanned: tsFiles + pyFiles.length,
    filesMatched: tsMatched + pySources.length,
  };
}
