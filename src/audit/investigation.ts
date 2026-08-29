// The unified evidence record (roadmap #3) — one investigation per deprecated
// model, joining every source mendr has: registry retirement evidence, provider
// usage/cost (MEASURE), and config locations (LOCATE). This one object is what
// the CLI, --json, and any future issue/PR/dashboard all render from, so the
// facts (and the honesty rules) live in ONE place, not per surface.
//
// HONESTY INVARIANTS baked in here, not left to the renderer:
//   * A config match is a "runtime selector CANDIDATE", never a proven
//     "controlling configuration" — `readerTieBackProven` is ALWAYS false in
//     this build because no reader tie-back analysis exists yet.
//   * Because tie-back is unproven, anything actionable is `review_required`.
//     We NEVER emit a decision that says "change to X"; the registry replacement
//     rides along as EVIDENCE (with its verification verdict), not an action.
//   * A model with only catalog/reference occurrences and no observed usage is
//     `monitor` — nothing is proven live to change.

import type { ConfigExposure, ConfigMatch } from '../config/scanConfig.js';
import type { ExposureFinding, UsageAudit } from '../recon/types.js';
import type { Tier } from '../report/tiers.js';
import { daysUntil } from '../watch/exposure.js';

/** The only two decisions this build can honestly emit (no auto-change exists). */
export type AuditDecision = 'review_required' | 'monitor';

/** What ROLE a located occurrence plays — a candidate, never a proven control. */
export type LocationRole = 'runtime_selector_candidate' | 'catalog_definition' | 'catalog_reference';

/** One located occurrence of the model id, with its (unproven) role. */
export interface LocationRef {
  file: string;
  line: number;
  column: number;
  key: string | null;
  value: string;
  role: LocationRole;
  /** 'B' for a candidate selector, 'C' for catalog/reference. Never 'A' for config. */
  tier: Tier;
  /** Non-null when the file belongs to a non-direct surface (Bedrock/Vertex/Azure/proxy). */
  providerSurface: string | null;
}

/** The retirement facts, straight from the deprecation registry. */
export interface RetirementEvidence {
  deprecated: boolean;
  /** 'retired' | 'deprecated' | null (registry never claimed a lifecycle). */
  status: string | null;
  shutdownDate: string | null;
  /** Days until shutdown (negative = overdue, null = undated). */
  daysUntil: number | null;
  /** The registry's suggested replacement — EVIDENCE only, never auto-applied. */
  replacement: string | null;
  /** effectiveVerificationState of the replacement mapping. */
  replacementVerdict: string | null;
  sourceUrl: string | null;
}

/** What the provider usage API observed for this model over the period. */
export interface RuntimeExposure {
  /** True only when a usable usage dataset was obtained (not for no_data/error). */
  measured: boolean;
  /** True when this model appeared in the usage dataset. */
  observed: boolean;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One model's full investigation record — the join of every source. */
export interface ModelInvestigation {
  entryId: string | null;
  provider: string;
  model: string;
  retirementEvidence: RetirementEvidence;
  runtimeExposure: RuntimeExposure;
  locations: {
    /** Tier B — candidate runtime selectors (NOT proven to control selection). */
    selectors: LocationRef[];
    /** Tier C — catalog definitions and other references. */
    catalog: LocationRef[];
  };
  /**
   * Migration compatibility. Not evaluated in this build — the narrow sandbox
   * verification (roadmap #4) does not exist yet, so this stays unchecked rather
   * than claiming a green it never ran.
   */
  compatibility: { checked: false; result: null };
  verification: {
    replacementVerdict: string | null;
    /** ALWAYS false here: no reader tie-back analysis exists yet (roadmap #5). */
    readerTieBackProven: false;
  };
  decision: AuditDecision;
  reason: string;
}

function toLocation(m: ConfigMatch): LocationRef {
  const role: LocationRole =
    m.position === 'config_selector'
      ? 'runtime_selector_candidate'
      : m.purpose === 'catalog_definition'
        ? 'catalog_definition'
        : 'catalog_reference';
  return {
    file: m.file,
    line: m.line,
    column: m.column,
    key: m.key,
    value: m.value,
    role,
    tier: m.tier,
    providerSurface: m.providerSurface,
  };
}

/** Decide the outcome from the merged evidence. Actionable ⇒ review_required. */
function decide(inv: ModelInvestigation): { decision: AuditDecision; reason: string } {
  const hasSelector = inv.locations.selectors.length > 0;
  const hasUsage = inv.runtimeExposure.observed && inv.runtimeExposure.requests > 0;
  const hasCatalog = inv.locations.catalog.length > 0;

  if (hasSelector && hasUsage) {
    return {
      decision: 'review_required',
      reason:
        'Candidate selector located and runtime usage observed, but the reader tie-back proving this ' +
        'selector drives that traffic is not proven. Do not treat the runtime model and the configuration ' +
        'location as connected until the tie-back exists — human review required.',
    };
  }
  if (hasSelector) {
    return {
      decision: 'review_required',
      reason:
        'Candidate selector located; runtime usage was ' +
        (inv.runtimeExposure.measured ? 'not observed for this model' : 'not measured') +
        ', and the reader tie-back is not proven. Human review required before any change.',
    };
  }
  if (hasUsage) {
    return {
      decision: 'review_required',
      reason:
        'Runtime usage observed, but no controlling configuration was located — the selector may live in ' +
        'code, a datastore, or a runtime this scan did not cover. Human review required to find and change it.',
    };
  }
  if (hasCatalog) {
    return {
      decision: 'monitor',
      reason:
        'Only catalog/reference occurrences found (no candidate selector, no observed usage). Nothing is ' +
        'proven live to change — monitor.',
    };
  }
  return {
    decision: 'monitor',
    reason: inv.runtimeExposure.measured
      ? 'Listed as retiring in the registry, but no runtime usage and no configuration occurrence were found in this audit.'
      : 'Listed as retiring in the registry and located in configuration, but runtime usage was not measured (no provider key or --fixture).',
  };
}

/** review_required first, then by cost, requests, soonest deadline, model id. */
function compareInvestigation(a: ModelInvestigation, b: ModelInvestigation): number {
  const rank = (d: AuditDecision): number => (d === 'review_required' ? 0 : 1);
  if (rank(a.decision) !== rank(b.decision)) return rank(a.decision) - rank(b.decision);
  if (a.runtimeExposure.costUsd !== b.runtimeExposure.costUsd) return b.runtimeExposure.costUsd - a.runtimeExposure.costUsd;
  if (a.runtimeExposure.requests !== b.runtimeExposure.requests) return b.runtimeExposure.requests - a.runtimeExposure.requests;
  const ad = a.retirementEvidence.daysUntil;
  const bd = b.retirementEvidence.daysUntil;
  if (ad !== null && bd !== null && ad !== bd) return ad - bd;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/**
 * Join provider usage (MEASURE) and config locations (LOCATE) into one
 * investigation record per deprecated model.
 *
 * @param usage  the usage audit when a usable dataset was obtained, else null
 *               (no provider, --fixture absent, or a no_data/error result).
 * @param config the folded config exposures (always deprecated by construction).
 * @param now    the clock, passed in for a testable daysUntil fallback.
 */
export function buildInvestigations(
  usage: UsageAudit | null,
  config: readonly ConfigExposure[],
  now: Date,
): ModelInvestigation[] {
  const measured = usage !== null;
  const map = new Map<string, ModelInvestigation>();

  const seed = (key: string, entryId: string | null, provider: string, model: string): ModelInvestigation => {
    let inv = map.get(key);
    if (!inv) {
      inv = {
        entryId,
        provider,
        model,
        retirementEvidence: {
          deprecated: true,
          status: null,
          shutdownDate: null,
          daysUntil: null,
          replacement: null,
          replacementVerdict: null,
          sourceUrl: null,
        },
        runtimeExposure: { measured, observed: false, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        locations: { selectors: [], catalog: [] },
        compatibility: { checked: false, result: null },
        verification: { replacementVerdict: null, readerTieBackProven: false },
        decision: 'monitor',
        reason: '',
      };
      map.set(key, inv);
    }
    return inv;
  };

  // LOCATE half — config exposures carry the registry facts and the locations.
  for (const e of config) {
    const inv = seed(e.entryId, e.entryId, e.provider, e.model);
    inv.retirementEvidence.replacement = e.replacement;
    inv.retirementEvidence.replacementVerdict = e.replacementVerdict;
    inv.retirementEvidence.shutdownDate = e.shutdownDate;
    inv.verification.replacementVerdict = e.replacementVerdict;
    for (const m of e.selectors) inv.locations.selectors.push(toLocation(m));
    for (const m of e.catalog) inv.locations.catalog.push(toLocation(m));
  }

  // MEASURE half — the deprecated subset of observed usage. Usage carries the
  // richer lifecycle fields (status, daysUntil, sourceUrl), so it overlays.
  for (const f of usage?.exposed ?? []) {
    const key = f.entryId ?? `${f.provider}:${f.model}`;
    const inv = seed(key, f.entryId, f.provider, f.model);
    inv.runtimeExposure = {
      measured: true,
      observed: true,
      requests: f.requests,
      inputTokens: f.inputTokens,
      outputTokens: f.outputTokens,
      costUsd: f.costUsd,
    };
    inv.retirementEvidence.status = f.status;
    inv.retirementEvidence.shutdownDate = f.shutdownDate ?? inv.retirementEvidence.shutdownDate;
    inv.retirementEvidence.daysUntil = f.daysUntil;
    inv.retirementEvidence.replacement = f.replacement ?? inv.retirementEvidence.replacement;
    inv.retirementEvidence.replacementVerdict = f.replacementVerdict ?? inv.retirementEvidence.replacementVerdict;
    inv.retirementEvidence.sourceUrl = f.sourceUrl;
    if (inv.verification.replacementVerdict === null) inv.verification.replacementVerdict = f.replacementVerdict;
  }

  for (const inv of map.values()) {
    if (inv.retirementEvidence.daysUntil === null && inv.retirementEvidence.shutdownDate) {
      inv.retirementEvidence.daysUntil = daysUntil(inv.retirementEvidence.shutdownDate, now);
    }
    const { decision, reason } = decide(inv);
    inv.decision = decision;
    inv.reason = reason;
  }

  return [...map.values()].sort(compareInvestigation);
}
