// Stable semantic identity for a finding, and a SURFACE-AWARE diff.
//
// A finding must survive an unrelated edit above it. Identifying one by
// `file:line` means every reformat "resolves" a real exposure and re-raises it as
// new — the issue churns, the history lies, and a reader stops trusting it.
//
// So identity is SEMANTIC: provider, normalized model, repo-relative path,
// symbol/config key, and evidence type. Line numbers are carried as MUTABLE
// DETAIL — displayed, never part of the identity.
//
// THE SECOND RULE, learned the hard way: a finding may only be called RESOLVED
// when the surface that would have found it actually ran. A failed source scan
// makes every code finding "disappear"; reporting those as resolved publishes a
// green tick over a live exposure and erases the baseline, so the next healthy
// run re-reports everything as new. Anything whose surface did not complete is
// CARRIED FORWARD, never resolved.

import { createHash } from 'node:crypto';
import type { AuditCoverage } from './investigation.js';
import type { LocationRef, ModelInvestigation } from './investigation.js';

/** The evidence class an occurrence represents — part of a finding's identity. */
export type EvidenceType = LocationRef['role'];

/** Which surface produced a finding — decides who may resolve it. */
export type FindingSurface = 'code' | 'config' | 'runtime';

/** One semantically-identified finding: a model, located somewhere, of some kind. */
export interface Finding {
  /** Stable id — changes only when the semantics change, never on a line move. */
  fingerprint: string;
  provider: string;
  model: string;
  path: string;
  key: string | null;
  evidenceType: EvidenceType;
  surface: FindingSurface;
  /** MUTABLE detail — never part of the fingerprint. */
  lines: number[];
  occurrences: number;
  /** Every tier present across the merged occurrences (a merge must not hide an A). */
  tiers: string[];
  /**
   * The tier of EACH line, so a merge can never let a lower-confidence sibling
   * ride along on a Tier-A one. A PR must be offered the Tier-A lines only.
   */
  tierByLine: Record<number, string>;
  decision: ModelInvestigation['decision'];
  entryId: string | null;
  shutdownDate: string | null;
  daysUntil: number | null;
  replacement: string | null;
  replacementVerdict: string | null;
  observed: boolean;
}

/** Normalize a path for identity: forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The identity string, before hashing. Readable on purpose. */
export function identityOf(parts: {
  provider: string;
  model: string;
  path: string;
  key: string | null;
  evidenceType: string;
}): string {
  return [
    parts.provider.toLowerCase(),
    parts.model,
    normalizePath(parts.path),
    parts.key ?? '-',
    parts.evidenceType,
  ].join('|');
}

/** A short, stable hash of the identity — what the state block stores. */
export function fingerprint(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** The synthetic path used for a model seen only in runtime evidence. */
export const RUNTIME_ONLY_PATH = '(runtime only)';

/** Collapse an investigation set into semantically-identified findings. */
export function toFindings(investigations: readonly ModelInvestigation[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const inv of investigations) {
    const locations = [...inv.locations.selectors, ...inv.locations.catalog];
    for (const loc of locations) {
      const identity = identityOf({
        provider: inv.provider,
        model: inv.model,
        path: loc.file,
        key: loc.key,
        evidenceType: loc.role,
      });
      const id = fingerprint(identity);
      const existing = byId.get(id);
      if (existing) {
        existing.occurrences += 1;
        if (!existing.lines.includes(loc.line)) existing.lines.push(loc.line);
        // A merge must never hide a Tier-A occurrence behind a B/C sibling, nor
        // let a B/C sibling inherit a Tier-A one's authority.
        if (!existing.tiers.includes(loc.tier)) existing.tiers.push(loc.tier);
        // Two occurrences can share a LINE. Keep the LEAST authoritative tier:
        // a line carrying an unresolved occurrence must never be auto-patched
        // because a confident sibling shares it. Deterministic, and fail-safe.
        const prior = existing.tierByLine[loc.line];
        existing.tierByLine[loc.line] = prior && prior > loc.tier ? prior : loc.tier;
        continue;
      }
      byId.set(id, {
        fingerprint: id,
        provider: inv.provider,
        model: inv.model,
        path: normalizePath(loc.file),
        key: loc.key,
        evidenceType: loc.role,
        surface: loc.surface,
        lines: [loc.line],
        occurrences: 1,
        tiers: [loc.tier],
        tierByLine: { [loc.line]: loc.tier },
        decision: inv.decision,
        entryId: inv.entryId,
        shutdownDate: inv.retirementEvidence.shutdownDate,
        daysUntil: inv.retirementEvidence.daysUntil,
        replacement: inv.retirementEvidence.replacement,
        replacementVerdict: inv.retirementEvidence.replacementVerdict,
        observed: inv.productionUsage.observed,
      });
    }
    // A model observed in production with NO located occurrence is still a finding
    // — the most urgent kind. It belongs to the RUNTIME surface, so only a run with
    // runtime evidence connected is allowed to resolve it.
    if (locations.length === 0 && inv.productionUsage.observed) {
      const identity = identityOf({
        provider: inv.provider,
        model: inv.model,
        path: RUNTIME_ONLY_PATH,
        key: null,
        evidenceType: 'code_call_site',
      });
      const id = fingerprint(identity);
      if (!byId.has(id)) {
        byId.set(id, {
          fingerprint: id,
          provider: inv.provider,
          model: inv.model,
          path: RUNTIME_ONLY_PATH,
          key: null,
          evidenceType: 'code_call_site',
          surface: 'runtime',
          lines: [],
          occurrences: 1,
          tiers: ['B'],
          tierByLine: {},
          decision: inv.decision,
          entryId: inv.entryId,
          shutdownDate: inv.retirementEvidence.shutdownDate,
          daysUntil: inv.retirementEvidence.daysUntil,
          replacement: inv.retirementEvidence.replacement,
          replacementVerdict: inv.retirementEvidence.replacementVerdict,
          observed: true,
        });
      }
    }
  }
  for (const f of byId.values()) {
    f.lines.sort((a, b) => a - b);
    f.tiers.sort();
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.observed) - Number(a.observed) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

// --- surface completion -----------------------------------------------------

/**
 * Did the surface that produces THIS kind of finding actually complete?
 *
 * Only a completed surface earns the right to resolve its own findings. Runtime
 * is optional for RAISING a finding but mandatory for RESOLVING a runtime-only
 * one — otherwise simply not connecting telemetry would "fix" observed traffic.
 */
export function surfaceCompleted(coverage: AuditCoverage, surface: FindingSurface): boolean {
  if (surface === 'code') {
    return coverage.source.analyzed && !coverage.source.failed && coverage.source.tsFiles + coverage.source.pyFiles > 0;
  }
  if (surface === 'config') {
    if (!coverage.config.analyzed || coverage.config.failed) return false;
    // NOT APPLICABLE vs INCOMPLETE. A repo with no supported config files has a
    // config surface that is trivially complete — there was nothing to read, and
    // blocking on it would leave such a repo permanently unresolvable. But config
    // files that EXIST and could not be read is a genuine gap.
    if (coverage.config.filesScanned === 0) return true;
    return (coverage.config.filesRead ?? coverage.config.filesScanned) > 0;
  }
  return coverage.runtime.connected && !coverage.runtime.failed;
}

/** May resolutions be trusted at all this run? (Every surface that could produce one ran.) */
export function resolutionsAreTrustworthy(coverage: AuditCoverage): boolean {
  return surfaceCompleted(coverage, 'code') && surfaceCompleted(coverage, 'config');
}

// --- the persisted baseline -------------------------------------------------

/**
 * What we remember about an open finding between runs. Richer than a bare id so a
 * MOVE can be told apart from a FIX, and so a carried-forward finding can still be
 * described when its surface did not run.
 */
export interface OpenFinding {
  fp: string;
  model: string;
  path: string;
  key: string | null;
  evidenceType: string;
  surface: FindingSurface;
}

export const toOpenFinding = (f: Finding): OpenFinding => ({
  fp: f.fingerprint,
  model: f.model,
  path: f.path,
  key: f.key,
  evidenceType: f.evidenceType,
  surface: f.surface,
});

/** What changed between the previous run and this one. */
export interface FindingDiff {
  fresh: Finding[];
  continuing: Finding[];
  /** Genuinely gone, and the surface that would have found them DID run. */
  resolved: OpenFinding[];
  /** Same finding at a new path — a move, not a fix. */
  moved: { from: OpenFinding; to: Finding }[];
  /** Could not be re-checked because their surface did not complete. NOT resolved. */
  carried: OpenFinding[];
}

/**
 * Diff current findings against the previous baseline, surface by surface.
 *
 * The critical rule: a vanished finding is only `resolved` when
 * {@link surfaceCompleted} says its own surface ran this time. Otherwise it is
 * `carried` — it stays open, stays in the baseline, and is reported as
 * un-recheckable rather than fixed.
 */
export function diffFindings(
  previous: readonly OpenFinding[],
  current: readonly Finding[],
  coverage: AuditCoverage,
): FindingDiff {
  const priorByFp = new Map(previous.map((p) => [p.fp, p]));
  const currentByFp = new Map(current.map((f) => [f.fingerprint, f]));

  const fresh: Finding[] = [];
  const continuing: Finding[] = [];
  for (const f of current) (priorByFp.has(f.fingerprint) ? continuing : fresh).push(f);

  const resolved: OpenFinding[] = [];
  const carried: OpenFinding[] = [];
  const moved: { from: OpenFinding; to: Finding }[] = [];

  // A "move" is the same (model, key, evidenceType) reappearing at a new path.
  const freshByShape = new Map<string, Finding>();
  for (const f of fresh) {
    freshByShape.set(`${f.model}|${f.key ?? '-'}|${f.evidenceType}`, f);
  }

  for (const p of previous) {
    if (currentByFp.has(p.fp)) continue;
    if (!surfaceCompleted(coverage, p.surface)) {
      carried.push(p);
      continue;
    }
    const relocated = freshByShape.get(`${p.model}|${p.key ?? '-'}|${p.evidenceType}`);
    if (relocated && relocated.path !== p.path) {
      moved.push({ from: p, to: relocated });
      continue;
    }
    resolved.push(p);
  }

  return { fresh, continuing, resolved, moved, carried };
}
