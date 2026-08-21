import type { TierBReason, VerificationStatus } from '../types.js';

// The THREE-TIER report vocabulary, in one place.
//
// WHY this module exists at all: the tier a finding lands in, the number the
// counts line prints for that tier, and the items the section lists under it
// used to be computed in three different places inside cli.ts's action body.
// Nothing stopped them drifting, and nothing could test that they hadn't — a
// report that says "4 tier B" over three printed findings is a report a reader
// stops believing. Here the counts are DERIVED from the very arrays that get
// printed, so the two cannot disagree, and the pure functions are drivable
// from a test without spawning the CLI.
//
// Tier B is never auto-applied and never written. That is not a policy this
// module enforces (cli.ts does, by never handing these findings to the fixer);
// it is a claim every rendering here makes out loud, so a reader never has to
// infer whether a patch exists.

/**
 * The plain-English half of every Tier B reason. The CODE is what a script
 * routes on; this sentence is what a human reads, and the two always ship
 * together — a bare `usage_unverified` tells a person nothing about what to go
 * look at.
 *
 * CONSTRAINT: one entry per union member, including the two RESERVED codes. A
 * code with no sentence would render as a blank explanation the day a detector
 * starts emitting it; the type makes forgetting one a compile error.
 */
export const TIER_B_REASON_TEXT: Record<TierBReason, string> = {
  usage_unverified:
    'assigned to a model-like variable, but no supported SDK call or parameter sink was found in this file.',
  replacement_unverified:
    "found in a live model argument, but the registry's replacement has not cleared verification against the public model catalogs.",
  // WHAT WAS ACTUALLY CHECKED: the enclosing property key is one of
  // `deployment` / `deploymentName` / `deployment_name` (isAzureDeploymentName).
  // mendr has NOT inspected the value's nature -- an Azure deployment is
  // frequently named after the model it serves, and this key appears in
  // non-Azure configs too. So the sentence reports the POSITION as fact and
  // marks the provisioning conclusion as the inference it is.
  platform_blocked:
    'sits under a deployment key rather than in a model argument; on Azure and similar platforms that key names a provisioned deployment, so changing it is likely a provisioning change rather than a code change.',
  dynamic_model_value:
    'the model value is assembled at runtime, so no single literal here can carry the migration.',
  insufficient_dataflow:
    'the value could not be traced to a definite use, so the migration cannot be shown to be safe.',
  // WHAT WAS ACTUALLY CHECKED: the literal sits in a model argument and is
  // wrapped in an `as` cast to something other than `string`/`const`
  // (classifyLiteral's maskingCast). mendr does NOT resolve the cast target, so
  // it cannot know the type is a union of model ids -- `as any` fires this too.
  // The sentence therefore names the cast, and hedges what the cast implies.
  type_cast_masked:
    "the model argument is wrapped in an `as` cast to a named type, so this repo may constrain model ids with a type of its own; swapping the raw string could bypass that check.",
};

/**
 * Print order for the Tier B section: most actionable first. A live call whose
 * replacement is merely unproven is one verification away from a patch; a cast
 * masking a repo's own union is a design question. Ordering by actionability
 * means a reader who stops halfway has read the findings worth stopping for.
 *
 * The two RESERVED codes sit last so that if a future detector starts emitting
 * one, it appears in a defined place rather than an arbitrary one.
 */
export const TIER_B_REASON_ORDER: readonly TierBReason[] = [
  'replacement_unverified',
  'platform_blocked',
  'usage_unverified',
  'type_cast_masked',
  'dynamic_model_value',
  'insufficient_dataflow',
];

/** One Tier B finding: a potential migration a human must decide on. */
export interface TierBFinding {
  /** Repo-relative display path (forward slashes). */
  file: string;
  line: number;
  column: number;
  /** The deprecated model id found at this position. */
  modelId: string;
  /** The id the registry WOULD migrate to. Context only — no patch is generated. */
  replacement: string;
  /** The machine-readable reason this is review-only. */
  reason: TierBReason;
  /** The plain-English sentence for {@link reason} (always {@link TIER_B_REASON_TEXT}). */
  reasonText: string;
  /**
   * Extra audit lines shown under the finding (the verification gate's own
   * reasons, for `replacement_unverified`). NOT part of the JSON `tierB`
   * shape — the legacy `blocked` array already carries them, and duplicating a
   * free-text array into a documented record invites two of them drifting.
   */
  detail?: string[];
  /**
   * The verification verdict that blocked the swap, for `replacement_unverified`.
   * Kept on the finding so the legacy `blocked` JSON array can be DERIVED from
   * the Tier B list rather than rebuilt from a second pass over the scan.
   */
  status?: VerificationStatus | 'unstamped';
}

/** The position + identity half of a Tier B finding, before a reason is attached. */
export interface TierBSite {
  file: string;
  line: number;
  column: number;
  modelId: string;
  replacement: string;
  detail?: string[];
  status?: VerificationStatus | 'unstamped';
}

/**
 * Attach a reason code (and its sentence) to a located site. The single
 * constructor for a Tier B finding: `reasonText` is never passed in, so it can
 * never disagree with `reason`.
 */
export function tierBFinding(site: TierBSite, reason: TierBReason): TierBFinding {
  return { ...site, reason, reasonText: TIER_B_REASON_TEXT[reason] };
}

/**
 * Order a Tier B list for printing: by reason (see {@link TIER_B_REASON_ORDER}),
 * then by file, line and column. Stable and total, so the section reads the
 * same on every run — a report whose lines shuffle between runs is one nobody
 * can diff.
 */
export function orderTierB(findings: readonly TierBFinding[]): TierBFinding[] {
  const rank = (r: TierBReason): number => {
    const i = TIER_B_REASON_ORDER.indexOf(r);
    return i === -1 ? TIER_B_REASON_ORDER.length : i;
  };
  return [...findings].sort(
    (a, b) =>
      rank(a.reason) - rank(b.reason) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

/** Count of each reason present, in print order. Empty reasons are omitted. */
export function tierBReasonCounts(
  findings: readonly TierBFinding[],
): { reason: TierBReason; count: number }[] {
  const counts = new Map<TierBReason, number>();
  for (const f of findings) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
  return TIER_B_REASON_ORDER.filter((r) => counts.has(r)).map((r) => ({
    reason: r,
    count: counts.get(r)!,
  }));
}

/**
 * The JSON projection of a Tier B finding: exactly the seven documented keys,
 * in the documented order. `detail`/`status` stay out — they are internal
 * plumbing for the derived legacy arrays, not part of the published shape.
 */
export function tierBJson(f: TierBFinding): {
  file: string;
  line: number;
  column: number;
  modelId: string;
  replacement: string;
  reason: TierBReason;
  reasonText: string;
} {
  return {
    file: f.file,
    line: f.line,
    column: f.column,
    modelId: f.modelId,
    replacement: f.replacement,
    reason: f.reason,
    reasonText: f.reasonText,
  };
}

// --- rendering -------------------------------------------------------------

/** Label column width, so `found:` / `replacement:` / `reason:` values align. */
const TIER_B_LABEL_WIDTH = 13;

/** Total line width the reason sentence wraps to (continuation lines hang). */
const TIER_B_WRAP_COLUMNS = 78;

/** The heading the Tier B section prints, ordered between Tier A and Tier C. */
export const TIER_B_HEADING = '=== Tier B: review required ===';

/**
 * The fixed action line. Its whole job is to close the question a reader would
 * otherwise carry into every finding — "is there a diff for this somewhere?" —
 * with a flat no, once per finding rather than once per section.
 */
export const TIER_B_ACTION_LINE = 'no patch generated.';

/** Greedy word-wrap to `width`, never breaking inside a word. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Render one Tier B finding as its block of lines, relative to the section
 * (the caller adds no further indent):
 *
 *   agent_app/simulator.py:166:13
 *     found:       "gpt-4"
 *     replacement: "gpt-5.6-sol"
 *     reason:      usage_unverified -- assigned to a model-like variable, but no
 *                  supported SDK call or parameter sink was found in this file.
 *     action:      no patch generated.
 *
 * The location leads because it is what a reader acts on; the reason carries
 * BOTH forms (code for a script, sentence for a person) on the same rows.
 */
export function formatTierBFinding(f: TierBFinding): string[] {
  const row = (label: string, value: string): string =>
    `  ${`${label}:`.padEnd(TIER_B_LABEL_WIDTH)}${value}`;
  const valueColumn = 2 + TIER_B_LABEL_WIDTH;
  const reasonBody = wrap(
    `${f.reason} -- ${f.reasonText}`,
    TIER_B_WRAP_COLUMNS - valueColumn,
  );
  return [
    `${f.file}:${f.line}:${f.column}`,
    row('found', `"${f.modelId}"`),
    row('replacement', `"${f.replacement}"`),
    row('reason', reasonBody[0]),
    ...reasonBody.slice(1).map((line) => `${' '.repeat(valueColumn)}${line}`),
    ...(f.detail ?? []).map((d) => `${' '.repeat(valueColumn)}- ${d}`),
    row('action', TIER_B_ACTION_LINE),
  ];
}

/**
 * The whole Tier B section, or `[]` when there is nothing to review. Findings
 * are ordered here rather than by the caller, so every surface that prints
 * Tier B prints it in the same order.
 */
export function formatTierBSection(findings: readonly TierBFinding[]): string[] {
  if (findings.length === 0) return [];
  const lines: string[] = [TIER_B_HEADING];
  for (const f of orderTierB(findings)) {
    lines.push('');
    lines.push(...formatTierBFinding(f));
  }
  return lines;
}

// --- counts ----------------------------------------------------------------

/**
 * The three tier counts a report prints.
 *
 * CONSTRAINT (the one this whole module exists for): each number here must
 * equal the number of items the matching section LISTS. Callers must therefore
 * build these from the printed arrays' lengths, never from a parallel tally.
 */
export interface TierCounts {
  /** Tier A candidate SITES found (applied or downgraded — see {@link SummaryDisposition}). */
  tierA: number;
  /** Tier B findings listed in the Tier B section. */
  tierB: number;
  /** Tier C data-position hits summarized in the informational section. */
  tierC: number;
}

/**
 * The `Found:` block. Continuation lines are indented to line up under the
 * first tier, and the per-reason breakdown only appears when Tier B is
 * non-empty — "tier B by reason:" over nothing is noise, not information.
 *
 * @param tierCContext optional trailing clause for the Tier C line (the
 *        catalog-majority note), already phrased by the caller.
 */
export function formatFoundLines(
  counts: TierCounts,
  findings: readonly TierBFinding[],
  tierCContext = '',
): string[] {
  const lines = [
    `Found: ${counts.tierA} tier A (safe automatic patch), ` +
      `${counts.tierB} tier B (potential migration, review required),`,
    `       ${counts.tierC} tier C (informational data occurrence${tierCContext}).`,
  ];
  const byReason = tierBReasonCounts(findings);
  if (byReason.length > 0) {
    lines.push(`       tier B by reason: ${byReason.map((r) => `${r.reason} ${r.count}`).join(', ')}.`);
  }
  return lines;
}

/**
 * What actually happened to the Tier A candidates (they are the only tier with
 * a disposition). THREE outcomes, not two: "the gates passed" and "the file on
 * disk changed" are different facts, and a run without `--write` produces the
 * first without the second. Collapsing them is how a read-only run ends up
 * printing "1 auto-fixed" directly above "To apply: re-run with --write".
 */
export interface SummaryDisposition {
  /** Sites this run WRITES to the working tree (`--write`, gates run). */
  applied: number;
  /** Sites whose patch is on screen but NOT written — the read-only default. */
  ready: number;
  /** Sites whose gates failed, shown for manual review instead. */
  downgraded: number;
}

/**
 * The closing `Summary:` block, in the same three-tier vocabulary as the
 * `Found:` block and carrying the same three numbers. Tier A additionally
 * reports its disposition, because "2 tier A" alone cannot distinguish a patch
 * that landed on disk from one shown for review from one the gates rejected.
 *
 * The three dispositions sum to `counts.tierA`; only the non-zero ones print,
 * and a Tier A of zero still renders `0 auto-fixed` so the slot never vanishes.
 */
export function formatSummaryLines(
  counts: TierCounts,
  disposition: SummaryDisposition,
): string[] {
  // `auto-fixed` is ALWAYS printed, even as a zero: it is the number a reader
  // is looking for, and a slot that disappears when it is zero is a slot that
  // cannot be checked. The other two dispositions print only when non-empty.
  const rest = [
    // Never "auto-fixed": the working tree is untouched until --write runs.
    disposition.ready > 0 ? `${disposition.ready} ready to apply -- not written` : '',
    disposition.downgraded > 0
      ? `${disposition.downgraded} downgraded -- gates failed, not applied`
      : '',
  ].filter(Boolean);
  const tierADetail = [`${disposition.applied} auto-fixed`, ...rest].join(', ');
  return [
    `Summary: tier A ${counts.tierA} (${tierADetail}), ` +
      `tier B ${counts.tierB} (review required -- no patch generated),`,
    `         tier C ${counts.tierC} (informational -- no action).`,
  ];
}

// --- uniqueness ------------------------------------------------------------

/**
 * The identity of a finding: file + line + column + model id. Findings are
 * unique by this key across EVERY tier — a reviewer double-counting one
 * position would inflate the debt a repo appears to carry, and a machine
 * consumer deduping on a weaker key would silently drop real findings that
 * share a line. Exported so the regression test can assert the property
 * against whatever the scanners produce, rather than trusting it.
 */
export function findingKey(f: {
  file: string;
  line: number;
  column: number;
  modelId: string;
}): string {
  return `${f.file}:${f.line}:${f.column}:${f.modelId}`;
}
