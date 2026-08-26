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
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import { buildRegistryPrefilter, loadPrefilteredProject } from '../usage/scanRepo.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { collectPythonFiles, findPyModelIdLiterals, readPythonSources } from '../python/scanPy.js';
import { daysUntil } from '../watch/exposure.js';
import type { ActiveModel, ExtractedRequirement, RecommendationReceipt } from './types.js';
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

  // Group live occurrences by the dead model's stable entryId.
  const groups = new Map<string, OccurrenceGroup>();
  const record = (dead: LlmModelIdDeprecation, requirements: ExtractedRequirement[]): void => {
    const id = displayEntryId(dead);
    let g = groups.get(id);
    if (!g) {
      g = { dead, perOccurrence: [] };
      groups.set(id, g);
    }
    g.perOccurrence.push(requirements);
  };

  // TypeScript — full requirement extraction over the live node.
  const { project, totalFiles: tsFiles, matchedFiles: tsMatched } = loadPrefilteredProject(
    repoPath,
    prefilter,
  );
  for (const m of findModelIdLiterals(project, registry)) {
    if (m.position !== 'model_arg') continue;
    const at = `${rel(m.location.file)}:${m.location.line}`;
    record(m.deprecation, extractRequirementsTs(m.node, at));
  }

  // Python — occurrences surfaced with all-unknown requirements (M1 limitation).
  const pyFiles = collectPythonFiles(repoPath);
  const pySourcesAll = readPythonSources(pyFiles);
  const pySources = prefilter ? pySourcesAll.filter((s) => prefilter.test(s.text)) : [];
  for (const m of await findPyModelIdLiterals(pySources, registry)) {
    if (m.position !== 'model_arg') continue;
    const at = `${rel(m.location.file)}:${m.location.line}`;
    record(m.deprecation, unknownRequirements(`${at} — python call (requirements not analyzed in M1)`));
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
  return { receipts, filesScanned: tsFiles + pyFiles.length, filesMatched: tsMatched + pySources.length };
}
