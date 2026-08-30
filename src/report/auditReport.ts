// Human render for the combined `audit` command (MEASURE + LOCATE in one record).
// The --json output is the ModelInvestigation[] plus meta/coverage/conclusion.
//
// This renderer NEVER prints an instruction to change code, and it prints a
// COVERAGE MATRIX on every run so the reader always sees what was (and was not)
// analyzed. A general "clean" conclusion is only reachable through concludeAudit,
// which requires that BOTH usage and source code were actually analyzed.

import {
  concludeAudit,
  coverageGaps,
  type AuditCoverage,
  type LocationRef,
  type ModelInvestigation,
} from '../audit/investigation.js';

/** How usage was obtained — shapes what the runtime line is allowed to claim. */
export type UsageStatus = 'ok' | 'no_data' | 'not_measured' | 'error';

export interface AuditMeta {
  from: string | null;
  to: string | null;
  usageStatus: UsageStatus;
  providers: string[];
  totalRequests: number | null;
  totalCostUsd: number | null;
  /** What each surface actually covered this run — drives the matrix + conclusion. */
  coverage: AuditCoverage;
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
  r === 'runtime_selector_candidate' ? 'config runtime selector candidate'
    : r === 'catalog_definition' ? 'config catalog definition'
      : r === 'test_fixture' ? 'config test/data fixture (not a selector)'
        : r === 'code_call_site' ? 'code call site (model argument)'
          : r === 'code_candidate' ? 'code model literal (use not proven)'
            : r === 'code_reference' ? 'code data reference'
              : 'config catalog reference';

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
  return 'Runtime usage: not measured (add a provider or --fixture to measure exposure)';
}

const pad = (s: string, n = 30): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** The coverage matrix — printed on EVERY run so the boundary is always visible. */
function coverageMatrix(meta: AuditMeta): string[] {
  const c = meta.coverage;
  const surf = (label: string, s: { analyzed: boolean; filesScanned: number; note?: string }): string => {
    const state = !s.analyzed ? 'NOT ANALYZED' : `scanned, ${int(s.filesScanned)} file(s)`;
    return `  ${pad(label)}${state}${s.note ? ` — ${s.note}` : ''}`;
  };
  const usageState =
    meta.usageStatus === 'ok'
      ? `measured (${c.usage.provider ?? (meta.providers.join(', ') || 'provider')}), ${int(meta.totalRequests ?? 0)} req, ${usd(meta.totalCostUsd ?? 0)}`
      : meta.usageStatus === 'no_data'
        ? 'INCONCLUSIVE — no rows for this window'
        : meta.usageStatus === 'error'
          ? 'NOT MEASURED — the usage read failed'
          : 'NOT MEASURED — add a provider + read-only key';
  return [
    'Coverage — what this audit analyzed:',
    surf('Config (yaml/json/toml/env)', c.config),
    surf('TypeScript / TSX source', c.typescript),
    surf('Python source', c.python),
    `  ${pad('Provider usage & cost')}${usageState}`,
  ];
}

/** Render the combined audit for a terminal. */
export function renderAuditReport(investigations: readonly ModelInvestigation[], meta: AuditMeta): string[] {
  const lines: string[] = [];
  const period = meta.from && meta.to ? `${meta.from} to ${meta.to}` : 'no usage window';
  lines.push(`mendr audit (preview) — ${period}`);
  lines.push('');
  for (const line of coverageMatrix(meta)) lines.push(line);
  lines.push('');

  const review = investigations.filter((i) => i.decision === 'review_required').length;
  const monitor = investigations.length - review;
  const conclusion = concludeAudit(meta.coverage, investigations.length);
  lines.push(`${investigations.length} deprecated model(s): ${review} need review, ${monitor} monitor`);

  if (investigations.length === 0) {
    lines.push('');
    if (conclusion === 'clean') {
      lines.push('CLEAN — no deprecated model ids in config, source (TS/TSX/Python), or provider usage for this audit.');
    } else {
      lines.push('INCONCLUSIVE — this is NOT a clean bill of health. Zero findings here does not mean zero exposure.');
      for (const gap of coverageGaps(meta.coverage)) lines.push(`  • ${gap}`);
    }
    lines.push('');
    lines.push(footer());
    return lines;
  }

  for (const inv of investigations) {
    const r = inv.retirementEvidence;
    lines.push('');
    lines.push(`Model: ${inv.model}  (${inv.provider})`);
    lines.push(`Retirement: ${deadline(r.status, r.daysUntil, r.shutdownDate)}${r.sourceUrl ? `  [source: ${r.sourceUrl}]` : ''}`);

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
      lines.push(`Located: ${shown}${more}`);
    } else {
      lines.push('Located: nowhere in code or config (selector may be in a datastore, a flag, or an unscanned runtime)');
    }

    lines.push(`Decision: ${inv.decision === 'review_required' ? 'REVIEW REQUIRED' : 'MONITOR'}`);
    lines.push(`Reason: ${inv.reason}`);
  }

  // Even WITH findings, name what was not covered — the list is not exhaustive if a surface was skipped.
  const gaps = coverageGaps(meta.coverage);
  if (gaps.length > 0) {
    lines.push('');
    lines.push('Note — this list is NOT exhaustive; the following were not analyzed:');
    for (const gap of gaps) lines.push(`  • ${gap}`);
  }

  lines.push('');
  lines.push(footer());
  return lines;
}

function footer(): string {
  return (
    'mendr locates candidate selectors and code call sites and measures usage; it does not prove that a\n' +
    'config location controls runtime selection (no reader tie-back yet), so every change stays under human\n' +
    'review. Registry replacements are shown as evidence, never applied. This command is a preview.'
  );
}
