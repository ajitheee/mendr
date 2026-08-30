// The canonical evidence record (roadmap #3) — ONE investigation per deprecated
// model, joining every surface mendr has, so `watch`, `fix-llm`, and `audit`
// cannot disagree: the source-code classification comes from the SAME scanner
// (scanForExposure -> classifyOccurrenceTier) that watch/fix-llm use.
//
//   Source scan         TS / TSX / Python literals -> tier A/B/C
//   Configuration scan  yaml/json/toml/env selectors vs catalog/data
//   Usage measurement   provider requests + cost (MEASURE)
//   Registry join       retirement evidence + successor verdict
//   Decision engine     patch | review | monitor
//
// HONESTY INVARIANTS baked in here, not left to the renderer:
//   * A CONFIG match is a "runtime selector candidate", never a proven control —
//     readerTieBackProven is ALWAYS false (no config data-flow analysis yet).
//   * A CODE match keeps the fix scanner's own verdict: a proven model argument
//     ("code call site", Tier A/B) vs an unproven literal ("code candidate",
//     Tier-B usage_unverified) vs data ("code reference", Tier C). We never
//     upgrade a candidate to a call site.
//   * `patch` is emitted ONLY for a Tier-A code call site with a VERIFIED
//     replacement — the one case whose data flow the scanner actually proved.
//     Config is never `patch`. A `patch` is a reviewed PR, never an auto-merge.
//   * The registry replacement is EVIDENCE only; no decision instructs a swap.

import type { ConfigExposure, ConfigMatch } from '../config/scanConfig.js';
import type { ExposureFinding, UsageAudit } from '../recon/types.js';
import type { ExposedModel, ExposureOccurrence } from '../watch/exposure.js';
import type { Tier } from '../report/tiers.js';
import { daysUntil } from '../watch/exposure.js';

/** The per-model decision. `patch` = a verified auto-fix exists for a code call site. */
export type AuditDecision = 'patch' | 'review' | 'monitor';

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
  tier: Tier;
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

/** One model's full investigation record — the join of every surface. */
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

// --- coverage + conclusion (the "no false clean" gate) ----------------------

/** What was analyzed on one surface, and how much. */
export interface SurfaceCoverage {
  analyzed: boolean;
  filesScanned: number;
  /** True when the surface was attempted but threw — distinct from skipped. */
  failed?: boolean;
  note?: string;
}

/** Source is one surface in the report, but two scanners underneath. */
export interface SourceCoverage extends SurfaceCoverage {
  tsFiles: number;
  pyFiles: number;
}

/** Every surface the audit can cover, and whether it actually ran this time. */
export interface AuditCoverage {
  source: SourceCoverage;
  config: SurfaceCoverage;
  registry: { providers: string[] };
  usage: {
    analyzed: boolean;
    provider: string | null;
    failed?: boolean;
    note?: string;
    /** What the provider read does NOT cover (unqueried categories, missing fields). */
    notes?: string[];
  };
  /** Structurally always unproven — surfaced so the reader never assumes it. */
  readerTieBack: { proven: false };
}

/** The only four verdicts an audit may reach. `clean` is deliberately NOT one. */
export type AuditConclusion =
  | 'exposure_detected'
  | 'no_exposure_in_completed_surfaces'
  | 'inconclusive'
  | 'audit_failed';

function anySurfaceFailed(c: AuditCoverage): boolean {
  return !!c.source.failed || !!c.config.failed || !!c.usage.failed;
}

/**
 * The conclusion gate, computed in ONE place so no renderer can route around it.
 *   * exposure_detected — at least one deprecated model was located/observed.
 *   * audit_failed — a surface was attempted and threw; results are unreliable.
 *   * no_exposure_in_completed_surfaces — 0 findings AND both skippable surfaces
 *     (source + usage) actually completed. Named for exactly what it claims — no
 *     exposure in the surfaces that finished — never a general "clean".
 *   * inconclusive — 0 findings but source or usage was skipped/empty, so silence
 *     proves nothing.
 * A general `clean` is unreachable when a surface was skipped or failed.
 */
export function concludeAudit(coverage: AuditCoverage, findingsCount: number): AuditConclusion {
  if (findingsCount > 0) return 'exposure_detected';
  if (anySurfaceFailed(coverage)) return 'audit_failed';
  const sourceComplete = coverage.source.analyzed && coverage.source.tsFiles + coverage.source.pyFiles > 0;
  const usageComplete = coverage.usage.analyzed;
  return sourceComplete && usageComplete ? 'no_exposure_in_completed_surfaces' : 'inconclusive';
}

/** The surfaces that were NOT completed — why a zero-finding run is inconclusive. */
export function coverageGaps(coverage: AuditCoverage): string[] {
  const gaps: string[] = [];
  if (coverage.usage.failed) gaps.push('provider usage read FAILED');
  else if (!coverage.usage.analyzed) gaps.push('provider usage/cost was not measured (add a provider + a read-only key)');
  if (coverage.source.failed) gaps.push('source scan FAILED');
  else if (!coverage.source.analyzed) gaps.push('source code (TS/TSX/Python) was not scanned');
  else if (coverage.source.tsFiles + coverage.source.pyFiles === 0) gaps.push('no TS/TSX or Python source was found to scan (other languages are not analyzed)');
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

/** Decide the outcome from the merged evidence. */
function decide(inv: ModelInvestigation): { decision: AuditDecision; reason: string } {
  const sel = inv.locations.selectors;
  const hasCall = sel.some((s) => s.role === 'code_call_site');
  const hasCodeCandidate = sel.some((s) => s.role === 'code_candidate');
  const hasConfig = sel.some((s) => s.surface === 'config');
  const hasSelector = sel.length > 0;
  const hasUsage = inv.runtimeExposure.observed && inv.runtimeExposure.requests > 0;
  const hasCatalog = inv.locations.catalog.length > 0;

  // PATCH: a proven code call site (Tier A) whose replacement is verified — the
  // one case whose data flow the scanner proved AND whose successor is verified.
  const patchable =
    inv.retirementEvidence.replacementVerdict === 'verified' &&
    sel.some((s) => s.surface === 'code' && s.role === 'code_call_site' && s.tier === 'A');

  if (patchable) {
    const configNote = hasConfig ? ' Config occurrences remain review-only (reader tie-back not proven).' : '';
    return {
      decision: 'patch',
      reason:
        `A verified auto-fix exists for the code call site(s) — fix-llm can migrate to ${inv.retirementEvidence.replacement} ` +
        `in place. It is proposed as a reviewed PR, never auto-merged.${configNote}`,
    };
  }
  if (hasSelector) {
    const parts: string[] = [];
    if (hasCall) parts.push('a code call site (the model id is a call argument)');
    if (hasCodeCandidate) parts.push('a code model literal (its use as a live call is not proven)');
    if (hasConfig) parts.push('a config selector candidate (reader tie-back not proven)');
    const usagePart = hasUsage ? ' Runtime usage is observed on this model.' : '';
    return {
      decision: 'review',
      reason: `Located at ${parts.join(' and ')}.${usagePart} Human review required before any change.`,
    };
  }
  if (hasUsage) {
    return {
      decision: 'review',
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

const DECISION_RANK: Record<AuditDecision, number> = { patch: 0, review: 1, monitor: 2 };

/** patch, then review, then monitor; within, by cost, requests, soonest deadline, id. */
function compareInvestigation(a: ModelInvestigation, b: ModelInvestigation): number {
  if (DECISION_RANK[a.decision] !== DECISION_RANK[b.decision]) return DECISION_RANK[a.decision] - DECISION_RANK[b.decision];
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

  // LOCATE (config)
  for (const e of config) {
    const inv = seed(e.entryId, e.entryId, e.provider, e.model);
    fillRetirement(inv, e);
    inv.retirementEvidence.shutdownDate = e.shutdownDate ?? inv.retirementEvidence.shutdownDate;
    for (const m of e.selectors) inv.locations.selectors.push(toConfigLocation(m));
    for (const m of e.catalog) inv.locations.catalog.push(toConfigLocation(m));
  }

  // LOCATE (source code) — SAME classifier watch/fix-llm use.
  for (const m of source) {
    const inv = seed(m.entryId, m.entryId, m.provider, m.id);
    fillRetirement(inv, m);
    for (const o of m.locations) {
      const loc = toSourceLocation(o, m.id);
      if (loc.role === 'code_reference') inv.locations.catalog.push(loc);
      else inv.locations.selectors.push(loc);
    }
  }

  // MEASURE
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
