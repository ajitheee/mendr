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

/** The verdict for one entry: a status plus the human-readable reasons behind it. */
export interface ClassifyResult {
  status: VerificationStatus;
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
