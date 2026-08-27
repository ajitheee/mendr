// Human render for the usage-recon audit (integration shape #5).
// The --json output is the UsageAudit object itself.

import type { CostRegression, ExposureFinding, UsageAudit } from '../recon/types.js';

const usd = (n: number): string => `$${n.toFixed(2)}`;
const int = (n: number): string => n.toLocaleString('en-US');

function deadline(f: ExposureFinding): string {
  if (f.daysUntil === null) return f.shutdownDate ? `shuts ${f.shutdownDate}` : 'no dated deadline';
  if (f.daysUntil < 0) return `${-f.daysUntil}d OVERDUE`;
  if (f.daysUntil === 0) return 'due TODAY';
  return `${f.daysUntil}d left`;
}

/** Render the audit for a terminal. Deprecated-first, dollar-denominated. */
export function renderUsageReport(audit: UsageAudit): string[] {
  const lines: string[] = [];
  const period = audit.periodStart && audit.periodEnd ? `${audit.periodStart} to ${audit.periodEnd}` : 'the audited period';
  lines.push(`AI dependency audit — ${period}`);
  lines.push(`providers: ${audit.providers.join(', ') || 'none'}`);
  lines.push(`total: ${int(audit.totalRequests)} requests, ${usd(audit.totalCostUsd)} across ${audit.models.length} model(s)`);
  lines.push('');

  if (audit.exposed.length === 0) {
    lines.push('No deprecated models in use. Nothing exposed.');
    return lines;
  }

  const nearest =
    audit.nearestDeadlineDays !== null ? `, nearest deadline ${audit.nearestDeadlineDays}d` : '';
  const overdue = audit.mostOverdueDays !== null ? `, most overdue ${audit.mostOverdueDays}d` : '';
  lines.push(
    `EXPOSURE: ${audit.exposed.length} deprecated model(s), ${int(audit.exposedRequests)} live requests, ${usd(audit.exposedCostUsd)} spend${nearest}${overdue}`,
  );
  lines.push('');
  for (const f of audit.exposed) {
    const cost = f.costUsd > 0 ? `, ${usd(f.costUsd)}` : '';
    const repl = f.replacement ? ` -> ${f.replacement} [registry: ${f.replacementVerdict}]` : '';
    lines.push(`  ${f.model}  (${f.provider}, ${int(f.requests)} req${cost}, ${deadline(f)})${repl}`);
  }
  lines.push('');
  lines.push('This audit MEASURES exposure (what runs, how much, what it costs) from the provider APIs —');
  lines.push('it does not locate the file/flag/row to change. Pair it with a config or repo scan to fix.');
  return lines;
}

/** Render cost regressions between two audits. */
export function renderCostRegressions(regressions: readonly CostRegression[]): string[] {
  if (regressions.length === 0) return ['No cost regressions between the two periods.'];
  const lines = ['Cost regressions (prior -> current):', ''];
  for (const r of regressions) {
    const label = r.kind === 'new_model' ? 'NEW' : 'UP';
    lines.push(`  [${label}] ${r.model} (${r.provider}): ${usd(r.priorCostUsd)} -> ${usd(r.currentCostUsd)}  (+${usd(r.deltaUsd)})`);
  }
  return lines;
}
