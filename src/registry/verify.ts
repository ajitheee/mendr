// Registry verification — the PURE classifier.
//
// Given a registry `model_id` entry and pre-fetched oracle data (live catalog
// ids + the provider's official recommendation table), decide whether the
// registry's replacement is trustworthy enough to AUTO-APPLY. All network I/O
// lives in oracles.ts; this module is pure and fully unit-testable with
// hand-built fixtures.
//
// STATUS RULE (from the registry-verify spike):
//   verified     replacement is live in >=1 public catalog AND is NOT
//                contradicted by the provider's official recommendation.
//   unverified   replacement is live but STALE (a newer official target
//                exists), CHAINED (the replacement is itself deprecated), or
//                simply not found live for an in-class model. Live-but-wrong ->
//                block; blocking is always safer than a bad auto-swap.
//   unverifiable replacement is OUT-OF-CLASS (moderation/image/audio/tts) —
//                public catalogs don't list these classes, so a miss is NOT
//                evidence the mapping is wrong. We neither trust nor condemn it.

import type { LlmModelIdDeprecation, VerificationStatus } from '../types.js';
import {
  canonicalizeId,
  inferModelClass,
  isCatalogVerifiableClass,
  isLiveId,
} from './normalize.js';

/** The oracle inputs a classification is computed against (all pre-fetched). */
export interface VerificationOracles {
  /** Canonical + family forms of every live catalog id (see oracles.ts). */
  liveIds: ReadonlySet<string>;
  /**
   * Provider deprecation table: canonical deprecated id -> officially
   * recommended replacement id. Membership of a KEY additionally marks that id
   * as deprecated, which drives the chained-deprecation check.
   */
  officialRecommendations: ReadonlyMap<string, string>;
}

/**
 * The verdict for one entry: a status plus the human-readable reasons behind it.
 *
 * CONSTRAINT: the classifier can never return `quarantined`. Quarantine is a
 * REVIEW decision about a record (a human, or a migration, deciding this
 * mapping is not to be trusted yet), not a catalog fact — and typing it out of
 * this union is what stops a routine re-stamp from silently un-quarantining an
 * entry by overwriting its status with a fresh catalog verdict.
 */
export interface ClassifyResult {
  status: Exclude<VerificationStatus, 'quarantined'>;
  reasons: string[];
}

/**
 * Classify a single `model_id` deprecation against the oracle data. Pure: no
 * fetch, no clock, no filesystem — the same inputs always yield the same result.
 */
export function classifyEntry(
  entry: LlmModelIdDeprecation,
  oracles: VerificationOracles,
): ClassifyResult {
  const { deprecated, replacement } = entry;
  const { liveIds, officialRecommendations } = oracles;
  const reasons: string[] = [];

  // (1) OUT-OF-CLASS -> unverifiable. If either the retired id or its
  // replacement is a moderation/image/audio/tts model, public catalogs simply
  // don't list the class, so a missing replacement is not a wrong mapping.
  const depClass = inferModelClass(deprecated);
  const replClass = inferModelClass(replacement);
  const outOfClass = !isCatalogVerifiableClass(depClass)
    ? depClass
    : !isCatalogVerifiableClass(replClass)
      ? replClass
      : null;
  if (outOfClass) {
    reasons.push(
      `"${deprecated}" is a ${outOfClass} model; public catalogs (models.dev, OpenRouter) ` +
        `do not list this class, so "${replacement}" cannot be catalog-verified ` +
        `(this is NOT evidence the mapping is wrong)`,
    );
    return { status: 'unverifiable', reasons };
  }

  const canonReplacement = canonicalizeId(replacement);

  // (2) CHAINED -> unverified. The replacement is ITSELF a deprecated id (it
  // appears as a key in the official recommendation table): a deprecation that
  // points at another deprecation. Never auto-apply a moving target.
  if (officialRecommendations.has(canonReplacement)) {
    const onward = officialRecommendations.get(canonReplacement)!;
    reasons.push(
      `replacement "${replacement}" is ITSELF deprecated (chained deprecation); ` +
        `the provider now recommends "${onward}" beyond it`,
    );
    return { status: 'unverified', reasons };
  }

  // (3) LIVENESS in a public catalog (family-aware: bare alias <-> dated snapshot).
  const live = isLiveId(replacement, liveIds);

  // (4) OFFICIAL-RECOMMENDATION contradiction (stale / superseded). Identity
  // check, not family: we want the registry to carry the EXACT recommended id.
  const official = officialRecommendations.get(canonicalizeId(deprecated));
  const staleVsOfficial = official !== undefined && canonicalizeId(official) !== canonReplacement;

  if (!live) {
    reasons.push(
      `replacement "${replacement}" was not found live in any public catalog (models.dev / OpenRouter)`,
    );
    if (staleVsOfficial) reasons.push(`the provider officially recommends "${official}"`);
    return { status: 'unverified', reasons };
  }
  reasons.push(`replacement "${replacement}" is live in a public catalog`);

  if (staleVsOfficial) {
    reasons.push(
      `the provider officially recommends "${official}", but the registry uses "${replacement}" ` +
        `(live, but not the currently-recommended target — stale)`,
    );
    return { status: 'unverified', reasons };
  }

  if (official !== undefined) {
    reasons.push(`matches the provider's officially-recommended replacement "${official}"`);
  }
  return { status: 'verified', reasons };
}

// --- the structured safety switches -----------------------------------------
//
// ONE derivation, used everywhere a `verification` block is written: the
// migration that backfilled the shipped registry, `verify-registry --write`,
// and `candidates promote`. Three call sites computing "is this auto-appliable"
// three ways is how the stamp and the reasons drifted apart in the first place.

/**
 * Does the PROVIDER'S OWN documentation confirm this deprecation?
 *
 * Deliberately narrow and mechanical: the record must name a source page AND
 * carry something read off it — a lifecycle (`status`) or a `shutdownDate`. A
 * url with no lifecycle claim is a bookmark, not a confirmation; a lifecycle
 * with no url is an assertion. Neither earns `true`.
 *
 * This does NOT check that the url is reachable, that it is the provider's own
 * domain rather than a mirror, or that the page still says what it said. Those
 * are evidence-layer questions (see registry/evidence.ts). When unsure, false.
 */
export function officialSourceConfirmed(
  entry: Pick<LlmModelIdDeprecation, 'sourceUrl' | 'status' | 'shutdownDate'>,
): boolean {
  const hasSource = typeof entry.sourceUrl === 'string' && entry.sourceUrl.trim().length > 0;
  const hasLifecycle = Boolean(entry.status) || Boolean(entry.shutdownDate);
  return hasSource && hasLifecycle;
}

/** The three booleans the engine gate reads, derived from one classifier run. */
export interface VerificationSwitches {
  officialSourceConfirmed: boolean;
  replacementConfirmed: boolean;
  autoApplyAllowed: boolean;
}

/**
 * Derive the switches for a record from its own fields plus a classifier
 * verdict.
 *
 * `autoApplyAllowed` is the CONJUNCTION, never an independent judgement: a
 * record is auto-appliable exactly when the catalogs confirm the replacement,
 * the provider's docs confirm the deprecation, and the verdict is `verified`.
 * A caller may force it off (`withhold`) — quarantine does that — but nothing
 * can force it on.
 */
export function verificationSwitches(
  entry: Pick<LlmModelIdDeprecation, 'sourceUrl' | 'status' | 'shutdownDate'>,
  classifierStatus: ClassifyResult['status'],
  withhold = false,
): VerificationSwitches {
  const official = officialSourceConfirmed(entry);
  const replacement = classifierStatus === 'verified';
  return {
    officialSourceConfirmed: official,
    replacementConfirmed: replacement,
    autoApplyAllowed: !withhold && official && replacement,
  };
}

// --- re-stamping without erasing the humans ---------------------------------
//
// `verify-registry --write` rewrites each entry's `verification` block from a
// fresh classification. Left naive, that write is DESTRUCTIVE: every reason in
// the shipped registry is hand-written research ("Confirmed retired
// 2024-09-13…", "retirement confirmed by a real production breakage…", "do not
// auto-apply until verified"), and a re-stamp would replace all of it with the
// classifier's one-line catalog verdict.
//
// Those caveats no longer HOLD anything back on their own -- the engine reads
// the four structured switches, and the records they describe are quarantined
// in the data. But they are still the working a reviewer needs in order to lift
// a quarantine, and they are still what the CI prose lint reads to catch a
// caveat left standing over a switched-on record. Erasing them during a routine
// recheck would delete the audit trail and disarm the lint in one move. So a
// re-stamp REPLACES the machine's own sentences and KEEPS everything a person
// wrote.

/**
 * The sentences {@link classifyEntry} itself produces, as anchored patterns.
 * Recognising them is what makes a re-stamp idempotent: the machine's previous
 * verdict is regenerated rather than accumulated, while anything that does not
 * match one of these was written by a human and is kept.
 */
const MACHINE_REASON_PATTERNS: readonly RegExp[] = [
  /^"[^"]+" is a \w+ model; public catalogs \(models\.dev, OpenRouter\) do not list this class/,
  /^replacement "[^"]+" is ITSELF deprecated \(chained deprecation\)/,
  /^replacement "[^"]+" was not found live in any public catalog/,
  /^replacement "[^"]+" is live in a public catalog$/,
  /^the provider officially recommends "[^"]+"/,
  /^matches the provider's officially-recommended replacement "[^"]+"/,
];

/** Was this reason written by the classifier (rather than by a person)? */
export function isMachineReason(reason: string): boolean {
  return MACHINE_REASON_PATTERNS.some((re) => re.test(reason.trim()));
}

/**
 * The reason list a re-stamp should write: this run's machine verdict, then
 * every human reason the entry already carried, in its original order and
 * verbatim. Duplicates are dropped, so re-running is idempotent.
 */
export function mergeReasons(
  fresh: readonly string[],
  prior: readonly string[] | undefined,
): string[] {
  const carried = (prior ?? []).filter((r) => !isMachineReason(r) && !fresh.includes(r));
  return [...fresh, ...carried];
}
