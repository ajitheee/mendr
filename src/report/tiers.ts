import type { TierBReason } from '../types.js';
import type { EffectiveVerificationState } from '../usage/llmRegistry.js';

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

/**
 * WHAT THE REGISTRY RECORDED about this mapping — nothing more.
 *
 * This field used to be called `replacementEvidence`, and its row read
 * `replacement evidence: unverified (this mapping is not catalog-confirmed)`.
 * Both halves overclaimed. `entry.evidence` — the field that holds actual
 * provenance, with source urls and content hashes — is EMPTY on every shipped
 * entry, and `registries/evidence/` holds no snapshots, so "evidence" named
 * the one thing the data does not have. And "not catalog-confirmed" was
 * flatly wrong for the entries whose recorded reasons DO say the replacement
 * is live in a public catalog.
 *
 * So the concept is named for what it actually is: the verdict stored in the
 * registry's `verification` block, stamped on some past date by some past run.
 * A Tier B finding still needs it — the difference between "swap this once you
 * have cleared the usage question" and "check this mapping before you trust it
 * at all" is exactly this verdict — and it still changes the WORD as well as
 * the value, because a reader skimming for the id reads the label and may
 * never reach the row below it.
 *
 * THREE values, not two. `self-contradicted` is a stamp that says `verified`
 * over reasons that say the opposite (see `hasSelfContradictingReasons`): the
 * engine holds it back like an unverified one, but reporting it AS
 * `unverified` would contradict what `mendr evidence <id>` prints from the
 * same file.
 */
export type RegistryVerdict = 'verified' | 'unverified' | 'self-contradicted';

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
  /** The verdict the registry RECORDED for this mapping (see {@link RegistryVerdict}). */
  registryVerdict: RegistryVerdict;
  /** The date that verdict was stamped (`verification.checkedAt`), if it carries one. */
  verdictCheckedAt?: string;
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
  status?: EffectiveVerificationState;
}

/** The position + identity half of a Tier B finding, before a reason is attached. */
export interface TierBSite {
  file: string;
  line: number;
  column: number;
  modelId: string;
  replacement: string;
  /**
   * Defaults to `'unverified'` when the caller cannot say. FAIL CLOSED: the
   * expensive mistake here is printing `verified` over a mapping nobody
   * checked, so silence never earns the stronger word.
   */
  registryVerdict?: RegistryVerdict;
  verdictCheckedAt?: string;
  detail?: string[];
  status?: EffectiveVerificationState;
}

/**
 * Attach a reason code (and its sentence) to a located site. The single
 * constructor for a Tier B finding: `reasonText` is never passed in, so it can
 * never disagree with `reason`.
 *
 * The registry verdict is likewise NORMALISED here rather than trusted: a
 * `replacement_unverified` finding is BY DEFINITION one whose replacement did
 * not clear verification, so it can never carry `'verified'`. Letting a caller
 * pass it would print a block that contradicts itself in two adjacent rows.
 * `'self-contradicted'` survives, because it is not a claim that the mapping
 * cleared anything — it is the reason this finding is here at all.
 */
export function tierBFinding(site: TierBSite, reason: TierBReason): TierBFinding {
  const declared = site.registryVerdict ?? 'unverified';
  const registryVerdict: RegistryVerdict =
    reason === 'replacement_unverified' && declared === 'verified' ? 'unverified' : declared;
  return { ...site, registryVerdict, reason, reasonText: TIER_B_REASON_TEXT[reason] };
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
 * The JSON projection of a Tier B finding: exactly the nine documented keys,
 * in the documented order. `detail`/`status` stay out — they are internal
 * plumbing for the derived legacy arrays, not part of the published shape.
 *
 * `registryVerdict` sits next to `replacement` deliberately: a machine
 * consumer that reads one and not the other is exactly the reader this field
 * exists for, and adjacency is the cheapest way to make skipping it deliberate.
 * `verdictCheckedAt` rides with it because a verdict with no date is a verdict
 * whose age a consumer cannot judge — it is `null` when the entry carries none.
 */
export function tierBJson(f: TierBFinding): {
  file: string;
  line: number;
  column: number;
  modelId: string;
  replacement: string;
  registryVerdict: RegistryVerdict;
  verdictCheckedAt: string | null;
  reason: TierBReason;
  reasonText: string;
} {
  return {
    file: f.file,
    line: f.line,
    column: f.column,
    modelId: f.modelId,
    replacement: f.replacement,
    registryVerdict: f.registryVerdict,
    verdictCheckedAt: f.verdictCheckedAt ?? null,
    reason: f.reason,
    reasonText: f.reasonText,
  };
}

// --- rendering -------------------------------------------------------------

/**
 * Label column width, so `found:` / `candidate replacement:` /
 * `registry verdict:` / `reason:` values align. Sized to the longest label
 * (`candidate replacement:`, 22 chars) plus one space.
 */
const TIER_B_LABEL_WIDTH = 23;

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
 * The LABEL the replacement id is printed under. A verified mapping is a
 * `replacement`; anything else is a `candidate replacement`, because the
 * verdict row below can be skipped and a label cannot.
 */
export function replacementLabel(verdict: RegistryVerdict): string {
  return verdict === 'verified' ? 'replacement' : 'candidate replacement';
}

/**
 * The `registry verdict:` VALUE — a report of what is stored in the registry,
 * phrased so it cannot be read as something mendr checked during this run.
 *
 * Every word here is answerable from the registry JSON alone:
 *   - `verified` names the stamp and its date, and says out loud that no
 *     catalog was contacted this run (a `fix-llm` run makes no network call);
 *   - `unverified` says the mapping did not clear verification, and points at
 *     the command that prints the recorded reasoning;
 *   - `self-contradicted` is the fail-safe case: the file says `verified` and
 *     its own reasons say otherwise, so both halves are stated rather than
 *     silently resolved to the weaker one.
 */
export function registryVerdictText(f: TierBFinding): string {
  const evidenceCmd = `\`mendr evidence ${f.modelId}\``;
  if (f.registryVerdict === 'verified') {
    const stamped = f.verdictCheckedAt ? `stamped ${f.verdictCheckedAt}` : 'stamp carries no date';
    return `verified (${stamped}; not re-checked live this run)`;
  }
  if (f.registryVerdict === 'self-contradicted') {
    const stamped = f.verdictCheckedAt ? ` ${f.verdictCheckedAt}` : ' (undated)';
    return (
      `stamped verified${stamped}, but withheld -- the entry's own recorded reasons ` +
      `contradict the stamp (see ${evidenceCmd})`
    );
  }
  return `unverified -- this mapping did not clear verification (see ${evidenceCmd})`;
}

/**
 * Render one Tier B finding as its block of lines, relative to the section
 * (the caller adds no further indent):
 *
 *   agent_app/simulator.py:166:13
 *     found:                 "gpt-4"
 *     replacement:           "gpt-5.6-sol"
 *     registry verdict:      verified (stamped 2026-08-21; not re-checked live
 *                            this run)
 *     reason:                usage_unverified -- assigned to a model-like
 *                            variable, but no supported SDK call or parameter
 *                            sink was found in this file.
 *     action:                no patch generated.
 *
 * The location leads because it is what a reader acts on; the reason carries
 * BOTH forms (code for a script, sentence for a person) on the same rows; and
 * the replacement never appears without the registry's verdict beside it.
 */
export function formatTierBFinding(f: TierBFinding): string[] {
  const valueColumn = 2 + TIER_B_LABEL_WIDTH;
  const row = (label: string, value: string): string[] => {
    const body = wrap(value, TIER_B_WRAP_COLUMNS - valueColumn);
    return [
      `  ${`${label}:`.padEnd(TIER_B_LABEL_WIDTH)}${body[0]}`,
      ...body.slice(1).map((line) => `${' '.repeat(valueColumn)}${line}`),
    ];
  };
  return [
    `${f.file}:${f.line}:${f.column}`,
    ...row('found', `"${f.modelId}"`),
    ...row(replacementLabel(f.registryVerdict), `"${f.replacement}"`),
    ...row('registry verdict', registryVerdictText(f)),
    ...row('reason', `${f.reason} -- ${f.reasonText}`),
    ...(f.detail ?? []).map((d) => `${' '.repeat(valueColumn)}- ${d}`),
    ...row('action', TIER_B_ACTION_LINE),
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
  /** Sites this run WROTE to the working tree — the files are changed on disk. */
  applied: number;
  /** Sites whose patch is on screen but NOT written — the read-only default. */
  ready: number;
  /** Sites whose gates failed, shown for manual review instead. */
  downgraded: number;
  /**
   * Sites whose patch PASSED its gates and still did not land, because the
   * all-or-nothing write refused (a read-only file, a file locked by an
   * editor, content that drifted since the scan). A FOURTH outcome, distinct
   * from all three above: the gates did not fail, the run did ask for a write,
   * and the working tree is nonetheless untouched. Defaults to 0 — a caller
   * that does not know about write refusals cannot accidentally claim one.
   */
  refused?: number;
}

/**
 * The closing `Summary:` block, in the same three-tier vocabulary as the
 * `Found:` block and carrying the same three numbers. Tier A additionally
 * reports its disposition, because "2 tier A" alone cannot distinguish a patch
 * that landed on disk from one shown for review from one the gates rejected.
 *
 * The four dispositions sum to `counts.tierA`; only the non-zero ones print,
 * and a Tier A of zero still renders `0 auto-fixed` so the slot never vanishes.
 *
 * `applied` is a claim about the FILESYSTEM, so a caller may only pass it once
 * the write has actually returned. Computing this block from the intention to
 * write is how a report ends up saying "3 auto-fixed" over an aborted write.
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
    // The refusal case says WRITE, not GATES: the patch was good and the file
    // would not take it. Reading that as a gate failure sends a user off to
    // debug a diff that is fine.
    (disposition.refused ?? 0) > 0
      ? `${disposition.refused} not written -- write refused, working tree unchanged`
      : '',
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

// --- single terminal tier --------------------------------------------------
//
// THE RULE, stated once so it can be tested instead of inferred: every
// OCCURRENCE — one (file, line, column, deprecatedId) — lands in exactly ONE
// terminal tier. Not "usually one". One. The tier is resolved by precedence,
// A before B before C: a position that is both a live verified model argument
// and a data-shaped literal is a live model argument, and a position that is
// both review-required and informational is review-required.
//
// This used to be true by construction and said nowhere, which is precisely
// how a property stops being true. It also made a REPORTING bug unfalsifiable
// from the outside: when the same deprecated id appears at two different
// positions in two different tiers, a reader with no line numbers cannot tell
// that from one occurrence counted twice — and two reviewers duly read it as
// double counting. The invariant below is what lets the report say "these are
// different occurrences" and mean it.

/** The terminal tiers, in precedence order: the FIRST match wins. */
export const TIER_PRECEDENCE = ['A', 'B', 'C'] as const;

/** A terminal tier. */
export type Tier = (typeof TIER_PRECEDENCE)[number];

/** One classified occurrence: a position, an id, and the tier it landed in. */
export interface TierOccurrence {
  tier: Tier;
  file: string;
  line: number;
  column: number;
  modelId: string;
}

/**
 * Resolve the ONE terminal tier for an occurrence a classifier offered more
 * than one tier for. Precedence is {@link TIER_PRECEDENCE}: A > B > C.
 * Returns `undefined` only for an empty candidate list (no tier at all).
 */
export function resolveTerminalTier(candidates: readonly Tier[]): Tier | undefined {
  return TIER_PRECEDENCE.find((tier) => candidates.includes(tier));
}

/**
 * Every occurrence key that landed in MORE THAN ONE tier, rendered as a
 * human-readable line. Empty is the healthy answer; a non-empty result is a
 * classifier bug, never a report to be phrased around.
 */
export function crossTierCollisions(occurrences: readonly TierOccurrence[]): string[] {
  const tiersByKey = new Map<string, Set<Tier>>();
  for (const o of occurrences) {
    const key = findingKey(o);
    const tiers = tiersByKey.get(key);
    if (tiers) tiers.add(o.tier);
    else tiersByKey.set(key, new Set([o.tier]));
  }
  const collisions: string[] = [];
  for (const [key, tiers] of tiersByKey) {
    if (tiers.size > 1) {
      collisions.push(`${key} in tiers ${TIER_PRECEDENCE.filter((t) => tiers.has(t)).join(' + ')}`);
    }
  }
  return collisions.sort();
}

/**
 * DEV-CHECK. Throws when one occurrence key reached two tiers. Fatal in tests
 * and under `MENDR_DEV_CHECKS=1` (see {@link devChecksEnabled}); the CLI
 * degrades it to a printed warning in a user's run, because a classifier bug
 * should not eat a report the user can still read.
 */
export function assertSingleTerminalTier(occurrences: readonly TierOccurrence[]): void {
  const collisions = crossTierCollisions(occurrences);
  if (collisions.length === 0) return;
  throw new Error(
    `mendr internal invariant violated: an occurrence must land in exactly one tier, ` +
      `but ${collisions.length} landed in two or more -- ${collisions.join('; ')}`,
  );
}

/** Are internal dev-checks fatal in this process? True under vitest, or opt-in. */
export function devChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDR_DEV_CHECKS === '1' || env.VITEST !== undefined || env.NODE_ENV === 'test';
}

// --- the same id in two tiers ----------------------------------------------

/** How many positions the clarifying note names per tier before `+N more`. */
const MAX_NOTE_POSITIONS = 4;

/**
 * ONE clarifying line per deprecated id that legitimately appears in more than
 * one tier — and nothing at all when that never happens.
 *
 *   note: "gpt-4" appears in more than one tier -- these are different
 *         occurrences (tier B: L166; tier C: L12).
 *
 * This is the sentence the report was missing. `gpt-4` assigned at line 166
 * and `gpt-4` used as a lookup-table key at line 12 are two literals, and the
 * counts are right to count both; without this line the only way to learn that
 * is to open the file. Positions are bare `L<line>` while one file is
 * involved, and `file:line` as soon as more than one is — the short form is
 * only unambiguous while there is nothing to be ambiguous with.
 */
export function multiTierNotes(occurrences: readonly TierOccurrence[]): string[] {
  const byId = new Map<string, TierOccurrence[]>();
  for (const o of occurrences) {
    const list = byId.get(o.modelId);
    if (list) list.push(o);
    else byId.set(o.modelId, [o]);
  }

  const notes: string[] = [];
  for (const modelId of [...byId.keys()].sort()) {
    const list = byId.get(modelId)!;
    const tiers = TIER_PRECEDENCE.filter((t) => list.some((o) => o.tier === t));
    if (tiers.length < 2) continue;
    const oneFile = new Set(list.map((o) => o.file)).size === 1;
    const perTier = tiers.map((tier) => {
      const shown = [...new Set(
        list
          .filter((o) => o.tier === tier)
          .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
          .map((o) => (oneFile ? `L${o.line}` : `${o.file}:${o.line}`)),
      )];
      const head = shown.slice(0, MAX_NOTE_POSITIONS).join(', ');
      const more =
        shown.length > MAX_NOTE_POSITIONS ? `, +${shown.length - MAX_NOTE_POSITIONS} more` : '';
      return `tier ${tier}: ${head}${more}`;
    });
    notes.push(
      `note: "${modelId}" appears in more than one tier -- these are different ` +
        `occurrences (${perTier.join('; ')}).`,
    );
  }
  return notes;
}
