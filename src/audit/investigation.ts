// The canonical evidence record — ONE investigation per deprecated model, joining
// every surface mendr has, so `watch`, `fix-llm`, and `audit` cannot disagree: the
// source-code classification comes from the SAME scanner (scanForExposure ->
// classifyOccurrenceTier) that watch/fix-llm use.
//
//   Source scan         TS / TSX / Python literals -> tier A/B/C   [always]
//   Configuration scan  yaml/json/toml/env selectors vs catalog     [always]
//   Registry join       retirement evidence + successor verdict     [always]
//   Runtime evidence    otel | export | provider API | gateway logs [OPTIONAL]
//   Decision engine     patch | review | monitor
//
// ENTRY REQUIREMENT IS A REPOSITORY, NOT A KEY. The first four rows stand alone:
// they find the risk, the location, the deadline, and the migration evidence, and
// state plainly that production usage is unknown. Runtime evidence is the optional
// upgrade that turns "declared here" into "and it is live".
//
// HONESTY INVARIANTS baked in here, not left to the renderer:
//   * A CONFIG match is a "runtime selector candidate", never a proven control —
//     readerTieBackProven is ALWAYS false (no config data-flow analysis yet).
//   * A CODE match keeps the fix scanner's own verdict: a proven model argument
//     ("code call site") vs an unproven literal ("code candidate") vs data
//     ("code reference"). We never upgrade a candidate to a call site.
//   * Absence of runtime evidence is never read as "not live" — only as unknown.
//   * `patch` is emitted ONLY for a Tier-A code call site with a VERIFIED
//     successor. Config is never `patch`. A patch is a reviewed PR, never a merge.

import type { ConfigExposure, ConfigMatch } from '../config/scanConfig.js';
import type { ExposedModel, ExposureOccurrence } from '../watch/exposure.js';
import type { RuntimeEvidence, RuntimeSource } from '../runtime/evidence.js';
import type { LlmRegistry } from '../types.js';
import type { Tier } from '../report/tiers.js';
import { displayEntryId } from '../registry/entryId.js';
import { effectiveVerificationState, modelIdEntries } from '../usage/llmRegistry.js';
import { daysUntil } from '../watch/exposure.js';

/** The per-model decision. `patch` = a verified auto-fix exists for a code call site. */
export type AuditDecision = 'patch' | 'review' | 'monitor';

/** What ROLE a located occurrence plays. A candidate is never a proven control. */
export type LocationRole =
  | 'runtime_selector_candidate'
  | 'catalog_definition'
  | 'catalog_reference'
  | 'test_fixture'
  | 'code_call_site'
  | 'code_candidate'
  | 'code_reference';

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
  /**
   * Per LOCATION, not per investigation: true only for a Tier-A code line, the
   * only thing fix-llm will rewrite. A Tier-B line under a patch-eligible model
   * must never read as "will be fixed" (external validation, chatbot-ui).
   */
  patchEligible: boolean;
  /**
   * Per LOCATION: what this line asks of the reader. The model-level `decision`
   * is the strictest of its locations, so an informational catalog row under a
   * review model must not read as "review" itself (partner audits, 2026-09-04).
   */
  disposition: 'patch' | 'review' | 'informational';
}

/** The per-location disposition a tier implies. */
export function dispositionOf(tier: Tier): 'patch' | 'review' | 'informational' {
  return tier === 'A' ? 'patch' : tier === 'B' ? 'review' : 'informational';
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

/**
 * Whether this model is actually being called in production. `measured: false` is
 * the DEFAULT and is not a defect — it means the customer connected no runtime
 * source, so liveness is unknown (never "unused").
 */
export interface ProductionUsage {
  measured: boolean;
  source: RuntimeSource | null;
  observed: boolean;
  /** False when the source reports no request counts (e.g. Anthropic's usage API). */
  requestsReported: boolean;
  requests: number;
  failures: number;
  lastSeen: string | null;
  services: string[];
  environments: string[];
  /** Optional and secondary — mendr is not a cost dashboard. */
  costUsd: number | null;
}

/** One model's full investigation record — the join of every surface. */
export interface ModelInvestigation {
  entryId: string | null;
  provider: string;
  model: string;
  retirementEvidence: RetirementEvidence;
  productionUsage: ProductionUsage;
  locations: {
    selectors: LocationRef[];
    catalog: LocationRef[];
  };
  compatibility: { checked: false; result: null };
  verification: {
    replacementVerdict: string | null;
    /** ALWAYS false: no CONFIG reader tie-back analysis exists yet. */
    readerTieBackProven: false;
  };
  decision: AuditDecision;
  reason: string;
}

// --- coverage + conclusion --------------------------------------------------

export interface SurfaceCoverage {
  analyzed: boolean;
  filesScanned: number;
  /** Files actually READ (a collected-but-unreadable file proves nothing). */
  filesRead?: number;
  /** Files skipped because MENDR generated them (never re-ingested). */
  generatedSkipped?: number;
  /** Generated-artifact directories excluded from the scan, for disclosure. */
  excludedDirs?: string[];
  failed?: boolean;
  note?: string;
}

export interface SourceCoverage extends SurfaceCoverage {
  tsFiles: number;
  pyFiles: number;
  /**
   * Source languages PRESENT in the repo that mendr does not analyze. A repo that
   * is 1% TypeScript and 99% Go must not read as fully covered.
   */
  unanalyzedLanguages?: string[];
  /** Unanalyzed CODE files in total (JavaScript, Go, SQL, Svelte…) — the denominator honesty needs. */
  unanalyzedFiles?: number;
  /** Documentation files (Markdown etc.) not read. */
  docsFiles?: number;
  /** Test-support source files: present, counted, but their model ids are skipped by rule. */
  testFilesSkipped?: number;
}

/** Every surface the audit can cover, and whether it actually ran this time. */
export interface AuditCoverage {
  source: SourceCoverage;
  config: SurfaceCoverage;
  registry: { providers: string[] };
  /** OPTIONAL by design — an unconnected runtime is disclosed, not a failure. */
  runtime: {
    connected: boolean;
    source: RuntimeSource | null;
    failed?: boolean;
    note?: string;
    notes?: string[];
  };
  readerTieBack: { proven: false };
}

/** The only four verdicts an audit may reach. A general `clean` is not one. */
export type AuditConclusion =
  | 'exposure_detected'
  | 'no_exposure_in_completed_surfaces'
  | 'inconclusive'
  | 'audit_failed';

function anySurfaceFailed(c: AuditCoverage): boolean {
  return !!c.source.failed || !!c.config.failed || !!c.runtime.failed;
}

/**
 * The conclusion gate, computed in ONE place so no renderer can route around it.
 *
 *   exposure_detected                  — at least one deprecated model located/observed.
 *   audit_failed                       — a surface was attempted and threw.
 *   no_exposure_in_completed_surfaces  — 0 findings AND the source scan completed.
 *                                        Named for exactly what it claims; runtime
 *                                        being unconnected is disclosed in coverage,
 *                                        and does NOT downgrade this, because runtime
 *                                        is optional by design.
 *   inconclusive                       — 0 findings but the CORE surface (source) did
 *                                        not run or found nothing to scan, so silence
 *                                        proves nothing.
 *
 * A general "clean" is unreachable in every branch.
 */
/**
 * Is this model an actual DEPENDENCY EXPOSURE, or merely an informational
 * reference?
 *
 * A catalog record, a documentation sample, a test fixture, or a line in a
 * deprecation registry is NOT a dependency the application uses — calling it one
 * inflates the count and buries the findings that matter. Exposure requires a
 * selector (config or code) or observed production traffic.
 */
export function isExposure(inv: ModelInvestigation): boolean {
  return inv.decision === 'patch' || inv.decision === 'review';
}

/** Split investigations into real exposure and informational references. */
export function partitionFindings(investigations: readonly ModelInvestigation[]): {
  exposure: ModelInvestigation[];
  informational: ModelInvestigation[];
} {
  const exposure: ModelInvestigation[] = [];
  const informational: ModelInvestigation[] = [];
  for (const inv of investigations) (isExposure(inv) ? exposure : informational).push(inv);
  return { exposure, informational };
}

/**
 * @param exposureCount count of ACTUAL exposures — not the total investigation
 *        count. Informational catalog/fixture references must never produce an
 *        `exposure_detected` verdict.
 */
export function concludeAudit(coverage: AuditCoverage, exposureCount: number): AuditConclusion {
  if (exposureCount > 0) return 'exposure_detected';
  if (anySurfaceFailed(coverage)) return 'audit_failed';
  const analyzed = coverage.source.tsFiles + coverage.source.pyFiles;
  const sourceComplete = coverage.source.analyzed && analyzed > 0;
  // M8 (external validation): anything-llm — 22 of 1,242 source files analyzed —
  // read "no retiring AI dependencies in use". When the analyzed share is a small
  // minority of the repository's source, silence proves nothing; say so.
  return sourceComplete && !analyzedIsMinority(coverage) ? 'no_exposure_in_completed_surfaces' : 'inconclusive';
}

/** Fewer than a quarter of the repo's source files were in a language mendr reads. */
export function analyzedIsMinority(coverage: AuditCoverage): boolean {
  const analyzed = coverage.source.tsFiles + coverage.source.pyFiles;
  const other = coverage.source.unanalyzedFiles ?? 0;
  return analyzed > 0 && other > 0 && analyzed * 3 < other;
}

/** The limits on this run — what a zero-finding result does NOT prove. */
export function coverageGaps(coverage: AuditCoverage): string[] {
  const gaps: string[] = [];
  if (coverage.source.failed) gaps.push('source scan FAILED');
  else if (!coverage.source.analyzed) gaps.push('source code (TS/TSX/Python) was not scanned');
  else if (coverage.source.tsFiles + coverage.source.pyFiles === 0) {
    gaps.push('no TS/TSX or Python source was found to scan (other languages are not analyzed)');
  }
  // Present-but-unanalyzed languages are a real coverage hole even when TS/Python
  // were scanned: a repo that is 1% TypeScript is not a covered repo.
  const other = coverage.source.unanalyzedLanguages ?? [];
  if (other.length > 0) {
    const analyzed = coverage.source.tsFiles + coverage.source.pyFiles;
    const share = analyzedIsMinority(coverage)
      ? ` — only ${analyzed} of ${analyzed + (coverage.source.unanalyzedFiles ?? 0)} source files were in a language mendr reads; this result says nothing about the rest`
      : '';
    gaps.push(`these languages are present but NOT analyzed: ${other.join(', ')}${share}`);
  }
  if ((coverage.source.testFilesSkipped ?? 0) > 0) {
    gaps.push(
      `${coverage.source.testFilesSkipped} test/spec/fixture source files were counted but their model ids were not examined (test data is not a dependency)`,
    );
  }
  if (coverage.config.failed) gaps.push('config scan FAILED');
  else if (coverage.config.filesScanned > 0 && (coverage.config.filesRead ?? 0) === 0) {
    // Only a GAP when config files exist but could not be read. A repo with no
    // config files at all has nothing missing — that is "not applicable".
    gaps.push(`${coverage.config.filesScanned} configuration file(s) were found but NONE could be read`);
  }
  if (coverage.runtime.failed) gaps.push('the runtime evidence read FAILED');
  else if (!coverage.runtime.connected) {
    gaps.push('runtime measurement was not enabled — whether these models receive production traffic is unknown');
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
    file: m.file, line: m.line, column: m.column, key: m.key, value: m.value,
    role, surface: 'config', tier: m.tier, providerSurface: m.providerSurface, patchEligible: false,
    disposition: dispositionOf(m.tier),
  };
}

/**
 * Only a Tier-A occurrence is a VERIFIED call site. A Tier-B occurrence is real
 * but unverified — an unknown wrapper, a capped surface, an untraced default —
 * and calling it "verified" was the single most repeated overclaim in external
 * validation (9 of 12 repositories). The role is keyed on the tier, nothing else.
 */
function isProvenCallSite(o: ExposureOccurrence): boolean {
  return o.tier === 'A';
}

function toSourceLocation(o: ExposureOccurrence, model: string): LocationRef {
  const role: LocationRole =
    o.tier === 'C' ? 'code_reference' : isProvenCallSite(o) ? 'code_call_site' : 'code_candidate';
  return {
    file: o.file, line: o.line, column: o.column, key: null, value: model,
    role, surface: 'code', tier: o.tier, providerSurface: null, patchEligible: o.tier === 'A',
    disposition: dispositionOf(o.tier),
  };
}

/**
 * The registry record for an observed model, so runtime evidence alone can raise a
 * finding. Prefers the soonest-shutting entry, matching usageAudit's rule.
 */
function registryEntryFor(
  model: string,
  provider: string,
  registry: LlmRegistry,
): { entryId: string; provider: string; status: string | null; shutdownDate: string | null; replacement: string; replacementVerdict: string; sourceUrl: string | null } | null {
  const matches = modelIdEntries(registry).filter(
    (e) => e.deprecated === model && (e.provider === provider || provider === 'unknown'),
  );
  if (matches.length === 0) return null;
  const entry = [...matches].sort((a, b) => {
    if (a.shutdownDate && b.shutdownDate) return a.shutdownDate < b.shutdownDate ? -1 : 1;
    if (a.shutdownDate) return -1;
    if (b.shutdownDate) return 1;
    return 0;
  })[0];
  return {
    entryId: displayEntryId(entry),
    provider: entry.provider,
    status: entry.status ?? null,
    shutdownDate: entry.shutdownDate ?? null,
    replacement: entry.replacement,
    replacementVerdict: effectiveVerificationState(entry),
    sourceUrl: entry.sourceUrl ?? null,
  };
}

/** Decide the outcome from the merged evidence. */
function decide(inv: ModelInvestigation): { decision: AuditDecision; reason: string } {
  const sel = inv.locations.selectors;
  const hasCall = sel.some((s) => s.role === 'code_call_site');
  const hasCodeCandidate = sel.some((s) => s.role === 'code_candidate');
  const hasConfig = sel.some((s) => s.surface === 'config');
  const hasSelector = sel.length > 0;
  const u = inv.productionUsage;
  const live = u.observed;
  const hasCatalog = inv.locations.catalog.length > 0;

  const patchable =
    inv.retirementEvidence.replacementVerdict === 'verified' &&
    sel.some((s) => s.surface === 'code' && s.role === 'code_call_site' && s.tier === 'A');

  // How runtime evidence modifies the sentence — never asserting "unused".
  const runtimeClause = !u.measured
    ? ' Production usage was not measured.'
    : live
      ? ` Production traffic is OBSERVED${u.requestsReported && u.requests > 0 ? ` (${u.requests.toLocaleString('en-US')} requests)` : ''}.`
      : ' It was NOT observed in the connected runtime source (which covers only what that source records).';

  if (patchable) {
    const configNote = hasConfig ? ' Config occurrences remain review-only (reader tie-back not proven).' : '';
    // M6 (external validation): name the exact lines fix-llm would rewrite, and
    // say out loud that any other listed line is NOT part of the auto-fix. A
    // Tier-B line under a patch-eligible model was being read as "will be fixed".
    const eligible = sel.filter((s) => s.patchEligible).map((s) => `${s.file}:${s.line}`);
    const others = sel.filter((s) => !s.patchEligible).length;
    const othersNote = others > 0 ? ` ${others} other listed location(s) are not Tier A and will NOT be rewritten.` : '';
    return {
      decision: 'patch',
      reason:
        `A verified auto-fix exists for ${eligible.join(', ')} — fix-llm can rewrite ${eligible.length === 1 ? 'it' : 'them'} to ` +
        `${inv.retirementEvidence.replacement}.${othersNote} Nothing is applied by the audit; a change is proposed as a reviewed PR, never auto-merged.` +
        `${runtimeClause}${configNote}`,
    };
  }
  if (hasSelector) {
    const parts: string[] = [];
    if (hasCall) parts.push('a verified provider SDK call site');
    if (hasCodeCandidate) parts.push('a code default or call not traced to a provider request (its use as a live call is not proven)');
    if (hasConfig) parts.push('a config selector candidate (reader tie-back not proven)');
    return {
      decision: 'review',
      reason: `Located at ${parts.join(' and ')}.${runtimeClause} Human review required before any change.`,
    };
  }
  if (live) {
    return {
      decision: 'review',
      reason:
        'Production traffic is OBSERVED, but no code or config location was found — the selector may live ' +
        'in a datastore, a feature flag, or a runtime this scan did not cover. Human review required to find it.',
    };
  }
  if (hasCatalog) {
    return {
      decision: 'monitor',
      reason:
        'Only catalog / reference / data occurrences found (no selector).' + runtimeClause +
        ' Nothing is proven live to change — monitor.',
    };
  }
  return {
    decision: 'monitor',
    reason: `Listed as retiring in the registry, but no code or config occurrence was found.${runtimeClause}`,
  };
}

const DECISION_RANK: Record<AuditDecision, number> = { patch: 0, review: 1, monitor: 2 };

/** patch, then review, then monitor; within, observed-first, then volume, deadline, id. */
function compareInvestigation(a: ModelInvestigation, b: ModelInvestigation): number {
  if (DECISION_RANK[a.decision] !== DECISION_RANK[b.decision]) return DECISION_RANK[a.decision] - DECISION_RANK[b.decision];
  if (a.productionUsage.observed !== b.productionUsage.observed) return a.productionUsage.observed ? -1 : 1;
  if (a.productionUsage.requests !== b.productionUsage.requests) return b.productionUsage.requests - a.productionUsage.requests;
  const ad = a.retirementEvidence.daysUntil;
  const bd = b.retirementEvidence.daysUntil;
  if (ad !== null && bd !== null && ad !== bd) return ad - bd;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/**
 * Join located occurrences (source + config) with OPTIONAL runtime evidence into
 * one investigation record per deprecated model.
 *
 * @param runtime optional runtime evidence; pass NO_RUNTIME_EVIDENCE for the
 *               default GitHub-only audit (no key, no telemetry).
 */
export function buildInvestigations(
  runtime: RuntimeEvidence,
  config: readonly ConfigExposure[],
  now: Date,
  source: readonly ExposedModel[] = [],
  registry: LlmRegistry = [],
): ModelInvestigation[] {
  const measured = runtime.connected;
  const map = new Map<string, ModelInvestigation>();

  const seed = (key: string, entryId: string | null, provider: string, model: string): ModelInvestigation => {
    let inv = map.get(key);
    if (!inv) {
      inv = {
        entryId,
        provider,
        model,
        retirementEvidence: {
          deprecated: true, status: null, shutdownDate: null, daysUntil: null,
          replacement: null, replacementVerdict: null, sourceUrl: null,
        },
        productionUsage: {
          measured, source: runtime.source, observed: false, requestsReported: false,
          requests: 0, failures: 0, lastSeen: null, services: [], environments: [], costUsd: null,
        },
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

  // LOCATE (source code) — the SAME classifier watch/fix-llm use.
  for (const m of source) {
    const inv = seed(m.entryId, m.entryId, m.provider, m.id);
    fillRetirement(inv, m);
    for (const o of m.locations) {
      const loc = toSourceLocation(o, m.id);
      if (loc.role === 'code_reference') inv.locations.catalog.push(loc);
      else inv.locations.selectors.push(loc);
    }
  }

  // RUNTIME EVIDENCE (optional) — attach to models we already located, and seed
  // observed-but-UNLOCATED deprecated models too: traffic on a retiring model whose
  // selector we cannot find is the most urgent finding there is, not a silent drop.
  for (const obs of runtime.observations) {
    let match = [...map.values()].find(
      (inv) => inv.model === obs.model && (inv.provider === obs.provider || obs.provider === 'unknown'),
    );
    if (!match) {
      const entry = registryEntryFor(obs.model, obs.provider, registry);
      if (!entry) continue; // observed but not deprecated — not an exposure
      match = seed(entry.entryId, entry.entryId, entry.provider, obs.model);
      fillRetirement(match, entry);
    }
    const u = match.productionUsage;
    u.measured = true;
    u.source = runtime.source;
    u.observed = obs.requests > 0 || !obs.requestsReported;
    u.requestsReported = obs.requestsReported;
    u.requests += obs.requests;
    u.failures += obs.failures;
    if (obs.lastSeen && (!u.lastSeen || obs.lastSeen > u.lastSeen)) u.lastSeen = obs.lastSeen;
    if (obs.service && !u.services.includes(obs.service)) u.services.push(obs.service);
    if (obs.environment && !u.environments.includes(obs.environment)) u.environments.push(obs.environment);
    if (obs.costUsd !== null) u.costUsd = (u.costUsd ?? 0) + obs.costUsd;
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
