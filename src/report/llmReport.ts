import { basename } from 'node:path';
import type { LlmModelIdDeprecation } from '../types.js';
import type { DataPurpose } from '../usage/scanLiterals.js';
import {
  effectiveVerificationState,
  REVIEW_ONLY_STATES,
  withheldSwitches,
  type RegistryProvenance,
} from '../usage/llmRegistry.js';
import { displayEntryId } from '../registry/entryId.js';
import { replacementVerdictText, tierRow, usageVerdictText } from './tiers.js';

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

// EVERY CHECK REPORTS ITS OWN OUTCOME. The summary used to render free-text
// values a caller had assembled ("pass (no new errors; 3 pre-existing
// ignored)"), which made it possible — and, for the tests row, actual — for one
// word to stand in for several different checks: "verified" over a run where
// the type-check passed, the tests never ran, and no eval existed. A reader
// cannot un-collapse that. So the summary now takes ROWS, each carrying its own
// state word from a closed vocabulary, and no row can borrow another's.

/**
 * The outcome vocabulary a gate row may use. Deliberately closed, and
 * deliberately NOT shared between kinds of check: an evidence row is
 * `verified`/`confirmed` (a claim about a record), a gate row is
 * `passed`/`failed`/`inconclusive` (a claim about a run), and nothing renders
 * as a bare "verified" over a gate that did not run.
 *
 *   inconclusive     the check could not run. NEVER `passed`; see gates/policy.
 *   not configured   there is nothing to run (no test script, no eval command).
 *   n/a              the check does not exist for this language.
 */
export type GateRowState =
  | 'verified'
  | 'not verified'
  | 'confirmed'
  | 'not confirmed'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'not configured'
  | 'skipped'
  | 'n/a';

/** One line of the gate summary: one check, one outcome, one optional why. */
export interface GateRow {
  /** Left column, e.g. `type-check`. */
  label: string;
  /** The outcome word — never shared with, or inferred from, another row. */
  state: GateRowState;
  /** The parenthesised qualifier: counts, the reason it was inconclusive, a stamp date. */
  detail?: string;
  /**
   * True when the run's gate policy REQUIRED this check to pass. Rendered as a
   * `[required]` tag, so a reader can see why an `inconclusive` row blocked
   * the fix here when the same row passes through elsewhere.
   */
  required?: boolean;
}

/** Column at which every gate VALUE starts, so the two groups align as one table. */
const GATE_LABEL_WIDTH = 24;

/** Render one row: `  label:      state (detail) [required]`. */
export function formatGateRow(row: GateRow): string {
  const detail = row.detail ? ` (${row.detail})` : '';
  const required = row.required ? '  [required]' : '';
  return `  ${`${row.label}:`.padEnd(GATE_LABEL_WIDTH)}${row.state}${detail}${required}`;
}

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
/**
 * The eval gate's own itemized row — the sixth check, reported like the other
 * five and never folded into them. `not-tested` splits into the two states that
 * are NOT the same fact: nothing was configured, or something was configured
 * and produced no verdict. The second one is `inconclusive`, which is the one
 * word this row must never trade for `not configured` (it hides a gate that
 * tried and failed to run) or for anything resembling a pass.
 */
export function behavioralGateRow(
  view: BehavioralVerificationView,
  required = false,
): GateRow {
  const label = 'behavioral evaluation';
  const detail = `your eval command: ${view.command ?? 'unknown'}, exit ${view.exitCode ?? '?'}`;
  if (view.status === 'pass') return { label, state: 'passed', detail, required };
  if (view.status === 'fail') return { label, state: 'failed', detail, required };
  return view.reason
    ? { label, state: 'inconclusive', detail: view.reason, required }
    : { label, state: 'not configured', required };
}

export function behavioralVerificationLines(
  view: BehavioralVerificationView,
  required = false,
): string[] {
  const row = formatGateRow(behavioralGateRow(view, required));
  if (view.status === 'not-tested') {
    if (!view.reason) {
      return [BEHAVIORAL_VERIFICATION_LINES[0], row, ...BEHAVIORAL_VERIFICATION_LINES.slice(1)];
    }
    // A CONFIGURED eval that never produced a verdict. Same headline — nothing
    // was verified — but the tail says which case it was and that the fix was
    // blocked because of it, instead of advising a setup the user has already
    // done. No "raise evalTimeoutMs" hint here: the gate's own reason text
    // carries that advice in the one case (a timeout) where it applies.
    return [
      BEHAVIORAL_VERIFICATION_LINES[0],
      row,
      ...BEHAVIORAL_VERIFICATION_LINES.slice(1, 3),
      '  your eval command was configured but produced no verdict, so nothing',
      '  was applied: mendr will not apply a fix it could not behaviorally verify.',
    ];
  }
  if (view.status === 'pass') {
    return [
      'Behavioral verification (your own evaluation):',
      row,
      '  that is the whole claim: YOUR eval passed against the patched code.',
      '  anything it does not measure -- quality, latency, cost -- is untested.',
    ];
  }
  return [
    'Behavioral verification (your own evaluation):',
    row,
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
 * The same boundary under `--skip-gates`, where the sentence above is simply
 * false: no type-check ran, no test ran, and there is no gate summary above to
 * point at — the flag suppresses it. Saying "mendr verified the CODE only" over
 * a run that verified nothing is the overclaim this note exists to prevent,
 * made by the note itself.
 */
export const SKIPPED_GATES_NOTE =
  'note: --skip-gates was passed, so mendr verified NOTHING on this run: no type-check, ' +
  'no tests, no eval. The tier above is asserted from the registry alone. Re-run without ' +
  '--skip-gates before trusting the diff, and check the replacement model\'s output quality, ' +
  'latency, cost and response shape yourself either way.';

/**
 * The closing note, matched to what was actually established. With a passing
 * eval the note may name it — and must still cap the claim at "your eval
 * command passed", since the eval measures whatever its author chose to
 * measure and mendr has no idea what that is.
 *
 * `gatesSkipped` wins over everything: a run that checked nothing has no
 * behavioral verdict to qualify.
 */
export function behavioralVerificationNote(
  view: BehavioralVerificationView,
  gatesSkipped = false,
): string {
  if (gatesSkipped) return SKIPPED_GATES_NOTE;
  if (view.status !== 'pass') return BEHAVIORAL_VERIFICATION_NOTE;
  return (
    'note: mendr verified the CODE (see the gate summary above) and ran YOUR eval ' +
    `command (${view.command}), which passed. That is the only behavioral claim it ` +
    "makes: whatever your eval does not measure -- the replacement model's output " +
    'quality, latency, cost and response shape -- is still untested. Check those before you ship.'
  );
}

/**
 * Render the two-group gate summary from ITEMIZED ROWS. Every check the caller
 * ran is one row with its own outcome; a check that does not exist for this
 * language is `n/a` and a check that could not run is `inconclusive` — neither
 * is ever omitted or absorbed into a neighbour. The second group is the
 * behavioral one, and it defaults to the disclaimer: a caller that forgets to
 * pass a result gets the honest "not checked", never a silent pass.
 */
export function formatGateSummary(
  rows: readonly GateRow[],
  behavioral: BehavioralVerificationView = { status: 'not-tested' },
  evalRequired = false,
): string[] {
  return [
    'Code verification (what mendr checked):',
    ...rows.map(formatGateRow),
    ...behavioralVerificationLines(behavioral, evalRequired),
  ];
}

/**
 * The two REGISTRY rows behind a patch, computed from the records the patch
 * actually used rather than asserted:
 *
 *   replacement verdict:    verified (stamped 2026-08-14)
 *   official source:        confirmed (a provider docs url and a lifecycle
 *                           claim are recorded; the page was not fetched)
 *
 * THE FIRST ROW IS SCOPED TO THE REPLACEMENT MAPPING, and it is the AGGREGATE
 * over every record this patch rests on (the oldest stamp, the count of records
 * not backed). The per-record statement of the same dimension is the
 * `replacement verdict:` row in {@link formatRegistryEntryLines} below. Both
 * use report/tiers' vocabulary — one word per dimension across both tiers, so
 * a reader never has to work out whether `registry verdict` and `replacement
 * verdict` were the same thing. They were.
 *
 * THE FIRST ROW IS NOT CALLED "evidence", and that is the point. It said
 * `replacement evidence:` until an audit ran both commands against the same
 * record: this row printed `verified` while `mendr evidence <id>` printed
 * "no evidence captured for this entry -- it was hand-seeded" — which is true
 * of 106 of 106 shipped records, because `entry.evidence` (source urls,
 * content hashes, quoted excerpts) is empty on every one of them. report/tiers
 * had already renamed the same concept for Tier B for exactly this reason; the
 * Tier A path — the one that writes to your files — kept the older word.
 * `replacement verdict` is what the value actually is, and it is now the same
 * words the Tier B rows and `mendr evidence` use.
 *
 * They are separate rows because they are separate claims, and the P0 work made
 * them separately checkable: `replacementConfirmed` says the replacement id is
 * live and uncontradicted in the public catalogs, `officialSourceConfirmed`
 * says the PROVIDER'S OWN docs back the deprecation. An entry can have the
 * first without the second, and one word covering both would hide exactly that.
 *
 * WHAT `official source: confirmed` MEANS, said in the row itself: the record
 * names a docs url AND carries a lifecycle read off it (see
 * registry/verify.ts#officialSourceConfirmed). Nothing fetches the page, checks
 * the domain, or re-reads what it says. It is true on all 106 shipped records,
 * so on today's data this row cannot say "no" — the detail exists so the word
 * "confirmed" does not have to carry a check it never performed.
 *
 * A `fix-llm` run contacts no catalog: these read the stamps already sitting in
 * the registry JSON, which are as old as their `checkedAt` and can disagree
 * with a fresh `mendr verify-registry`. So the detail names the stamp and its
 * date rather than implying a live check.
 */
export function registryVerdictRows(
  entries: readonly LlmModelIdDeprecation[],
): GateRow[] {
  if (entries.length === 0) {
    // A param-only patch (a `max_tokens` rename, a `temperature` removal) rests
    // on no model-id record at all. `every()` over an empty set is vacuously
    // true, so the affirmative rows below would print "verified" over nothing.
    return [
      {
        label: 'replacement verdict',
        state: 'n/a',
        detail: 'no model-id swap in this patch (parameter transforms only)',
      },
      { label: 'official source', state: 'n/a', detail: 'no model-id record to attribute' },
    ];
  }
  const verified = entries.every(
    (e) => e.verification?.status === 'verified' && e.verification.replacementConfirmed,
  );
  const official = entries.every((e) => e.verification?.officialSourceConfirmed);
  const dates = entries.map((e) => e.verification?.checkedAt).filter((d): d is string => !!d);
  const undated = entries.length - dates.length;
  // The OLDEST stamp is the honest one for a set: a fresh date standing over a
  // record checked months ago is the overclaim the registry footer already
  // refuses to make.
  const oldest = dates.length > 0 ? dates.slice().sort()[0] : undefined;
  const stamp = oldest
    ? `stamped ${oldest}${undated > 0 ? `; ${undated} record${undated === 1 ? '' : 's'} undated` : ''}`
    : 'no recheck date recorded';
  const notOfficial = entries.filter((e) => !e.verification?.officialSourceConfirmed).length;
  return [
    {
      label: 'replacement verdict',
      state: verified ? 'verified' : 'not verified',
      detail: stamp,
    },
    {
      label: 'official source',
      state: official ? 'confirmed' : 'not confirmed',
      ...(official
        ? {
            // WHAT WAS ACTUALLY CHECKED, in the row: a url is recorded and a
            // lifecycle is recorded. Nothing fetched the page. Without this
            // clause "confirmed" reads as "somebody read the provider's docs
            // during this run", which no part of `fix-llm` does.
            detail:
              'a provider docs url and a lifecycle claim are recorded on the ' +
              'record; the page was not fetched',
          }
        : {
            detail:
              `${notOfficial} of ${entries.length} record${entries.length === 1 ? '' : 's'} ` +
              `not backed by provider documentation`,
          }),
    },
  ];
}

// --- naming the records behind a patch -------------------------------------

/** Label column width, chosen to match the Tier B block so the two align. */
const ENTRY_LABEL_WIDTH = 23;

/**
 * The per-record block for the records a Tier A patch rests on:
 *
 *   replacement verdict:   verified (registry stamp 2026-08-21, not re-checked
 *                          this run)
 *   usage verdict:         confirmed live model argument
 *   classification:        tier A -- auto-fixable, will apply with --write
 *   registry entry:        openai.gpt-4.retirement-2026-10-23
 *   evidence:              mendr evidence openai.gpt-4.retirement-2026-10-23
 *
 * One block per distinct record, in the order the swaps were listed. Tier A is
 * rendered as a DIFF rather than as per-finding blocks, so these rows are the
 * only place the reader can learn which registry records authorised the edit
 * they are being shown — and the only way to go read one without first guessing
 * its id.
 *
 * THE SAME THREE ROWS TIER B PRINTS, from the same functions, so the two tiers
 * read as one report rather than two dialects. On a Tier A record all three
 * are affirmative — the mapping's stamp is `verified`, the position WAS
 * confirmed to be a live model argument, and the outcome is a patch — and that
 * is precisely the contrast that makes a Tier B block legible: same rows, and
 * a reader can see which of them is the one that did not hold.
 *
 * `classification` is passed IN rather than assumed: the same records are
 * printed under a gate-failed candidate, where "will apply with --write" would
 * be false (see TIER_A_DOWNGRADED_CLASSIFICATION). Callers with no disposition
 * to state get the two id rows alone.
 *
 * The id rows are never wrapped: an id and the command that takes it are things
 * a reader selects and pastes.
 */
export function formatRegistryEntryLines(
  entries: readonly LlmModelIdDeprecation[],
  classification?: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const row = (label: string, value: string): string =>
    `  ${`${label}:`.padEnd(ENTRY_LABEL_WIDTH)}${value}`;
  for (const entry of entries) {
    const id = displayEntryId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    if (classification) {
      const state = effectiveVerificationState(entry);
      lines.push(
        ...tierRow(
          'replacement verdict',
          replacementVerdictText({
            registryVerdict: state,
            verdictCheckedAt: entry.verification?.checkedAt,
            quarantineReason: entry.verification?.quarantineReason ?? undefined,
            withheldSwitches: state === 'withheld' ? withheldSwitches(entry) : undefined,
          }),
        ),
        // Tier A is DEFINED by the position: a model-id swap only reaches this
        // path from a live model argument (TS) or a recognized sink (python).
        ...tierRow('usage verdict', usageVerdictText('A')),
        ...tierRow('classification', classification),
      );
    }
    lines.push(row('registry entry', id));
    lines.push(row('evidence', `mendr evidence ${id}`));
  }
  return lines;
}

// --- the registry footer ---------------------------------------------------
//
// THE FOOTER IS A CLAIM, so it gets the same treatment as the gate summary:
// lead with the number a reader will act on, never let one date stand in for a
// verdict it did not produce, and never print a "verified" count that is larger
// than the set mendr would actually touch. See RegistryProvenance in
// usage/llmRegistry.ts for both footers this replaced and why each was wrong.

/**
 * Render the registry footer from computed provenance:
 *
 *   registry: 106 records
 *   auto-fix eligible: 86
 *   review-only: 20 (quarantined 12, unverified 3, unverifiable 5)
 *   catalog recheck: 2026-08-21
 *
 * `auto-fix eligible` is counted through isVerified() — the same predicate the
 * codemod calls — so the headline number is what mendr would actually act on,
 * not what the stamps claim. Everything else is `review-only`, itemised, and
 * the two always sum to the record count.
 *
 * The recheck line adapts to what the stamps support: one date when every
 * record shares it, `<newest> (oldest entry checked <oldest>)` when they differ
 * — implying one date covers all of them is an overclaim — and an explicit
 * "never recorded" when nothing is stamped. Records with no date at all are
 * named on the same line, because a fresh-looking date over undated records is
 * the same lie in a different shape.
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
  const reviewOnly = p.activeEntries - p.autoFixEligible;
  const breakdown = REVIEW_ONLY_STATES.filter((s) => p.reviewOnlyCounts[s] > 0)
    .map((s) => `${s} ${p.reviewOnlyCounts[s]}`)
    .join(', ');
  return [
    `registry: ${p.activeEntries} record${p.activeEntries === 1 ? '' : 's'}`,
    `auto-fix eligible: ${p.autoFixEligible}`,
    `review-only: ${reviewOnly}${breakdown ? ` (${breakdown})` : ''}`,
    `catalog recheck: ${recheck()}`,
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
