import type { LlmRegistry, TierBReason } from '../types.js';
import { modelIdEntries, registryProvenance } from '../usage/llmRegistry.js';
import { TIER_B_SHORT } from '../report/classifyOccurrence.js';
import { TIER_B_REASON_ORDER } from '../report/tiers.js';
import {
  daysUntil,
  hasReadyFix,
  totalOccurrences,
  type ExposedModel,
  type Exposure,
  type ExposureOccurrence,
} from './exposure.js';
import { EXPOSURE_RELATIVE_PATH } from './exposureFile.js';

// The self-resurfacing side of the Standing Watch: ONE GitHub issue, found by a
// hidden marker and edited in place forever (the Renovate Dependency Dashboard
// mechanic). This module only RENDERS strings; the workflow does the upsert.
//
// The exposure is grouped RISK FIRST — every model whose highest occurrence is a
// review item (Tier A/B) before every model that is purely informational data
// (Tier C) — and each model lists its per-tier occurrences with exact locations,
// so the watch says exactly what fix-llm would say about the same repo.

/** The hidden marker that identifies THE watch issue (searched for in the body). */
export const WATCH_MARKER = '<!-- mendr-watch:v1 -->';

/** A second marker, present ONLY in the all-clear body, so a Mendr close is distinguishable from a human one. */
export const WATCH_CLEAR_MARKER = '<!-- mendr-watch:clear -->';

/** Constant issue title — never varies, so a re-render never notifies. */
export const WATCH_ISSUE_TITLE = 'Mendr Watch: deprecated model ids in this repo';

/** The label the workflow puts on the issue. */
export const WATCH_LABEL = 'mendr-watch';

/** The install spec the issue/summary tell a reader to run for proposed fixes. */
export const MENDR_RUN_SPEC = 'npx github:ajitheee/mendr fix-llm .';

/** The one-line ordering note printed under the header. */
export const ORDER_NOTE = 'Highest risk first, then nearest deadline.';

// --- shared classification / formatting ------------------------------------

/** Human countdown for one model — day-granularity, never an exact-time claim. */
export function countdownLabel(model: ExposedModel, now: Date): string {
  const days = daysUntil(model.shutdownDate, now);
  if (days === null) return model.status === 'retired' ? 'retired' : 'unscheduled';
  if (days < 0) return `retired ${-days}d ago`;
  if (days === 0) return 'retires today';
  return `${days}d left`;
}

/** Models whose highest occurrence needs a look (Tier A or B). */
export function reviewModels(models: readonly ExposedModel[]): ExposedModel[] {
  return models.filter((m) => m.highestTier !== 'C');
}

/** Models that are purely informational data (Tier C only). */
export function infoModels(models: readonly ExposedModel[]): ExposedModel[] {
  return models.filter((m) => m.highestTier === 'C');
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** Compact location list: group by file, `file:L1,L2` per file, `; ` between files. */
function formatLocations(locs: readonly ExposureOccurrence[]): string {
  const byFile = new Map<string, number[]>();
  for (const l of locs) {
    const list = byFile.get(l.file);
    if (list) list.push(l.line);
    else byFile.set(l.file, [l.line]);
  }
  return [...byFile.entries()]
    .map(([file, lines]) => `${file}:${[...new Set(lines)].sort((a, b) => a - b).join(',')}`)
    .join('; ');
}

/**
 * The per-tier breakdown lines for one model, most-severe tier first. Tier A is
 * auto-fixable, Tier B is split by its reason code (usage-unverified, etc.), Tier
 * C is data. Each line carries the true count and the exact locations.
 */
export function tierDetailLines(model: ExposedModel): string[] {
  const lines: string[] = [];
  if (model.tierCounts.A > 0) {
    const locs = model.locations.filter((l) => l.tier === 'A');
    lines.push(
      `Tier A: ${model.tierCounts.A} auto-fixable ${plural(model.tierCounts.A, 'occurrence')}` +
        (locs.length ? ` at ${formatLocations(locs)}` : ''),
    );
  }
  const bLocs = model.locations.filter((l) => l.tier === 'B');
  const reasonsPresent = new Set(bLocs.map((l) => l.reason).filter(Boolean) as TierBReason[]);
  for (const reason of TIER_B_REASON_ORDER) {
    if (!reasonsPresent.has(reason)) continue;
    const rl = bLocs.filter((l) => l.reason === reason);
    lines.push(
      `Tier B: ${rl.length} ${TIER_B_SHORT[reason]} ${plural(rl.length, 'occurrence')} at ${formatLocations(rl)}`,
    );
  }
  if (model.tierCounts.C > 0) {
    const locs = model.locations.filter((l) => l.tier === 'C');
    lines.push(
      `Tier C: ${model.tierCounts.C} data ${plural(model.tierCounts.C, 'occurrence')}` +
        (locs.length ? ` at ${formatLocations(locs)}` : ''),
    );
  }
  return lines;
}

// --- provider coverage (for the all-clear body) ----------------------------

const PROVIDER_DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google (Gemini)',
  azure: 'Azure',
};

function displayProvider(p: string): string {
  return PROVIDER_DISPLAY[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** What a clean result actually covers, so "nothing found" is never "you are safe". */
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

// --- the issue body --------------------------------------------------------

/** The shared footer: what this issue is, and the honest limits of the timing. */
function footer(now: Date): string {
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
  return [
    '<sub>',
    `This is a single, self-updating issue maintained by [Mendr](https://github.com/ajitheee/mendr) — ` +
      `edited in place, never re-posted. Occurrences are classified into the same A/B/C tiers as ` +
      `\`mendr fix-llm\`. Countdowns are day-granularity (last updated ${stamp} UTC) and derive from ` +
      `provider retirement dates in Mendr's registry; they are not exact-time guarantees. Exposure detail ` +
      `is committed at \`${EXPOSURE_RELATIVE_PATH}\`.`,
    '</sub>',
  ].join('\n');
}

/**
 * Render the full watch issue body (markdown), including the hidden marker.
 * `registry` is unused now (kept for signature stability with callers). An empty
 * exposure renders an all-clear body carrying both markers.
 */
export function renderIssueBody(exposure: Exposure, registry: LlmRegistry, now: Date): string {
  const { models } = exposure;

  if (models.length === 0) {
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

  const review = reviewModels(models);
  const info = infoModels(models);
  const occ = totalOccurrences(models);
  const lines: string[] = [
    WATCH_MARKER,
    '',
    '### Mendr Watch',
    '',
    `**${models.length}** deprecated model id${models.length === 1 ? '' : 's'}, ` +
      `**${occ}** unique occurrence${occ === 1 ? '' : 's'}. ${ORDER_NOTE}`,
  ];

  const renderModelBlock = (model: ExposedModel): void => {
    lines.push(
      '',
      `- **\`${model.id}\`** → \`${model.replacement}\` · ${countdownLabel(model, now)}`,
    );
    for (const detail of tierDetailLines(model)) lines.push(`  - ${detail}`);
  };

  if (review.length > 0) {
    lines.push('', '#### Review required');
    for (const m of review) renderModelBlock(m);
  }
  if (info.length > 0) {
    lines.push('', '#### Informational');
    for (const m of info) renderModelBlock(m);
  }

  // fix-llm produces a diff ONLY for Tier A. Say exactly which case applies.
  const hasA = models.some((m) => m.tierCounts.A > 0);
  const hasB = models.some((m) => m.tierCounts.B > 0);
  lines.push(
    '',
    hasA
      ? `See a proposed, verified diff with \`${MENDR_RUN_SPEC}\` for the Tier A rows. Nothing is changed ` +
          'without your review — Mendr only ever opens a diff or a pull request.'
      : hasB
        ? `\`${MENDR_RUN_SPEC}\` shows the Tier B review rows in full (no patch is generated for them).`
        : 'Every occurrence above is a data reference, not a live model call, so there is nothing for ' +
            `\`${MENDR_RUN_SPEC}\` to rewrite — this is a heads-up, not a fix.`,
    '',
    footer(now),
  );
  return `${lines.join('\n')}\n`;
}

// --- the badge -------------------------------------------------------------

/** Build one shields.io static-badge markdown image (escaping `-`/`_`/spaces). */
function badgeUrl(right: string, color: string): string {
  const seg = (s: string): string => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
  return `![mendr watch](https://img.shields.io/badge/${seg('mendr')}-${seg(right)}-${color})`;
}

/**
 * An OPTIONAL static shields.io snapshot for the README. The label counts models
 * by their highest classification (review = Tier A/B, info = Tier C); the colour
 * tracks the single most severe TIER present anywhere in the repo:
 *   Tier A present -> red    (a live call with a ready fix — act now)
 *   Tier B present -> orange (review required)
 *   Tier C only    -> blue   (informational data)
 *   no findings    -> green
 */
export function renderBadge(exposure: Exposure): string {
  const { models } = exposure;
  if (models.length === 0) return badgeUrl('no deprecations', 'brightgreen');
  const hasA = models.some((m) => m.tierCounts.A > 0);
  const hasB = models.some((m) => m.tierCounts.B > 0);
  const color = hasA ? 'red' : hasB ? 'orange' : 'blue';
  const right = `${reviewModels(models).length} review · ${infoModels(models).length} info`;
  return badgeUrl(right, color);
}

// --- the terminal summary --------------------------------------------------

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

  const review = reviewModels(models);
  const info = infoModels(models);
  const occ = totalOccurrences(models);
  const lines: string[] = [
    `Mendr Watch: ${models.length} deprecated model id${models.length === 1 ? '' : 's'}, ` +
      `${occ} unique occurrence${occ === 1 ? '' : 's'}`,
    ORDER_NOTE,
  ];

  const renderGroup = (title: string, group: readonly ExposedModel[]): void => {
    if (group.length === 0) return;
    lines.push('', title);
    for (const model of group) {
      lines.push(
        `  ${countdownLabel(model, now).padEnd(16)} ${model.id} -> ${model.replacement}`,
      );
      for (const detail of tierDetailLines(model)) lines.push(`    ${detail}`);
    }
  };

  renderGroup('REVIEW REQUIRED', review);
  renderGroup('INFORMATIONAL', info);
  return lines.join('\n');
}
