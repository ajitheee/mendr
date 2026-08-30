// Stable semantic identity for a finding.
//
// A finding must survive an unrelated edit above it. Identifying one by
// `file:line` means every reformat "resolves" a real exposure and re-raises it as
// new — the issue churns, the history lies, and a reader stops trusting it.
//
// So identity is SEMANTIC: provider, normalized model, repo-relative path,
// symbol/config key, and evidence type. Line numbers are carried as MUTABLE
// DETAIL — displayed, never part of the identity.
//
// Consequence worth stating: two occurrences of the same model, in the same file,
// under the same key and evidence type collapse into ONE finding whose
// `occurrences` count moves. That is deliberate — "gpt-4 is called in
// src/ai/client.ts" is the fact a human acts on; which lines is detail.

import { createHash } from 'node:crypto';
import type { LocationRef, ModelInvestigation } from './investigation.js';

/** The evidence class an occurrence represents — part of a finding's identity. */
export type EvidenceType = LocationRef['role'];

/** One semantically-identified finding: a model, located somewhere, of some kind. */
export interface Finding {
  /** Stable id — changes only when the semantics change, never on a line move. */
  fingerprint: string;
  provider: string;
  /** Normalized model id (fine-tune prefix stripped). */
  model: string;
  /** Repository-relative path, forward-slashed. */
  path: string;
  /** The config key or symbol, when the surface has one; null for bare code literals. */
  key: string | null;
  evidenceType: EvidenceType;
  surface: LocationRef['surface'];
  /** MUTABLE detail — never part of the fingerprint. */
  lines: number[];
  occurrences: number;
  /** Carried for rendering; not identity. */
  decision: ModelInvestigation['decision'];
  entryId: string | null;
  shutdownDate: string | null;
  daysUntil: number | null;
  replacement: string | null;
  replacementVerdict: string | null;
  observed: boolean;
  tier: string;
}

/** Normalize a path for identity: forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The identity string, before hashing. Readable on purpose — it is what a human
 * compares when a fingerprint unexpectedly changes.
 */
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

/**
 * Collapse an investigation set into semantically-identified findings.
 * Occurrences sharing (provider, model, path, key, evidenceType) merge into one.
 */
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
        decision: inv.decision,
        entryId: inv.entryId,
        shutdownDate: inv.retirementEvidence.shutdownDate,
        daysUntil: inv.retirementEvidence.daysUntil,
        replacement: inv.retirementEvidence.replacement,
        replacementVerdict: inv.retirementEvidence.replacementVerdict,
        observed: inv.productionUsage.observed,
        tier: loc.tier,
      });
    }
    // A model observed in production with NO located occurrence is still a finding —
    // the most urgent kind. Identify it by the runtime surface.
    if (locations.length === 0 && inv.productionUsage.observed) {
      const identity = identityOf({
        provider: inv.provider,
        model: inv.model,
        path: '(runtime only)',
        key: null,
        evidenceType: 'code_call_site',
      });
      const id = fingerprint(identity);
      if (!byId.has(id)) {
        byId.set(id, {
          fingerprint: id,
          provider: inv.provider,
          model: inv.model,
          path: '(runtime only)',
          key: null,
          evidenceType: 'code_call_site',
          surface: 'code',
          lines: [],
          occurrences: 1,
          decision: inv.decision,
          entryId: inv.entryId,
          shutdownDate: inv.retirementEvidence.shutdownDate,
          daysUntil: inv.retirementEvidence.daysUntil,
          replacement: inv.retirementEvidence.replacement,
          replacementVerdict: inv.retirementEvidence.replacementVerdict,
          observed: true,
          tier: 'B',
        });
      }
    }
  }
  for (const f of byId.values()) f.lines.sort((a, b) => a - b);
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.observed) - Number(a.observed) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) ||
      (a.path < b.path ? -1 : 1),
  );
}

/** What changed between the previous run and this one. */
export interface FindingDiff {
  fresh: Finding[];
  continuing: Finding[];
  /** Fingerprints present last time and gone now (we keep the id, not the old detail). */
  resolved: string[];
}

/**
 * Diff current findings against the previous run's fingerprints.
 *
 * A fingerprint that vanished is `resolved` — but see the caller: a resolution is
 * only TRUSTWORTHY when the surface that would have found it actually ran. A
 * skipped source scan makes everything "disappear", which is why
 * `resolutionsAreTrustworthy` gates the close.
 */
export function diffFindings(previous: readonly string[], current: readonly Finding[]): FindingDiff {
  const prior = new Set(previous);
  const now = new Set(current.map((f) => f.fingerprint));
  return {
    fresh: current.filter((f) => !prior.has(f.fingerprint)),
    continuing: current.filter((f) => prior.has(f.fingerprint)),
    resolved: [...prior].filter((id) => !now.has(id)),
  };
}
