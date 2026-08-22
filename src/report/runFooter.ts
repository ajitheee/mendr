import { findingKey, type TierCounts, type TierOccurrence } from './tiers.js';

// WHAT THIS RUN DID, in three lines above the registry block.
//
// The report could say "tier A 1 (1 auto-fixed)" and still leave two questions
// a reader had to answer by scrolling: was this run even allowed to touch my
// files, and how many did it touch? `Summary:` answers the second only for the
// happy path — a refused write, a `--skip-gates --write`, or a run with nothing
// eligible all reach the end of the report with the working tree untouched, and
// each explains itself in a different sentence in a different place.
//
// So the footer states the two facts flatly, next to the count that ties the
// whole report together:
//
//   mode: LOOK
//   unique occurrences: 4
//   files modified: 0
//
// MODE IS INTENT; FILES MODIFIED IS OUTCOME. They are deliberately two lines.
// A `--write` run that wrote nothing still says `WRITE`, because that is what
// the user asked for and the refusal message already explains why — collapsing
// it to LOOK would hide the attempt. `files modified` carries the truth, and it
// is wired to the write RESULT, never to the intent to write.

/** LOOK = no `--write` on this run. WRITE = `--write` was passed. */
export type RunMode = 'LOOK' | 'WRITE';

/** The mode from the flag alone: intent, not outcome (see the module note). */
export function runMode(write: boolean | undefined): RunMode {
  return write ? 'WRITE' : 'LOOK';
}

/**
 * The occurrence count and everything needed to check it.
 *
 * THE IDENTITY THIS EXISTS TO KEEP: `total` must equal tier A + tier B + tier
 * C. A "unique occurrences" number a reader cannot reconcile with the three
 * numbers directly above it is worse than no number at all — it reads as a
 * fourth, secret tally.
 *
 * PARAM TRANSFORM SITES ARE WHY THIS IS NOT ONE SUBTRACTION. A `temperature`
 * removal is counted in tier A, but its key would be a PARAM name inside the
 * model-id key space, so it is deliberately absent from the occurrence list
 * (see cli.ts's `tierOccurrences`). They are therefore added back HERE, as
 * their own named quantity, so the printed total reconciles AND the reader can
 * see what it is made of. When the two still disagree the line says so out
 * loud rather than printing a number nothing supports.
 */
export interface UniqueOccurrences {
  /** Distinct (file, line, column, modelId) keys across every tier. */
  modelId: number;
  /** Param-transform sites: tier A, outside the model-id key space. */
  paramSites: number;
  /** The number printed: `modelId + paramSites`. */
  total: number;
  /** `tierA + tierB + tierC`, the number `total` must equal. */
  tierSum: number;
  /** Do they agree? False is a bug in the counting, and prints as one. */
  reconciles: boolean;
}

/** Count distinct occurrences and check them against the tier counts. */
export function countUniqueOccurrences(
  occurrences: readonly TierOccurrence[],
  paramSites: number,
  counts: TierCounts,
): UniqueOccurrences {
  const modelId = new Set(occurrences.map(findingKey)).size;
  const total = modelId + paramSites;
  const tierSum = counts.tierA + counts.tierB + counts.tierC;
  return { modelId, paramSites, total, tierSum, reconciles: total === tierSum };
}

/**
 * The `unique occurrences:` line. Bare when there is nothing to explain;
 * itemised as soon as param transforms contribute; and explicitly flagged as
 * irreconcilable — naming the tier sum, and saying which number to trust — if
 * the identity ever breaks.
 */
export function formatUniqueOccurrenceLine(u: UniqueOccurrences): string {
  const breakdown =
    u.paramSites > 0 ? ` (${u.modelId} model-id + ${u.paramSites} param transform)` : '';
  if (u.reconciles) return `unique occurrences: ${u.total}${breakdown}`;
  return (
    `unique occurrences: ${u.total}${breakdown} -- does NOT reconcile with the tier counts ` +
    `(tier A + B + C = ${u.tierSum}); the tier counts are authoritative`
  );
}

/** Everything the run block reports. `filesModified` is a post-write fact. */
export interface RunFooterView {
  mode: RunMode;
  occurrences: UniqueOccurrences;
  /**
   * Files actually written to disk. Always 0 in LOOK mode; in WRITE mode it is
   * the length of the write result, so a refused or rolled-back write reports
   * 0 under `mode: WRITE`.
   */
  filesModified: number;
}

/** The three run lines, in order, for printing above the registry footer. */
export function formatRunFooterLines(view: RunFooterView): string[] {
  return [
    `mode: ${view.mode}`,
    formatUniqueOccurrenceLine(view.occurrences),
    `files modified: ${view.filesModified}`,
  ];
}
