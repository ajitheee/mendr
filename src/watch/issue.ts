import type { LlmRegistry } from '../types.js';
import { modelIdEntries, registryProvenance } from '../usage/llmRegistry.js';
import { daysUntil, hasReadyFix, type ExposedModel, type Exposure } from './exposure.js';
import { EXPOSURE_RELATIVE_PATH } from './exposureFile.js';

// The self-resurfacing side of the Standing Watch: ONE GitHub issue, found by a
// hidden marker and edited in place forever (the Renovate Dependency Dashboard
// mechanic). The title is constant so GitHub never notifies on a rename; the
// countdown lives in the body and is recomputed every run. This module only
// RENDERS the body/badge/summary as strings — it makes no network call and
// holds no state. The CI workflow does the create-or-edit using these strings.

/**
 * The hidden marker that identifies THE watch issue. The workflow searches for
 * it (in the issue body) rather than trusting a title or an issue number, so
 * exactly one resident issue is ever maintained and it is never re-posted.
 */
export const WATCH_MARKER = '<!-- mendr-watch:v1 -->';

/**
 * A second hidden marker present ONLY in the all-clear body. It records that the
 * last state Mendr wrote was "no exposure" — so when the workflow later closes
 * the issue, that close is attributable to Mendr, and a genuine RE-exposure may
 * reopen it. Its ABSENCE on a closed issue means a human closed an exposure
 * issue on purpose, which the workflow must not fight by reopening.
 */
export const WATCH_CLEAR_MARKER = '<!-- mendr-watch:clear -->';

/** Constant issue title — never varies, so a re-render never notifies. */
export const WATCH_ISSUE_TITLE = 'Mendr Watch: deprecated model ids in this repo';

/** The label the workflow puts on the issue, so it can find it by label + marker. */
export const WATCH_LABEL = 'mendr-watch';

/** The install spec the issue/summary tell a reader to run for proposed fixes. */
export const MENDR_RUN_SPEC = 'npx github:ajitheee/mendr fix-llm .';

/** Provider tokens as a person recognizes them, for the coverage statement. */
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google (Gemini)',
  azure: 'Azure',
};

function displayProvider(p: string): string {
  return PROVIDER_DISPLAY[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * What a clean result actually covers — so "nothing found" is never read as
 * "you are safe". A pure-JavaScript repo, or a provider the registry does not
 * track, scans clean here while being genuinely un-analyzed; the coverage names
 * exactly what WAS checked (the languages, the providers, the registry size) so
 * the reader can tell a real all-clear from an unsupported one.
 */
export function coverageLines(registry: LlmRegistry): string[] {
  const provenance = registryProvenance(registry);
  const providers = [...new Set(modelIdEntries(registry).map((e) => e.provider))]
    .sort()
    .map(displayProvider);
  return [
    'Coverage:',
    '  languages: TypeScript, TSX, Python',
    '  unsupported: JavaScript-only repositories (.js/.jsx are not scanned)',
    `  providers: ${providers.join(', ')}`,
    `  registry: ${provenance.activeEntries} records, ${provenance.autoFixEligible} auto-fix eligible`,
  ];
}

/** One-line coverage scope for the markdown issue body. */
export function coverageSentence(registry: LlmRegistry): string {
  const provenance = registryProvenance(registry);
  const providers = [...new Set(modelIdEntries(registry).map((e) => e.provider))]
    .sort()
    .map(displayProvider);
  return (
    `Scope: TypeScript, TSX, Python · providers ${providers.join(', ')} · ` +
    `registry ${provenance.activeEntries} records (${provenance.autoFixEligible} auto-fix eligible). ` +
    `JavaScript-only code is not scanned — a clean result means no *supported* deprecated IDs were found, ` +
    `not a guarantee for unsupported languages or providers.`
  );
}

/** Human countdown for one model — day-granularity, never an exact-time claim. */
export function countdownLabel(model: ExposedModel, now: Date): string {
  const days = daysUntil(model.shutdownDate, now);
  if (days === null) return model.status === 'retired' ? 'retired' : 'unscheduled';
  if (days < 0) return `retired ${-days}d ago`;
  if (days === 0) return 'retires today';
  return `${days}d left`;
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

/**
 * The models the urgency signal is allowed to alarm on: those with at least one
 * LIVE (`model_arg`) occurrence. A deprecated id sitting only in a pricing table
 * or a comparison is real exposure worth listing, but it is not a failing call —
 * so it must never turn the badge red or claim a retirement is "overdue". Every
 * urgency decision (colour, overdue framing) reads this subset; the full list is
 * still what gets counted and tabulated.
 */
export function liveModels(models: readonly ExposedModel[]): ExposedModel[] {
  return models.filter((m) => m.liveOccurrences > 0);
}

/** Is a model at or past its retirement date (or retired with no date)? */
function isOverdue(model: ExposedModel, now: Date): boolean {
  const days = daysUntil(model.shutdownDate, now);
  return (days !== null && days <= 0) || (days === null && model.status === 'retired');
}

/** Escape a value for a markdown table cell (pipes would split the row). */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Render the full watch issue body (markdown), including the hidden marker.
 * `registry` is used only to say whether a ready Tier A fix exists for each live
 * model — never to re-detect. An empty exposure renders an explicit all-clear
 * body (still carrying the marker) so the workflow can update-then-close.
 */
export function renderIssueBody(exposure: Exposure, registry: LlmRegistry, now: Date): string {
  const { models } = exposure;

  if (models.length === 0) {
    // The all-clear body carries the extra clear-marker so a later Mendr close
    // is distinguishable from a human closing an exposure issue. The resurface
    // trigger named here is the one detection can actually fire on: exposure is
    // registry-membership + a literal match, so a date passing never flips a
    // clean repo to exposed — only a NEW/changed registry deprecation that
    // matches an id already in the code does.
    return (
      [
        WATCH_MARKER,
        WATCH_CLEAR_MARKER,
        '',
        '### Mendr Watch',
        '',
        'No **supported** deprecated model ids are currently detected in this repository.',
        '',
        `<sub>${coverageSentence(registry)}</sub>`,
        '',
        'Mendr updates this issue automatically when a new or changed deprecation in',
        "its registry matches a model id your code already uses. Nothing to do right now.",
        '',
        footer(now),
      ].join('\n') + '\n'
    );
  }

  const lines: string[] = [WATCH_MARKER, ''];

  // Only a LIVE call at/past its date raises the alarm; a data-only occurrence
  // of a retired id is listed but never framed as a failing call.
  const liveOverdue = liveModels(models).some((m) => isOverdue(m, now));

  lines.push(
    '### Mendr Watch',
    '',
    liveOverdue
      ? `**${models.length}** deprecated model id${models.length === 1 ? '' : 's'} in your code — ` +
          `at least one live call is already at or past its retirement date.`
      : `**${models.length}** deprecated model id${models.length === 1 ? '' : 's'} in your code, ` +
          `sorted by the nearest retirement deadline.`,
    '',
    '| Model | Provider | Retires | Countdown | In code | Fix |',
    '| --- | --- | --- | --- | --- | --- |',
  );

  for (const model of models) {
    const inCode =
      model.liveOccurrences > 0
        ? `${model.occurrences}× (${model.liveOccurrences} live)`
        : `${model.occurrences}× (data only)`;
    const fix = hasReadyFix(model, registry)
      ? 'auto-fix ready'
      : model.liveOccurrences > 0
        ? 'review'
        : '—';
    lines.push(
      `| \`${cell(model.id)}\` | ${cell(model.provider)} | ${model.shutdownDate ?? '—'} | ` +
        `${cell(countdownLabel(model, now))} | ${inCode} | ${fix} |`,
    );
  }

  // `fix-llm` only rewrites LIVE model-argument sites, so it produces a diff
  // only when there is live exposure. Promising a diff for a data-only exposure
  // (a pricing-table key, a comparison) would be an overclaim — the run would
  // come back with nothing to change.
  const hasLive = liveModels(models).length > 0;
  lines.push(
    '',
    hasLive
      ? `See a proposed, verified diff with \`${MENDR_RUN_SPEC}\`. Nothing is changed without your review — ` +
          'Mendr only ever opens a diff or a pull request.'
      : 'Every occurrence above is a data reference (a config value, a comparison, a catalog key), ' +
          `not a live model call, so there is nothing for \`${MENDR_RUN_SPEC}\` to rewrite — this is a heads-up, not a fix.`,
    '',
    footer(now),
  );
  return `${lines.join('\n')}\n`;
}

/** The shared footer: what this issue is, and the honest limits of the timing. */
function footer(now: Date): string {
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
  return [
    '<sub>',
    `This is a single, self-updating issue maintained by [Mendr](https://github.com/ajitheee/mendr) — ` +
      `it is edited in place, never re-posted. Countdowns are day-granularity (last updated ${stamp} UTC) ` +
      `and derive from provider retirement dates in Mendr's registry; they are not exact-time guarantees. ` +
      `Exposure detail is committed at \`${EXPOSURE_RELATIVE_PATH}\`.`,
    '</sub>',
  ].join('\n');
}

/**
 * An OPTIONAL, static shields.io badge snapshot for the README — a copy-paste
 * the developer opts into. It is deliberately a snapshot, not live: the paying
 * ICP is private repos, which shields cannot read, so a "live" badge would be a
 * promise we can't keep. Re-running `mendr watch` regenerates it.
 *
 * The COUNT is every exposed model; the URGENCY (colour + suffix) is driven by
 * LIVE models only, so a data-only reference to a long-retired id never paints
 * the badge red.
 */
export function renderBadge(exposure: Exposure, now: Date): string {
  const { models } = exposure;
  if (models.length === 0) {
    return badgeUrl('no deprecations', 'brightgreen');
  }
  const count = `${models.length} model${models.length === 1 ? '' : 's'}`;
  const live = liveModels(models);
  const liveNearest = nearestDeadlineDays(live, now);

  if (live.length === 0) {
    // Real exposure, but only in data positions — informational, never alarming.
    return badgeUrl(`${count} · data only`, 'blue');
  }
  if (liveNearest !== null && liveNearest <= 0) {
    return badgeUrl(`${count} · retirement overdue`, 'red');
  }
  if (liveNearest !== null) {
    return badgeUrl(`${count} · next ${liveNearest}d`, liveNearest <= 30 ? 'orange' : 'blue');
  }
  return badgeUrl(`${count} watched`, 'blue');
}

/** Build one shields.io static-badge markdown image (escaping `-`/`_`/spaces). */
function badgeUrl(right: string, color: string): string {
  const seg = (s: string): string => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
  return `![mendr watch](https://img.shields.io/badge/${seg('mendr')}-${seg(right)}-${color})`;
}

/** A plain-terminal summary of the exposure for `mendr watch` (human output). */
export function renderTextSummary(exposure: Exposure, registry: LlmRegistry, now: Date): string {
  const { models } = exposure;
  if (models.length === 0) {
    return [
      'Mendr Watch: no supported deprecated model ids detected in this repo.',
      '',
      ...coverageLines(registry),
    ].join('\n');
  }
  const lines: string[] = [
    `Mendr Watch: ${models.length} deprecated model id${models.length === 1 ? '' : 's'} in this repo ` +
      `(nearest deadline first)`,
    '',
  ];
  for (const model of models) {
    const fix = hasReadyFix(model, registry) ? 'auto-fix ready' : model.liveOccurrences > 0 ? 'review' : '—';
    const where =
      model.liveOccurrences > 0
        ? `${model.occurrences}× (${model.liveOccurrences} live)`
        : `${model.occurrences}× (data only)`;
    lines.push(
      `  ${countdownLabel(model, now).padEnd(16)} ${model.id}  ->  ${model.replacement}` +
        `   [${where}, ${fix}]`,
    );
  }
  return lines.join('\n');
}
