// Registry verification — the PURE classifier.
//
// Given a registry `model_id` entry and pre-fetched oracle data (live catalog
// ids + the provider's official recommendation table), decide whether the
// registry's replacement is trustworthy enough to AUTO-APPLY. All network I/O
// lives in oracles.ts; this module is pure and fully unit-testable with
// hand-built fixtures.
//
// STATUS RULE (from the registry-verify spike):
//   verified     replacement is live in the direct-provider catalog (models.dev;
//                an OpenRouter-only spelling never counts) AND is NOT
//                contradicted by the provider's official recommendation.
//   unverified   replacement is live but STALE (a newer official target
//                exists), CHAINED (the replacement is itself deprecated), one
//                of SEVERAL the provider names, a FAMILY CHANGE (a fine-tune
//                retired to a base model, Veo retired to Gemini), or simply
//                not found live for an in-class model. Live-but-wrong ->
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
  /**
   * Canonical + family forms of every DIRECT-PROVIDER catalog id (models.dev; see
   * oracles.ts). The only set that can make a replacement live.
   */
  liveIds: ReadonlySet<string>;
  /**
   * Canonical + family forms of every id OpenRouter lists (oracles.ts#fetchLiveIds).
   *
   * NEVER makes a replacement live. OpenRouter's ids are its routing names: it lists dotted
   * Claude spellings outside Anthropic's documented id format, `gpt-6-sol-pro`-style ids
   * where OpenAI does pro as a request setting, and ids a provider has already shut down. Here it only explains a
   * miss ("only OpenRouter lists it"); claimCheck.ts reads it to refuse a `retired` claim.
   * It can make a verdict more cautious, never less. Optional so hand-built oracles in tests
   * and older callers keep working; absent means "not consulted".
   */
  routedIds?: ReadonlySet<string>;
  /**
   * Provider deprecation table: canonical deprecated id -> officially
   * recommended replacement id. Membership of a KEY additionally marks that id
   * as deprecated, which drives the chained-deprecation check.
   */
  officialRecommendations: ReadonlyMap<string, string>;
  /**
   * Canonical ids the REGISTRY ITSELF already records as deprecated, mapped to a short
   * description of what it knows ("retired, shutdown 2026-06-25").
   *
   * The chained-deprecation check used to consult `officialRecommendations` alone, which is
   * the hand-curated table in oracles.ts — and its `google` section is empty. So the registry
   * could hold, and a discovery pass could stage, a mapping whose replacement the SAME file
   * marks retired months ago. Five such rows were staged on 2026-09-14, including
   * gemini-2.5-flash-image -> gemini-3.1-flash-image-preview, retired 81 days earlier.
   * Promoting one would make Mendr propose swapping working code to a model that already
   * returns 404, under a verified label. The registry's own contents are the cheapest and
   * most trustworthy evidence available here, and they were not being read.
   *
   * DOWNGRADE-ONLY, by construction: this set can turn `verified` into `unverified` and can
   * never do the reverse, so a wrong entry here costs a refusal, never a bad edit.
   */
  knownDeprecated?: ReadonlyMap<string, string>;
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
/**
 * What the registry itself already knows is deprecated, keyed by canonical id.
 *
 * Feed it every entry in the world a promotion would create: the active registry, plus the
 * candidate queue when classifying candidates. That is what lets the chained check catch a
 * candidate pointing at another candidate, which is how the five dead-target rows staged on
 * 2026-09-14 got past a check that only read the curated per-provider table.
 */
export function knownDeprecatedFrom(
  entries: readonly { kind?: string; deprecated?: string; status?: string; shutdownDate?: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'model_id' || !e.deprecated) continue;
    const shutdown = (e.shutdownDate ?? '').slice(0, 10);
    const note = [e.status ?? 'deprecated', shutdown ? `shutdown ${shutdown}` : null]
      .filter(Boolean)
      .join(', ');
    // First writer wins: the active registry is authoritative over a pending candidate.
    if (!out.has(canonicalizeId(e.deprecated))) out.set(canonicalizeId(e.deprecated), note);
  }
  return out;
}

/**
 * The ids one provider recommendation names. Most rows name one. Some name a choice:
 * OpenAI's 2026-03-26 rows say "gpt-5 or gpt-4.1*", its dall-e rows "gpt-image-2,
 * gpt-image-1, or gpt-image-1-mini". A trailing footnote marker is dropped.
 */
export function namedReplacements(recommendation: string): string[] {
  return recommendation
    .split(/\s*,\s*(?:or\s+)?|\s+or\s+/)
    .map((id) => id.replace(/\*+$/, '').trim())
    .filter((id) => id.length > 0);
}

/** A fine-tune as OpenAI's table spells its row (`ft-gpt-4`) or as the API reports it (`ft:gpt-4:org::id`). */
const FINE_TUNE_ID = /^ft[-:]/;
/** Google's Veo video models. */
const VEO_ID = /^veo-/;

/**
 * A replacement that changes WHAT the caller runs, not which version of it. The catalogs can
 * say the replacement is live. They cannot say the swap keeps the call working, and for these
 * it does not:
 *   - a fine-tune is retired to a BASE model, so swapping the id drops the customer's training;
 *   - a Veo model is retired to Gemini Omni, a different family behind a different request
 *     (`models/<veo id>:predictLongRunning` against the Interactions API).
 * Until 2026-10-10 the only guard was a hand-written quarantine on each row that existed that
 * day. Discovery and check-dates admit `ft-` and `veo-` rows now, and the next one promoted
 * would have classified verified and been written auto-appliable.
 */
function familyChange(deprecated: string, replacement: string): string | null {
  const dep = deprecated.trim().toLowerCase();
  if (FINE_TUNE_ID.test(dep)) {
    return (
      `"${deprecated}" is a fine-tuned model; replacing its id with "${replacement}" drops ` +
      `the customer's training, so the swap is never automatic`
    );
  }
  if (VEO_ID.test(dep) && !VEO_ID.test(replacement.trim().toLowerCase())) {
    return (
      `"${deprecated}" is a Veo video model and "${replacement}" is not; the replacement is a ` +
      `different model family behind a different request, so the swap is never automatic`
    );
  }
  return null;
}

export function classifyEntry(
  entry: LlmModelIdDeprecation,
  oracles: VerificationOracles,
): ClassifyResult {
  const { deprecated, replacement } = entry;
  const { liveIds, routedIds, officialRecommendations, knownDeprecated } = oracles;
  const reasons: string[] = [];

  // (0) FAMILY CHANGE -> unverified, whatever the catalogs say. Checked first: no catalog
  // answer makes dropping a fine-tune's training, or changing the request shape, a safe edit.
  const changesFamily = familyChange(deprecated, replacement);
  if (changesFamily) {
    reasons.push(changesFamily);
    return { status: 'unverified', reasons };
  }

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

  // (2b) CHAINED, on the registry's OWN evidence. The curated table above is incomplete by
  // provider (google is empty), so also refuse when this very registry records the
  // replacement as deprecated. Never point a migration at a moving target, and never at a
  // target this file already knows is dead.
  const selfKnown = knownDeprecated?.get(canonReplacement);
  if (selfKnown) {
    reasons.push(
      `replacement "${replacement}" is ITSELF deprecated in this registry (${selfKnown}); ` +
        `a migration must not point at a retiring id`,
    );
    return { status: 'unverified', reasons };
  }

  // (3) LIVENESS in a direct-provider catalog (family-aware: bare alias <-> dated
  // snapshot). `routedIds` is deliberately not consulted here: an id only OpenRouter
  // lists is not one the provider's own API is known to accept.
  const live = isLiveId(replacement, liveIds);

  // (4) OFFICIAL-RECOMMENDATION contradiction (stale / superseded). Identity
  // check, not family: we want the registry to carry the EXACT recommended id.
  const official = officialRecommendations.get(canonicalizeId(deprecated));
  // (4a) A recommendation that names MORE THAN ONE replacement is a choice the provider left
  // to the caller. OpenAI's "gpt-5 or gpt-4.1*" footnotes gpt-4.1 as the one "for tasks that
  // are especially latency sensitive and don't require reasoning". Which applies depends on
  // the call, which no catalog can see, so whichever the registry carries stays review-only.
  const choice =
    official !== undefined && namedReplacements(official).length > 1
      ? `the provider names more than one replacement ("${official}"); which one fits a call ` +
        `is a person's decision, so the swap is never automatic`
      : null;
  const staleVsOfficial =
    choice === null && official !== undefined && canonicalizeId(official) !== canonReplacement;

  if (!live) {
    reasons.push(
      routedIds && isLiveId(replacement, routedIds)
        ? `replacement "${replacement}" was not found live in any public catalog of direct-provider ids ` +
            `(models.dev); only OpenRouter lists it, and an OpenRouter spelling is not evidence that ` +
            `the provider's own API accepts the id`
        : `replacement "${replacement}" was not found live in any public catalog (models.dev / OpenRouter)`,
    );
    if (choice) reasons.push(choice);
    if (staleVsOfficial) reasons.push(`the provider officially recommends "${official}"`);
    return { status: 'unverified', reasons };
  }
  reasons.push(`replacement "${replacement}" is live in a public catalog`);

  if (choice) {
    reasons.push(choice);
    return { status: 'unverified', reasons };
  }

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
  /^the provider names more than one replacement \("[^"]+"\)/,
  /^"[^"]+" is a fine-tuned model; replacing its id with "[^"]+" drops the customer's training/,
  /^"[^"]+" is a Veo video model and "[^"]+" is not; the replacement is a different model family/,
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
