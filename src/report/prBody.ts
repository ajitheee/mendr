import type { AffectedSite, Tier } from '../types.js';

// TODO Phase 6: build a human-readable PR body summarizing the fixes and tier.

/** Build a PR body summarizing the applied fixes and their confidence tier. */
export function buildPrBody(sites: AffectedSite[], tier: Tier): string {
  throw new Error('buildPrBody not implemented yet (Phase 6)');
}
