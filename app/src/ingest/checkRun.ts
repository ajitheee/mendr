import { countDecisions, type AuditReport, type Investigation, type Location } from './validate.js';

// What the App writes back to the commit. A check run is the least invasive
// surface GitHub offers: it needs only `checks: write`, appears on the commit
// and any PR that carries it, and can annotate exact file:line pairs without
// the App ever reading the file. Conclusions keep the CLI's unequal weights:
//
//   PATCH ELIGIBLE (a proven Tier-A call site)  -> action_required
//   REVIEW REQUIRED only                        -> neutral
//   informational only / clean                  -> success
//   inconclusive or failed audit                -> neutral, saying so
//
// "action_required" never blocks a merge by itself; only a branch rule that
// requires this check would, and that choice stays with the repository.

export const CHECK_NAME = 'Mendr audit';
export const MAX_ANNOTATIONS = 50;

export type CheckConclusion = 'action_required' | 'neutral' | 'success';

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}

export interface CheckRunPayload {
  name: string;
  head_sha: string;
  status: 'completed';
  conclusion: CheckConclusion;
  details_url: string;
  external_id: string;
  output: {
    title: string;
    summary: string;
    text: string;
    annotations: Annotation[];
  };
}

const LABEL: Record<Investigation['decision'], string> = {
  patch: 'PATCH ELIGIBLE',
  review: 'REVIEW REQUIRED',
  monitor: 'informational',
};

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function retirement(inv: Investigation): string {
  const ev = inv.retirementEvidence;
  if (!ev) return '';
  const parts: string[] = [];
  if (ev.status) parts.push(ev.status);
  if (ev.shutdownDate) parts.push(`shutdown ${ev.shutdownDate}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function level(inv: Investigation, loc: Location): Annotation['annotation_level'] {
  if (loc.disposition === 'patch' || loc.patchEligible === true) return 'warning';
  return inv.decision === 'patch' ? 'warning' : 'notice';
}

export function conclusionFor(report: AuditReport): CheckConclusion {
  if (report.conclusion === 'audit_failed' || report.conclusion === 'inconclusive') return 'neutral';
  const c = countDecisions(report);
  if (c.patch > 0) return 'action_required';
  if (c.review > 0) return 'neutral';
  return 'success';
}

export function titleFor(report: AuditReport): string {
  if (report.conclusion === 'audit_failed') return 'Audit failed: a surface did not complete';
  const c = countDecisions(report);
  const base = `${c.patch} patch eligible · ${c.review} review required · ${c.informational} informational`;
  return report.conclusion === 'inconclusive' ? `Inconclusive · ${base}` : base;
}

export function buildCheckRun(report: AuditReport, opts: { sha: string; detailsUrl: string; externalId: string }): CheckRunPayload {
  const counts = countDecisions(report);
  const actionable = report.investigations.filter((i) => i.decision === 'patch' || i.decision === 'review');
  // Patch first, then review: never equal weight.
  actionable.sort((a, b) => (a.decision === b.decision ? 0 : a.decision === 'patch' ? -1 : 1));

  const summaryLines: string[] = [];
  switch (report.conclusion) {
    case 'exposure_detected':
      summaryLines.push('**Conclusion: exposure detected.** Retiring model references were found in this repository.');
      break;
    case 'no_exposure_in_completed_surfaces':
      summaryLines.push('**Conclusion: no exposure in completed surfaces.**');
      break;
    case 'inconclusive':
      summaryLines.push('**Conclusion: inconclusive.** Too little of the repository was analyzed to conclude anything; see coverage in the run.');
      break;
    case 'audit_failed':
      summaryLines.push('**Conclusion: audit failed.** A surface did not complete; the result must not be read as clean.');
      break;
  }
  summaryLines.push('');
  const shown = actionable.slice(0, 20);
  for (const inv of shown) {
    const next = inv.nextAction ? ` Next action: ${inv.nextAction}` : '';
    summaryLines.push(`- **${inv.model}** (${inv.provider}) — ${LABEL[inv.decision]}${retirement(inv)}.${next}`);
  }
  if (actionable.length > shown.length) summaryLines.push(`- … and ${actionable.length - shown.length} more in the run.`);
  if (counts.informational > 0) {
    summaryLines.push(`- ${counts.informational} informational reference${counts.informational === 1 ? '' : 's'} (catalog, docs, fixtures): no migration action required; monitor provider status.`);
  }

  const annotations: Annotation[] = [];
  let skipped = 0;
  for (const inv of actionable) {
    for (const loc of inv.locations.selectors) {
      if (annotations.length >= MAX_ANNOTATIONS) {
        skipped++;
        continue;
      }
      annotations.push({
        path: normalizePath(loc.file),
        start_line: loc.line,
        end_line: loc.line,
        annotation_level: level(inv, loc),
        title: `Mendr: ${inv.model} ${LABEL[inv.decision]}`,
        message: `${inv.model} (${inv.provider}): ${loc.reason ?? inv.reason ?? LABEL[inv.decision]}`,
      });
    }
  }

  const text = [
    'This check was written by the Mendr GitHub App from evidence your own workflow run sent: findings, paths, line numbers, classifications, redacted snippets of at most seven lines, and line hashes.',
    'The repository was scanned inside your CI. No code was cloned or stored by Mendr. Decisions stay with you: Mendr does not merge, and this check blocks nothing unless your branch rules require it.',
    skipped > 0 ? `${skipped} further location${skipped === 1 ? '' : 's'} exceeded the ${MAX_ANNOTATIONS}-annotation limit and are listed in the run.` : '',
    'Trust statement: https://github.com/ajitheee/mendr/blob/main/TRUST.md',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: CHECK_NAME,
    head_sha: opts.sha,
    status: 'completed',
    conclusion: conclusionFor(report),
    details_url: opts.detailsUrl,
    external_id: opts.externalId,
    output: { title: titleFor(report), summary: summaryLines.join('\n'), text, annotations },
  };
}
