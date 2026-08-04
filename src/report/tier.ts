import type { AffectedSite, Tier } from '../types.js';

// TODO Phase 6: classify a fix into a confidence tier (A = safe, C = review).

/** Classify the confidence tier for a set of applied fixes. */
export function classifyTier(sites: AffectedSite[]): Tier {
  throw new Error('classifyTier not implemented yet (Phase 6)');
}
