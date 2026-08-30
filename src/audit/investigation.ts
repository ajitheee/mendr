// The unified evidence record (roadmap #3) — one investigation per deprecated
// model, joining every source mendr has: registry retirement evidence, provider
// usage/cost (MEASURE), config locations, AND source-code locations (LOCATE from
// both config and TS/TSX/Python). This one object is what the CLI, --json, and any
// future issue/PR/dashboard all render from, so the facts (and the honesty rules)
// live in ONE place, not per surface.
//
// HONESTY INVARIANTS baked in here, not left to the renderer:
//   * A CONFIG match is a "runtime selector candidate", never a proven
//     "controlling configuration" — `readerTieBackProven` is ALWAYS false because
//     no config reader tie-back analysis exists yet.
//   * A CODE match carries the fix scanner's own classification: a proven model
//     argument ("code call site") vs an unproven model-like literal ("code
//     candidate") vs data ("code reference"). We never upgrade a candidate to a
//     call site.
//   * Anything actionable is `review_required`. We NEVER emit a decision that says
//     "change to X"; the registry replacement rides along as EVIDENCE only.
//   * A model with only catalog/reference/data occurrences and no observed usage
//     is `monitor` — nothing is proven live to change.

import type { ConfigExposure, ConfigMatch } from '../config/scanConfig.js';
import type { ExposureFinding, UsageAudit } from '../recon/types.js';
import type { ExposedModel, ExposureOccurrence } from '../watch/exposure.js';
import type { Tier } from '../report/tiers.js';
import { daysUntil } from '../watch/exposure.js';

/** The only two decisions this build can honestly emit (no auto-change exists). */
export type AuditDecision = 'review_required' | 'monitor';

/** What ROLE a located occurrence plays. A candidate is never a proven control. */
export type LocationRole =
  | 'runtime_selector_candidate' // config: model-like key = exact deprecated id
  | 'catalog_definition' // config: a model-definition catalog file
  | 'catalog_reference' // config: data reference
  | 'test_fixture' // config: serialized data in a test/fixture path
  | 'code_call_site' // code: a proven model argument (fix scanner Tier A / model_arg B)
  | 'code_candidate' // code: a model-like literal whose use is NOT proven (Tier B usage_unverified)
  | 'code_reference'; // code: data position (Tier C)

/** Which surface an occurrence was located on. */
export type LocationSurface = 'config' | 'code';

/** One located occurrence of the model id, with its (unproven-by-default) role. */
export interface LocationRef {
  file: string;
  line: number;
  column: number;
  key: string | null;
  value: string;
  role: LocationRole;
  surface: LocationSurface;
  /** 'A' | 'B' | 'C' — B for a config selector / code call site, C for data. */
  tier: Tier;
  /** Non-null when a config file belongs to a non-direct surface (Bedrock/Vertex/etc.). */
  providerSurface: string | null;
}

/** The retirement facts, straight from the deprecation registry. */
export interface RetirementEvidence {
  deprecated: boolean;
  status: string | null;
  shutdownDate: string | null;
  daysUntil: number | null;
  replacement: string | null;
  replacementVerdict: string | null;
  sourceUrl: string | null;
}

/** What the provider usage API observed for this model over the period. */
export interface RuntimeExposure {
  measured: boolean;
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
    /** Actionable — config selector candidates + code call sites/candidates. */
    selectors: LocationRef[];
    /** Informational — catalog definitions, references, data, fixtures. */
    catalog: LocationRef[];
  };
  /** Migration compatibility — not evaluated in this build (no sandbox verify yet). */
  compatibility: { checked: false; result: null };
  verification: {
    replacementVerdict: string | null;
    /** ALWAYS false: no CONFIG reader tie-back analysis exists yet (roadmap #5). */
    readerTieBackProven: false;
  };
  decision: AuditDecision;
  reason: string;
}

// --- coverage + conclusion (roadmap: no false "clean") ----------------------

/** What was analyzed on one surface, and how much. */
export interface SurfaceCoverage {
  analyzed: boolean;
  filesScanned: number;
  note?: string;
}

/** Which of the audit's surfaces were actually analyzed this run. */
export interface AuditCoverage {
  config: SurfaceCoverage;
  typescript: SurfaceCoverage;
  python: SurfaceCoverage;
  usage: { analyzed: boolean; provider: string | null; note?: string };
}

export type AuditConclusion = 'exposure_found' | 'clean' | 'inconclusive';

/**
 * The conclusion gate. A general CLEAN bill of health is only possible when BOTH
 * provider usage AND source code were actually analyzed (config is always
 * scanned). Absent either, zero findings is INCONCLUSIVE — never clean. This is
 * the "a clean conclusion is impossible when usage or source analysis was not
 * performed" rule, computed in one place so no renderer can route around it.
 */
export function concludeAudit(coverage: AuditCoverage, findingsCount: number): AuditConclusion {
  if (findingsCount > 0) return 'exposure_found';
  const sourceAnalyzed =
    (coverage.typescript.analyzed && coverage.typescript.filesScanned > 0) ||
    (coverage.python.analyzed && coverage.python.filesScanned > 0);
  return sourceAnalyzed && coverage.usage.analyzed ? 'clean' : 'inconclusive';
}

/** The surfaces that were NOT adequately analyzed — why a zero-finding run is inconclusive. */
export function coverageGaps(coverage: AuditCoverage): string[] {
  const gaps: string[] = [];
  if (!coverage.usage.analyzed) {
    gaps.push('provider usage/cost was not measured (add a provider + a read-only key)');
  }
  const tsOk = coverage.typescript.analyzed && coverage.typescript.filesScanned > 0;
  const pyOk = coverage.python.analyzed && coverage.python.filesScanned > 0;
  if (!tsOk && !pyOk) {
    if (!coverage.typescript.analyzed && !coverage.python.analyzed) {
      gaps.push('source code (TS/TSX/Python) was not scanned');
    } else {
      gaps.push('no TS/TSX or Python source was found to scan (other languages are not analyzed)');
    }
  }
  return gaps;
}

// --- the join ---------------------------------------------------------------

function toConfigLocation(m: ConfigMatch): LocationRef {
  const role: LocationRole =
    m.position === 'config_selector'
      ? 'runtime_selector_candidate'
      : m.purpose === 'catalog_definition'
        ? 'catalog_definition'
        : m.purpose === 'data_fixture'
          ? 'test_fixture'
          : 'catalog_reference';
  return {
    file: m.file,
    line: m.line,
    column: m.column,
    key: m.key,
    value: m.value,
    role,
    surface: 'config',
    tier: m.tier,
    providerSurface: m.providerSurface,
  };
}

/** A tier-B code occurrence is a PROVEN call site unless its reason says the use is unproven. */
function isProvenCallSite(o: ExposureOccurrence): boolean {
  if (o.tier === 'A') return true;
  if (o.tier !== 'B') return false;
  return o.reason !== 'usage_unverified' && o.reason !== 'dynamic_model_value';
}

function toSourceLocation(o: ExposureOccurrence, model: string): LocationRef {
  const role: LocationRole =
    o.tier === 'C' ? 'code_reference' : isProvenCallSite(o) ? 'code_call_site' : 'code_candidate';
  return {
    file: o.file,
    line: o.line,
    column: o.column,
    key: null,
    value: model,
    role,
    surface: 'code',
    tier: o.tier,
    providerSurface: null,
  };
}

/** Decide the outcome from the merged evidence. Actionable ⇒ review_required. */
function decide(inv: ModelInvestigation): { decision: AuditDecision; reason: string } {
  const sel = inv.locations.selectors;
  const hasCall = sel.some((s) => s.role === 'code_call_site');
  const hasCodeCandidate = sel.some((s) => s.role === 'code_candidate');
  const hasConfig = sel.some((s) => s.surface === 'config');
  const hasSelector = sel.length > 0;
  const hasUsage = inv.runtimeExposure.observed && inv.runtimeExposure.requests > 0;
  const hasCatalog = inv.locations.catalog.length > 0;

  if (hasSelector) {
    const parts: string[] = [];
    if (hasCall) parts.push('a code call site (the model id is a call argument)');
    if (hasCodeCandidate) parts.push('a code model literal (its use as a live call is not proven)');
    if (hasConfig) parts.push('a config selector candidate (reader tie-back not proven)');
    const usagePart = hasUsage ? ' Runtime usage is observed on this model.' : '';
    return {
      decision: 'review_required',
      reason: `Located at ${parts.join(' and ')}.${usagePart} Human review required before any change.`,
    };
  }
  if (hasUsage) {
    return {
      decision: 'review_required',
      reason:
        'Runtime usage observed, but no code or config location was found — the selector may live in a ' +
        'datastore, a feature flag, or a runtime this scan did not cover. Human review required to find it.',
    };
  }
  if (hasCatalog) {
    return {
      decision: 'monitor',
      reason:
        'Only catalog / reference / data occurrences found (no selector, no observed usage). Nothing is ' +
        'proven live to change — monitor.',
    };
  }
  return {
    decision: 'monitor',
    reason: inv.runtimeExposure.measured
      ? 'Listed as retiring in the registry, but no runtime usage and no code/config occurrence were found in this audit.'
      : 'Listed as retiring in the registry and located, but runtime usage was not measured (no provider key or --fixture).',
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
 * Join provider usage (MEASURE) with config + source-code locations (LOCATE) into
 * one investigation record per deprecated model.
 *
 * @param usage  the usage audit when a usable dataset was obtained, else null.
 * @param config the folded config exposures (always deprecated by construction).
 * @param now    the clock, passed in for a testable daysUntil fallback.
 * @param source the folded source-code exposures (TS/TSX/Python); [] when the
 *               source scan was skipped or the repo has no scannable source.
 */
export function buildInvestigations(
  usage: UsageAudit | null,
  config: readonly ConfigExposure[],
  now: Date,
  source: readonly ExposedModel[] = [],
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

  const fillRetirement = (
    inv: ModelInvestigation,
    r: { status?: string | null; shutdownDate?: string | null; replacement?: string | null; replacementVerdict?: string | null; sourceUrl?: string | null },
  ): void => {
    const e = inv.retirementEvidence;
    e.status = e.status ?? r.status ?? null;
    e.shutdownDate = e.shutdownDate ?? r.shutdownDate ?? null;
    e.replacement = e.replacement ?? r.replacement ?? null;
    e.replacementVerdict = e.replacementVerdict ?? r.replacementVerdict ?? null;
    e.sourceUrl = e.sourceUrl ?? r.sourceUrl ?? null;
    if (inv.verification.replacementVerdict === null) inv.verification.replacementVerdict = e.replacementVerdict;
  };

  // LOCATE (config) — config exposures carry the registry facts and the locations.
  for (const e of config) {
    const inv = seed(e.entryId, e.entryId, e.provider, e.model);
    fillRetirement(inv, e);
    inv.retirementEvidence.shutdownDate = e.shutdownDate ?? inv.retirementEvidence.shutdownDate;
    for (const m of e.selectors) inv.locations.selectors.push(toConfigLocation(m));
    for (const m of e.catalog) inv.locations.catalog.push(toConfigLocation(m));
  }

  // LOCATE (source code) — TS/TSX/Python occurrences classified by the fix scanner.
  for (const m of source) {
    const inv = seed(m.entryId, m.entryId, m.provider, m.id);
    fillRetirement(inv, m);
    for (const o of m.locations) {
      const loc = toSourceLocation(o, m.id);
      if (loc.role === 'code_reference') inv.locations.catalog.push(loc);
      else inv.locations.selectors.push(loc);
    }
  }

  // MEASURE — the deprecated subset of observed usage overlays richer lifecycle fields.
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
    inv.retirementEvidence.status = f.status ?? inv.retirementEvidence.status;
    inv.retirementEvidence.shutdownDate = f.shutdownDate ?? inv.retirementEvidence.shutdownDate;
    inv.retirementEvidence.daysUntil = f.daysUntil;
    inv.retirementEvidence.replacement = f.replacement ?? inv.retirementEvidence.replacement;
    inv.retirementEvidence.replacementVerdict = f.replacementVerdict ?? inv.retirementEvidence.replacementVerdict;
    inv.retirementEvidence.sourceUrl = f.sourceUrl ?? inv.retirementEvidence.sourceUrl;
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
