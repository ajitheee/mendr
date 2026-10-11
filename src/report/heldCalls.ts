import { relative } from 'node:path';
import type { LlmModelIdDeprecation, TierBReason } from '../types.js';
import type { PyModelIdFixResult } from '../python/fixPy.js';
import {
  TYPE_CAST_REASON,
  USAGE_UNVERIFIED_REASON,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toHeldCallMatches,
  toModelIdDataMatches,
  toUntracedMatches,
  type AzureDeploymentLocate,
  type BlockedModelLocate,
  type HeldSiteMatch,
  type LiteralMatch,
  type ModelIdDataLocate,
  type UsageUnverifiedLocate,
} from '../usage/scanLiterals.js';
import { classifyOccurrenceTier } from './classifyOccurrence.js';
import { TIER_B_REASON_ORDER, TIER_B_REASON_TEXT } from './tiers.js';

// THE TIER B STREAMS, in one place, for every command that has to say what it left for a person.
//
// `fix-llm` assembled its Tier B list from six projections of one TypeScript scan and one Python
// pass, inline in cli.ts. `migrate` ran the same two scans and kept only two of the six (the
// TypeScript blocked replacements and the Azure deployment aliases), so a repository whose only
// findings were held calls read "NO MIGRATION", listed nothing, and the Action reported it clean
// and closed an open Mendr pull request (the v0.5.10-alpha known issue). Both commands now take
// the streams from here, and the reason codes come from classifyOccurrenceTier, which `audit` and
// `watch` already use, so the four commands cannot disagree about which calls are held or why.

/** A Tier B occurrence as the scanners report it: a TypeScript or a Python match. */
export interface HeldMatch extends HeldSiteMatch {
  value: string;
  deprecation: LlmModelIdDeprecation;
  reason?: string;
}

/**
 * The six Tier B streams, from one TypeScript literal scan and one Python fix pass. Each stream
 * is one site per occurrence, and no site is in two streams (see oneMatchPerSite).
 */
export interface TierBStreams {
  /** A live model argument whose replacement the registry will not vouch for: `replacement_unverified`. */
  blocked: BlockedModelLocate[];
  /** A value under a deployment key: `platform_blocked`. */
  azure: AzureDeploymentLocate[];
  /** Python model-like assignments with no traced sink: `usage_unverified`. */
  usageUnverifiedPy: UsageUnverifiedLocate[];
  /** TypeScript untraced selectors (a model-named const, a default-config object): `usage_unverified`. */
  untracedTs: HeldMatch[];
  /** Calls the scanners held at review, both languages: the code classifyOccurrenceTier gives each. */
  capped: HeldMatch[];
  /** A model argument behind an `as` cast to a named type, both languages: `type_cast_masked`. */
  castMasked: ModelIdDataLocate[];
}

/** The Python half the streams read (the fields of applyPyModelIdFixesToSources's result). */
export type PyTierBSource = Pick<
  PyModelIdFixResult,
  'blockedMatches' | 'azureMatches' | 'usageUnverifiedMatches' | 'heldMatches' | 'dataMatches'
>;

/** Split one TypeScript scan and one Python pass into the Tier B streams. */
export function tierBStreams(tsMatches: LiteralMatch[], py: PyTierBSource): TierBStreams {
  return {
    blocked: [...toBlockedModelArgMatches(tsMatches), ...py.blockedMatches],
    azure: [...toAzureDeploymentMatches(tsMatches), ...py.azureMatches],
    usageUnverifiedPy: py.usageUnverifiedMatches,
    untracedTs: toUntracedMatches(tsMatches),
    capped: [...toHeldCallMatches(tsMatches), ...py.heldMatches],
    // The cast guard's matches ride in the data stream (so the codemod cannot touch them), but
    // they are not informational: the id is in a live-looking position. They are the one data
    // match that is Tier B; every other data match is Tier C.
    castMasked: [...toModelIdDataMatches(tsMatches), ...py.dataMatches].filter((d) => d.reason === TYPE_CAST_REASON),
  };
}

/** The reason code of an untraced or held match: the one audit, watch and fix-llm give it. */
export function heldReasonCode(m: HeldMatch, fallback: TierBReason): TierBReason {
  return classifyOccurrenceTier(m).reason ?? fallback;
}

/**
 * One retiring id in code that a migration did not rewrite, because a person has to decide.
 *
 * `migrate`'s JSON carries these as `skipped`; the field kept its name so a consumer that already
 * reads it keeps working, and it now carries every Tier B occurrence instead of two kinds of them.
 */
export interface HeldCall {
  /** Repo-relative path, forward slashes. */
  file: string;
  line: number;
  column: number;
  /** The id as written at that line. */
  model: string;
  /** The id the registry names as its replacement. Context only: nothing was changed. */
  replacement: string;
  /** The Tier B reason code, the same one `fix-llm` and `audit` give this occurrence. */
  code: TierBReason;
  /** Why it was left for a person: the scanner's own sentence where it has one. */
  reason: string;
  language: 'ts' | 'py';
}

/** The sentence the registry stream used before this list existed; kept word for word. */
function blockedSentence(b: BlockedModelLocate): string {
  return (
    `the registry will not vouch for "${b.replacement}" as its replacement ` +
    `(${b.status}) — human review, never an automatic rewrite`
  );
}

const AZURE_SENTENCE = "an Azure deployment alias - the name is yours, not the provider's, so it is never rewritten";

/**
 * Every Tier B occurrence in the streams, as a flat list a migration can print and publish.
 * Ordered as fix-llm orders its Tier B section: by reason (most actionable first), then by file,
 * line and column.
 */
export function heldCallsOf(streams: TierBStreams, repoPath: string): HeldCall[] {
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const language = (file: string): 'ts' | 'py' => (/\.pyi?$/i.test(file) ? 'py' : 'ts');
  const row = (
    loc: { file: string; line: number; column: number },
    model: string,
    replacement: string,
    code: TierBReason,
    reason: string,
  ): HeldCall => ({ file: rel(loc.file), line: loc.line, column: loc.column, model, replacement, code, reason, language: language(loc.file) });
  // The scanner's sentence says which rule held the call; the generic sentence is the fallback,
  // so every row carries a reason a person can read.
  const said = (specific: string | undefined, code: TierBReason, generic?: string): string =>
    specific && specific !== generic ? specific : TIER_B_REASON_TEXT[code];

  const out: HeldCall[] = [
    ...streams.blocked.map((b) => row(b.location, b.value, b.replacement, 'replacement_unverified', blockedSentence(b))),
    ...streams.azure.map((a) => row(a.location, a.value, a.replacement, 'platform_blocked', AZURE_SENTENCE)),
    ...streams.usageUnverifiedPy.map((u) =>
      row(u.location, u.value, u.replacement, 'usage_unverified', said(u.reason, 'usage_unverified', USAGE_UNVERIFIED_REASON)),
    ),
    ...streams.untracedTs.map((m) => {
      const code = heldReasonCode(m, 'usage_unverified');
      return row(m.location, m.value, m.deprecation.replacement, code, said(m.reason, code));
    }),
    ...streams.capped.map((m) => {
      const code = heldReasonCode(m, 'surface_capped');
      return row(m.location, m.value, m.deprecation.replacement, code, said(m.reason, code));
    }),
    ...streams.castMasked.map((d) => row(d.location, d.value, d.replacement, 'type_cast_masked', TIER_B_REASON_TEXT.type_cast_masked)),
  ];
  const rank = (r: TierBReason): number => {
    const i = TIER_B_REASON_ORDER.indexOf(r);
    return i === -1 ? TIER_B_REASON_ORDER.length : i;
  };
  return out.sort(
    (a, b) => rank(a.code) - rank(b.code) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}
