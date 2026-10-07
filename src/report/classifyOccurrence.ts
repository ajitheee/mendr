import type { LlmModelIdDeprecation, TierBReason } from '../types.js';
import { isVerified } from '../usage/llmRegistry.js';
import { TYPE_CAST_REASON, type LiteralPosition } from '../usage/scanLiterals.js';
import type { Tier } from './tiers.js';
import { isCoupledParamReason, isParamBehaviourReason } from '../usage/coupledParams.js';

// THE ONE per-occurrence tier classifier, shared by fix-llm and watch.
//
// WHY THIS EXISTS: watch used to map a scan position to a private
// live/review/data vocabulary, which drifted from the A/B/C tiers fix-llm
// reports — the same gpt-4 occurrence read "Tier B, review" under fix-llm and
// "data only" under watch. That is exactly the "second simplified classifier"
// to avoid. Both surfaces now call this function, so an occurrence lands in one
// tier, computed one way. It is a pure function of the SAME fields the scanners
// already attach to every match (position, the registry record, the per-match
// reason), so it introduces no new detection.
//
// The rules mirror how fix-llm splits its matches:
//   model_arg + verified        -> Tier A (a safe auto-patch)
//   model_arg + not verified     -> Tier B (replacement_unverified)
//   usage_unverified (py sink)   -> Tier B (usage_unverified)
//   azure_deployment             -> Tier B (platform_blocked)
//   surface_capped               -> Tier B (param_behaviour_change, coupled_param_unverified,
//                                   or surface_capped for every other surface rule)
//   data behind an `as` cast     -> Tier B (type_cast_masked)
//   data otherwise               -> Tier C (informational)

/** The fields the classifier reads — the common shape of a TS/Python match. */
export interface OccurrenceInput {
  position: LiteralPosition;
  deprecation: LlmModelIdDeprecation;
  /** The per-match review override (e.g. the type-cast guard on a data literal). */
  reason?: string;
}

/** The tier an occurrence lands in, plus the Tier B reason code when tier is B. */
export interface OccurrenceTier {
  tier: Tier;
  /** Present iff `tier === 'B'`. */
  reason?: TierBReason;
}

/** Classify one matched occurrence into exactly one terminal tier. */
export function classifyOccurrenceTier(m: OccurrenceInput): OccurrenceTier {
  if (m.position === 'model_arg') {
    return isVerified(m.deprecation)
      ? { tier: 'A' }
      : { tier: 'B', reason: 'replacement_unverified' };
  }
  if (m.position === 'usage_unverified') return { tier: 'B', reason: 'usage_unverified' };
  if (m.position === 'azure_deployment') return { tier: 'B', reason: 'platform_blocked' };
  // A real call site the guards capped at review — never an unattended swap.
  if (m.position === 'surface_capped') {
    // The parameter guards say the REQUEST is the question (see coupledParams.ts); every other
    // surface rule says the call's surface is. Neither is a deployment key: these used to fall
    // back to `platform_blocked`, whose sentence ("sits under a deployment key") was false for
    // an example tree, a gateway prefix, a wrapper class or a proxy client, and which put those
    // calls in fix-llm's legacy `azure` array.
    if (isParamBehaviourReason(m.reason)) return { tier: 'B', reason: 'param_behaviour_change' };
    return isCoupledParamReason(m.reason)
      ? { tier: 'B', reason: 'coupled_param_unverified' }
      : { tier: 'B', reason: 'surface_capped' };
  }
  if (m.reason === TYPE_CAST_REASON) return { tier: 'B', reason: 'type_cast_masked' };
  return { tier: 'C' };
}

/** Short human label for a Tier B reason, used in the watch's per-tier lines. */
export const TIER_B_SHORT: Record<TierBReason, string> = {
  usage_unverified: 'usage-unverified',
  replacement_unverified: 'unverified-replacement',
  platform_blocked: 'deployment-alias',
  surface_capped: 'held-at-surface',
  coupled_param_unverified: 'coupled-param-unverified',
  param_behaviour_change: 'param-changes-request',
  type_cast_masked: 'type-cast-masked',
  dynamic_model_value: 'dynamic-value',
  insufficient_dataflow: 'untraced',
};
