import { basename } from 'node:path';
import type { LlmModelIdDeprecation } from '../types.js';
import type { DataPurpose } from '../usage/scanLiterals.js';
import {
  ENTRY_VERIFICATION_STATES,
  type RegistryProvenance,
} from '../usage/llmRegistry.js';

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
  /**
   * id -> the LINE of every occurrence, ordered by first sighting in the file
   * (one entry per hit, so `.length` is still the occurrence count).
   *
   * WHY LINES AND NOT A BARE COUNT: the collapsed line used to read
   * `simulator.py -- 3 hits across 2 model ids (gpt-4, gemini-1.5-pro x2)`.
   * When the SAME id also appears in Tier B — `gpt-4` assigned at line 166,
   * `gpt-4` as a lookup-table key at line 12 — a reader had no way to tell the
   * two apart, and two expert reviewers read that report as mendr counting one
   * occurrence twice. It was not; the report simply refused to say WHERE. So
   * the position travels with the id all the way to the collapsed view.
   */
  idLines: Map<string, number[]>;
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
      group = { file: f.file, hits: 0, idLines: new Map(), comparisons: 0, catalogLike: false };
      byFile.set(f.file, group);
    }
    group.hits++;
    const lines = group.idLines.get(f.value);
    if (lines) lines.push(f.line);
    else group.idLines.set(f.value, [f.line]);
    if (f.purpose === 'comparison') group.comparisons++;
  }
  for (const group of byFile.values()) {
    group.catalogLike = isCatalogLike(group.file, group.idLines.size);
  }
  return [...byFile.values()];
}

/** How many id tokens the one-line-per-file view spells out before "...". */
const MAX_IDS_PER_LINE = 4;

/**
 * How many LINE numbers one id spells out before `+N more`. Four keeps a
 * catalog file — the whole reason this view collapses — down to one line, while
 * still naming enough positions for a reader to go look.
 */
const MAX_LINES_PER_ID = 4;

/**
 * One id's share of the collapsed line: the id, then where it actually sits.
 *
 *   `gpt-4 (L12)` / `gemini-1.5-pro (L30, L127)` / `gpt-4o (L3, L8, L9, L11, +6 more)`
 *
 * Repeats on ONE line collapse to a single `L`, so `x2` is added back when the
 * hit count exceeds the number of distinct lines — otherwise two hits on line 4
 * would render as `gpt-4 (L4)` and silently contradict the file's hit total.
 */
function formatIdLines(id: string, lines: readonly number[]): string {
  const distinct: number[] = [];
  for (const line of lines) if (!distinct.includes(line)) distinct.push(line);
  const shown = distinct.slice(0, MAX_LINES_PER_ID).map((line) => `L${line}`);
  if (distinct.length > MAX_LINES_PER_ID) {
    shown.push(`+${distinct.length - MAX_LINES_PER_ID} more`);
  }
  const repeats = lines.length > distinct.length ? ` x${lines.length}` : '';
  return `${id}${repeats} (${shown.join(', ')})`;
}

/**
 * Render one file's collapsed line, e.g.:
 *   `agent_app/simulator.py -- 3 hits: gpt-4 (L12), gemini-1.5-pro (L30, L127)`
 *   `lib/chat-setting-limits.ts -- 15 hits: gpt-4 x2 (L7), gemini-pro (L9),
 *    ... +8 more ids [looks like a model catalog]`
 *
 * Every id carries its LINE NUMBERS. Collapsing to `3 hits across 2 model ids
 * (gpt-4, ...)` saved a few characters and cost the reader the one fact that
 * distinguishes this `gpt-4` from the `gpt-4` listed in Tier B two sections up.
 * Comparisons are the one purpose worth surfacing even collapsed — they can
 * gate runtime logic, so the line says so when any are present.
 */
export function formatDataFileGroupLine(group: DataFileGroup): string {
  const n = group.idLines.size;
  const shown = [...group.idLines.entries()]
    .slice(0, MAX_IDS_PER_LINE)
    .map(([id, lines]) => formatIdLines(id, lines));
  // The distinct-id total survives truncation: a reader must be able to see
  // that the four ids named are not all of them.
  const moreIds = n > MAX_IDS_PER_LINE ? `, +${n - MAX_IDS_PER_LINE} more ids` : '';
  const catalog = group.catalogLike ? ' [looks like a model catalog]' : '';
  const compare =
    group.comparisons > 0
      ? ` -- ${group.comparisons} runtime comparison${group.comparisons === 1 ? '' : 's'} (may gate logic, review)`
      : '';
  return (
    `${group.file} -- ${group.hits} hit${group.hits === 1 ? '' : 's'}: ` +
    `${shown.join(', ')}${moreIds}${catalog}${compare}`
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
 * Human label for one model-id swap, carrying WHY. The lifecycle fact attaches
 * to the SOURCE id — it is the DEPRECATED model that is retired / shutting
 * down — so `"gpt-4" (shuts down 2026-10-23) -> "gpt-5.6-sol"` reads
 * correctly, where the old trailing `[shuts down …]` looked like a claim about
 * the replacement.
 */
export function swapLabel(d: LlmModelIdDeprecation): string {
  const when =
    d.status === 'retired'
      ? ' (retired)'
      : d.status === 'deprecated' && d.shutdownDate
        ? ` (shuts down ${d.shutdownDate})`
        : '';
  return `"${d.deprecated}"${when} -> "${d.replacement}"`;
}

/**
 * One line for an annotated `mendr: model-catalog` file: expected registry
 * content, named as such, with no action and no debt claim.
 */
export function formatCatalogLine(catalog: { file: string; ids: string[] }): string {
  const n = catalog.ids.length;
  return (
    `${catalog.file} -- known migration catalog: ${n} deprecated id${n === 1 ? '' : 's'} ` +
    `(expected registry content, no action)`
  );
}

// --- gate summary ----------------------------------------------------------
//
// THE HONESTY SPLIT. mendr's gates prove things about CODE: that the swapped id
// is a real replacement in a live catalog, that the literal sat in a genuine
// call position, that the patched file still type-checks (TS) or still parses
// (Python), and that the repo's own tests still pass. Not one of those says
// anything about whether the NEW MODEL BEHAVES LIKE THE OLD ONE — its output
// quality, its latency, its cost per token, the shape of its response. A single
// flat "Gate summary" list invited exactly that misreading, so the summary is
// split into two NAMED groups and the second one is a disclaimer, not a result.

/** The measurable per-gate lines for one language's summary. */
export interface GateSummaryFacts {
  /** How the literal was proven to be a live model argument. */
  usageClassification: string;
  /** Baseline-relative type-check verdict (TypeScript only). */
  typeCheck?: string;
  /** Baseline-relative syntax re-parse verdict (Python only). */
  syntax?: string;
  /** Static type-gate note (Python only — there is no compiler to consult). */
  staticTypeGate?: string;
  /** Test-gate label, carrying real counts wherever the runner output allowed. */
  tests: string;
}

/** Column at which every gate VALUE starts, so the two groups align as one table. */
const GATE_LABEL_WIDTH = 22;

/**
 * What the eval gate actually established about behavior, reduced to the three
 * states a report may claim. `not-tested` covers "no eval configured" AND "the
 * configured eval could not be run" — from a reader's side those are the same
 * fact, and only one of them may ever be dressed up as a result.
 */
export interface BehavioralVerificationView {
  status: 'not-tested' | 'pass' | 'fail';
  /** The eval command that ran (absent when nothing ran). */
  command?: string;
  exitCode?: number;
  /**
   * Why a CONFIGURED eval produced no verdict (timeout, spawn failure). Present
   * only on `not-tested`, and it changes what the disclaimer may say: telling a
   * user to "set evalCommand" when they already did — and when that is exactly
   * why the fix was blocked — sends them looking for the wrong thing.
   */
  reason?: string;
}

/**
 * The one-line instruction that turns the disclaimer into something actionable.
 * Its presence is the difference between "mendr cannot check behavior" (false)
 * and "mendr will check behavior if you tell it how" (true).
 */
export const BEHAVIORAL_VERIFICATION_HOWTO =
  '  to check it: set "evalCommand" in mendr.config.json (or pass --eval-command) ' +
  'to have mendr run your own evaluation against the patched code.';

/**
 * The behavioral disclaimer, verbatim. Kept as an exported constant so the CLI,
 * the report and any future surface state the boundary in exactly one wording —
 * a disclaimer that drifts between surfaces is a disclaimer nobody trusts.
 */
export const BEHAVIORAL_VERIFICATION_LINES: readonly string[] = [
  'Behavioral verification (NOT checked):',
  "  the replacement model's output quality, latency, cost and response",
  '  shape are not tested. verify those yourself before shipping.',
  BEHAVIORAL_VERIFICATION_HOWTO,
];

/**
 * The behavioral group for a report, in whichever of the three shapes this run
 * earned. The passing shape is deliberately cramped: it names the command and
 * the exit code and then says what that does NOT cover, because "behavioral
 * verification: pass" is exactly the phrase a reader would otherwise inflate
 * into "the new model is equivalent".
 */
export function behavioralVerificationLines(view: BehavioralVerificationView): string[] {
  if (view.status === 'not-tested') {
    if (!view.reason) return [...BEHAVIORAL_VERIFICATION_LINES];
    // A CONFIGURED eval that never produced a verdict. Same headline — nothing
    // was verified — but the last two lines say which case it was and that the
    // fix was blocked because of it, instead of advising a setup the user has
    // already done.
    return [
      ...BEHAVIORAL_VERIFICATION_LINES.slice(0, 3),
      `  your eval command was configured but did not complete: ${view.reason}`,
      '  mendr will not apply a fix it could not behaviorally verify, so nothing',
      '  was applied. fix the eval (or raise "evalTimeoutMs") and re-run.',
    ];
  }
  const detail = `your eval command: ${view.command ?? 'unknown'}, exit ${view.exitCode ?? '?'}`;
  if (view.status === 'pass') {
    return [
      'Behavioral verification (your own evaluation):',
      `  behavioral verification: pass (${detail})`,
      '  that is the whole claim: YOUR eval passed against the patched code.',
      '  anything it does not measure -- quality, latency, cost -- is untested.',
    ];
  }
  return [
    'Behavioral verification (your own evaluation):',
    `  behavioral verification: fail (${detail})`,
    // NOT "your evaluation regressed": mendr reads an EXIT CODE and knows
    // nothing about the cause. A command that does not exist, or that died on
    // its own config, exits non-zero and lands here too -- and telling that
    // user their model regressed sends them hunting a bug that isn't there.
    '  your eval command exited non-zero against the patched code, so the fix',
    '  is NOT applied -- mendr blocks it exactly like a failing test gate.',
    '  mendr reads the exit code, not the cause: a command that could not run',
    '  at all lands here too, so check the command before hunting a regression.',
  ];
}

/**
 * One short restatement of the boundary for the end of a Tier A report. It
 * points AT the gate summary rather than re-listing what passed: the gates that
 * actually ran vary by language and by repo (a repo with no test runner gets
 * "not run"), so a note that spelled out "your tests still pass" would itself
 * overclaim in exactly the cases this note exists to prevent.
 */
export const BEHAVIORAL_VERIFICATION_NOTE =
  'note: mendr verified the CODE only -- see the gate summary above for what was ' +
  "actually checked. It did NOT verify BEHAVIOR: the replacement model's output " +
  'quality, latency, cost and response shape are untested. Check those before you ship.';

/**
 * The closing note, matched to what was actually established. With a passing
 * eval the note may name it — and must still cap the claim at "your eval
 * command passed", since the eval measures whatever its author chose to
 * measure and mendr has no idea what that is.
 */
export function behavioralVerificationNote(view: BehavioralVerificationView): string {
  if (view.status !== 'pass') return BEHAVIORAL_VERIFICATION_NOTE;
  return (
    'note: mendr verified the CODE (see the gate summary above) and ran YOUR eval ' +
    `command (${view.command}), which passed. That is the only behavioral claim it ` +
    "makes: whatever your eval does not measure -- the replacement model's output " +
    'quality, latency, cost and response shape -- is still untested. Check those before you ship.'
  );
}

/**
 * Render the two-group gate summary. Only the gates that actually ran for this
 * language appear — an absent field is a gate that does not exist here (Python
 * has no type-check), never a silently-passed one. The second group is the
 * behavioral one, and it defaults to the disclaimer: a caller that forgets to
 * pass a result gets the honest "not checked", never a silent pass.
 */
export function formatGateSummary(
  facts: GateSummaryFacts,
  behavioral: BehavioralVerificationView = { status: 'not-tested' },
): string[] {
  const row = (label: string, value: string): string =>
    `  ${`${label}:`.padEnd(GATE_LABEL_WIDTH)}${value}`;
  const rows = [
    // WHAT THIS ROW ACTUALLY RESTS ON. A `fix-llm` run contacts no catalog:
    // the Tier A filter is `isVerified(entry)`, which reads the `verified`
    // stamp already sitting in the registry JSON. This row used to read
    // "verified against live catalogs", which named a network check that never
    // happens in this process — and the stamp it really reads can be days old
    // and can disagree with what `mendr verify-registry` says today. So the row
    // names the stamp, and points at the command that does hit the catalogs.
    // (Unconditionally true wherever this prints: every Tier A candidate is
    // `isVerified`-filtered by construction, so the stamp is always present.)
    row('replacement mapping', 'registry entry stamped verified (not re-checked live this run)'),
    row('usage classification', facts.usageClassification),
    ...(facts.typeCheck ? [row('type-check', facts.typeCheck)] : []),
    ...(facts.syntax ? [row('syntax', facts.syntax)] : []),
    ...(facts.staticTypeGate ? [row('static type gate', facts.staticTypeGate)] : []),
    row('tests', facts.tests),
  ];
  return [
    'Code verification (what mendr checked):',
    ...rows,
    ...behavioralVerificationLines(behavioral),
  ];
}

// --- the registry footer ---------------------------------------------------
//
// THE FOOTER IS A CLAIM, so it gets the same treatment as the gate summary:
// say the two things that happened, separately, and never let one date stand
// in for a verdict it did not produce. See RegistryProvenance in
// usage/llmRegistry.ts for why `verified <date>` was wrong.

/**
 * Render the registry footer from computed provenance:
 *
 *   registry: 106 active entries
 *   catalog recheck: 2026-08-18
 *   entry verification: 94 verified, 12 unverified (per entry, see `mendr evidence <id>`)
 *
 * The recheck line adapts to what the stamps support: one date when every
 * entry shares it, `<newest> (oldest entry checked <oldest>)` when they differ
 * — implying one date covers all of them is exactly the overclaim this
 * replaced — and an explicit "never recorded" when nothing is stamped. Entries
 * with no date at all are named on the same line, because a fresh-looking date
 * over undated entries is the same lie in a different shape.
 */
export function formatRegistryProvenanceLines(p: RegistryProvenance): string[] {
  const recheck = (): string => {
    if (!p.newestCheckedAt || !p.oldestCheckedAt) return 'never recorded';
    const dates =
      p.oldestCheckedAt === p.newestCheckedAt
        ? p.newestCheckedAt
        : `${p.newestCheckedAt} (oldest entry checked ${p.oldestCheckedAt})`;
    return p.undatedEntries > 0
      ? `${dates}; ${p.undatedEntries} entr${p.undatedEntries === 1 ? 'y carries' : 'ies carry'} no recheck date`
      : dates;
  };
  const breakdown = ENTRY_VERIFICATION_STATES.filter((s) => p.statusCounts[s] > 0)
    .map((s) => `${p.statusCounts[s]} ${s}`)
    .join(', ');
  const held = p.selfContradictingEntries;
  return [
    `registry: ${p.activeEntries} active entr${p.activeEntries === 1 ? 'y' : 'ies'}`,
    `catalog recheck: ${recheck()}`,
    `entry verification: ${breakdown || 'no entries'} (per entry, see \`mendr evidence <id>\`)`,
    // The counts above report the STAMPS. This line reports what the engine
    // does with them, and the two differ for exactly the entries whose own
    // reasons argue against their stamp — a reader who takes "N verified" as
    // "N auto-appliable" would otherwise be off by this number.
    ...(held > 0
      ? [
          held === 1
            ? 'held at review: 1 of those verified entries contradicts its own stamp in ' +
              '`verification.reasons` and is never auto-applied'
            : `held at review: ${held} of those verified entries contradict their own stamp ` +
              'in `verification.reasons` and are never auto-applied',
        ]
      : []),
  ];
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
