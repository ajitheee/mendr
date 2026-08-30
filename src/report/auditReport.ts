// Human render for the combined `audit` command (MEASURE + LOCATE in one record).
// The --json output is the ModelInvestigation[] itself, wrapped with meta.
//
// This renderer NEVER prints an instruction to change code. It prints the
// registry replacement as EVIDENCE (with its verdict), the located occurrences
// as CANDIDATES, and a decision that is `review_required` whenever anything is
// actionable — because the reader tie-back that would connect a config location
// to runtime selection does not exist yet.

import type { LocationRef, ModelInvestigation } from '../audit/investigation.js';

/** How usage was obtained — shapes what the runtime line is allowed to claim. */
export type UsageStatus = 'ok' | 'no_data' | 'not_measured' | 'error';

export interface AuditMeta {
  from: string | null;
  to: string | null;
  usageStatus: UsageStatus;
  providers: string[];
  /** Present only when usageStatus === 'ok'. */
  totalRequests: number | null;
  totalCostUsd: number | null;
  filesScanned: number;
}

const int = (n: number): string => n.toLocaleString('en-US');
const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function deadline(status: string | null, days: number | null, shutdownDate: string | null): string {
  const life = status ?? 'listed';
  let when: string;
  if (days === null) when = shutdownDate ? `shuts ${shutdownDate}` : 'no dated deadline';
  else if (days < 0) when = `${-days}d OVERDUE`;
  else if (days === 0) when = 'due TODAY';
  else when = `${days}d left`;
  const src = shutdownDate && days !== null ? ` (${shutdownDate})` : '';
  return `${life} — ${when}${src}`;
}

const roleLabel = (r: LocationRef['role']): string =>
  r === 'runtime_selector_candidate' ? 'runtime selector candidate'
    : r === 'catalog_definition' ? 'catalog definition'
      : r === 'test_fixture' ? 'test/data fixture (not a runtime selector)'
        : 'catalog reference';

function locationPhrase(loc: LocationRef): string {
  const surface = loc.providerSurface ? ` (surface: ${loc.providerSurface})` : '';
  return `${loc.file}:${loc.line} — ${roleLabel(loc.role)}${surface}`;
}

/** The one-line runtime-usage statement, honest to how usage was obtained. */
function runtimeLine(inv: ModelInvestigation, status: UsageStatus): string {
  if (inv.runtimeExposure.observed) {
    const cost = inv.runtimeExposure.costUsd > 0 ? `, ${usd(inv.runtimeExposure.costUsd)} observed cost` : ', cost not reported';
    return `Runtime usage: ${int(inv.runtimeExposure.requests)} requests${cost}`;
  }
  if (status === 'ok') return 'Runtime usage: not observed for this model in the audited period';
  if (status === 'no_data') return 'Runtime usage: inconclusive (the usage API returned no rows for this window)';
  if (status === 'error') return 'Runtime usage: not measured (the usage read failed)';
  return 'Runtime usage: not measured (pass a provider or --fixture to measure exposure)';
}

/** Render the combined audit for a terminal. */
export function renderAuditReport(investigations: readonly ModelInvestigation[], meta: AuditMeta): string[] {
  const lines: string[] = [];
  const period = meta.from && meta.to ? `${meta.from} to ${meta.to}` : 'config-only (no usage window)';
  lines.push(`mendr audit — ${period}`);

  const usageDesc =
    meta.usageStatus === 'ok'
      ? `usage: ${meta.providers.join(', ') || 'none'} — ${int(meta.totalRequests ?? 0)} requests, ${usd(meta.totalCostUsd ?? 0)}`
      : meta.usageStatus === 'no_data'
        ? `usage: ${meta.providers.join(', ') || 'provider'} — no rows for this window (inconclusive, NOT a clean result)`
        : meta.usageStatus === 'error'
          ? `usage: read failed — reporting config locations only`
          : 'usage: not measured (config-only)';
  lines.push(`${usageDesc}; config: ${int(meta.filesScanned)} file(s) scanned`);

  const review = investigations.filter((i) => i.decision === 'review_required').length;
  const monitor = investigations.length - review;
  lines.push(`${investigations.length} deprecated model(s): ${review} need review, ${monitor} monitor`);

  if (investigations.length === 0) {
    lines.push('');
    // Only claim the ground we actually covered — usage was not necessarily measured.
    const scope =
      meta.usageStatus === 'ok'
        ? 'usage or configuration'
        : meta.usageStatus === 'no_data'
          ? 'configuration (usage was inconclusive — no rows for this window)'
          : 'configuration (usage was not measured — add a provider or --fixture to also check runtime exposure)';
    lines.push(`No deprecated models found in ${scope} for this audit.`);
    return lines;
  }

  for (const inv of investigations) {
    const r = inv.retirementEvidence;
    lines.push('');
    lines.push(`Model: ${inv.model}  (${inv.provider})`);
    lines.push(`Retirement: ${deadline(r.status, r.daysUntil, r.shutdownDate)}${r.sourceUrl ? `  [source: ${r.sourceUrl}]` : ''}`);

    // Replacement is EVIDENCE, never an instruction. Label the verdict plainly.
    if (r.replacement) {
      const verdict = r.replacementVerdict ?? 'unstamped';
      const note =
        verdict === 'verified'
          ? 'evidence only — a change is not applied and not proven safe here'
          : `${verdict} — not a recommended swap`;
      lines.push(`Registry replacement: ${r.replacement} [registry: ${verdict}] (${note})`);
    }

    lines.push(runtimeLine(inv, meta.usageStatus));

    const locs = [...inv.locations.selectors, ...inv.locations.catalog];
    if (locs.length > 0) {
      const shown = locs.slice(0, 6).map(locationPhrase).join('; ');
      const more = locs.length > 6 ? `; … and ${locs.length - 6} more` : '';
      lines.push(`Candidate locations: ${shown}${more}`);
    } else {
      lines.push('Candidate locations: none located (selector may be in code, a datastore, or an unscanned runtime)');
    }

    lines.push(`Decision: ${inv.decision === 'review_required' ? 'REVIEW REQUIRED' : 'MONITOR'}`);
    lines.push(`Reason: ${inv.reason}`);
  }

  lines.push('');
  lines.push('mendr measures exposure and locates CANDIDATE selectors; it does not prove that a configuration');
  lines.push('location controls runtime selection (no reader tie-back yet), so every change stays under human');
  lines.push('review. Registry replacements are shown as evidence, never applied.');
  return lines;
}
