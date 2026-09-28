import { registryFreshnessLine, registryFreshnessOf } from './registry.js';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from `now` to a YYYY-MM-DD shutdown date, or null if unusable.
 *
 * COMPUTED HERE, NOT READ FROM THE REPORT. `retirementEvidence.daysUntil` is baked by the CLI
 * at SCAN time (src/audit/investigation.ts), so a check run written from a report that sat in
 * a queue — or re-rendered later — would count down from the wrong day. A countdown that is
 * silently wrong is worse than no countdown, because it is the one number a reader will act on.
 *
 * Both sides are floored to UTC midnight so the answer is a count of calendar days, not of
 * 24-hour periods: a shutdown "tomorrow" reads as 1 whether it is checked at 09:00 or 23:00.
 */
function daysToShutdown(shutdownDate: string | null | undefined, now: Date): number | null {
  if (!shutdownDate) return null;
  const at = Date.parse(`${shutdownDate}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return Math.round((at - today) / DAY_MS);
}

/** The soonest-dying actionable model, which is the one a reader needs to see first. */
function soonest(report: AuditReport, now: Date): { model: string; days: number } | null {
  let best: { model: string; days: number } | null = null;
  for (const inv of report.investigations) {
    if (inv.decision !== 'patch' && inv.decision !== 'review') continue;
    const days = daysToShutdown(inv.retirementEvidence?.shutdownDate, now);
    if (days === null) continue;
    if (!best || days < best.days) best = { model: inv.model, days };
  }
  return best;
}

/** The countdown, in the words a person would use. */
function deadlinePhrase(model: string, days: number): string {
  if (days < 0) return `${model} stopped serving ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return `${model} stops serving today`;
  if (days === 1) return `${model} stops serving tomorrow`;
  return `${model} stops serving in ${days} days`;
}

/**
 * LEAD WITH THE DEADLINE, not the tally.
 *
 * The title used to open with `1 patch eligible · 0 review required · 0 informational` — a
 * count of Mendr's own verdicts, which means nothing to someone who has not read the summary.
 * The fact that decides whether anyone acts is the date, so the date goes first and the tally
 * follows it.
 *
 * This is also the one place a competitor structurally cannot follow cheaply: Renovate has no
 * date concept anywhere in its config surface, and the trackers that do have lead times alert
 * by email and Slack — away from the code. This puts the countdown on the commit, in the check
 * the reviewer is already reading.
 */
export function titleFor(report: AuditReport, now: Date = new Date()): string {
  if (report.conclusion === 'audit_failed') return 'Audit failed: a surface did not complete';
  const c = countDecisions(report);
  const base = `${c.patch} patch eligible · ${c.review} review required · ${c.informational} informational`;
  const head = soonest(report, now);
  // No actionable finding with a known shutdown date means there is no deadline to lead with,
  // and inventing one would be the overclaim this product exists to avoid.
  const lead = head ? `${deadlinePhrase(head.model, head.days)} · ${c.patch} patch eligible` : base;
  return report.conclusion === 'inconclusive' ? `Inconclusive · ${lead}` : lead;
}

/**
 * The scanner speaks command-line; the check on the commit speaks App: the fix is approved
 * in Mendr, not run by hand.
 *
 * The id is captured lazily up to a period that ENDS THE SENTENCE — one followed by
 * whitespace or end of string. Model ids contain dots of their own (`gpt-5.6-sol`,
 * `gpt-4.1-nano`), and the previous `[^\s.]+` stopped at the first one, so a real check run
 * on mendr-demo read "migrate it to gpt-5 once you approve in your Mendr App.6-sol" — the
 * replacement landed inside the identifier.
 *
 * `(it|them)` is matched too: the source says "them" when several ids are eligible, and the
 * singular-only pattern left that branch untouched, publishing the internal tool name
 * `fix-llm` to anyone reading the check.
 */
function appWording(reason: string): string {
  return reason.replace(
    /fix-llm can rewrite (it|them) to (\S+?)\.(?=\s|$)/g,
    'Mendr can migrate $1 to $2 once you approve in your Mendr App.',
  );
}

export function buildCheckRun(
  report: AuditReport,
  opts: { sha: string; detailsUrl: string; externalId: string; now?: Date },
): CheckRunPayload {
  const counts = countDecisions(report);
  const actionable = report.investigations.filter((i) => i.decision === 'patch' || i.decision === 'review');
  // Patch first, then review: never equal weight.
  actionable.sort((a, b) => (a.decision === b.decision ? 0 : a.decision === 'patch' ? -1 : 1));

  const reg = registryFreshnessOf(report);
  const summaryLines: string[] = [];
  switch (report.conclusion) {
    case 'exposure_detected':
      summaryLines.push('**Conclusion: exposure detected.** Retiring model references were found in this repository.');
      break;
    case 'no_exposure_in_completed_surfaces':
      summaryLines.push('**Conclusion: no exposure in completed surfaces.**');
      break;
    case 'inconclusive':
      // Two different reasons read the same on the outside; name the real one.
      summaryLines.push(
        reg.freshness === 'stale'
          ? `**Conclusion: inconclusive.** The deprecation registry this scan used was not provably fresh (${registryFreshnessLine(reg)}), so a zero-finding result proves nothing about a retirement announced since.${reg.reason ? ` ${reg.reason}.` : ''}`
          : '**Conclusion: inconclusive.** Too little of the repository was analyzed to conclude anything; see coverage in the run.',
      );
      break;
    case 'audit_failed':
      summaryLines.push('**Conclusion: audit failed.** A surface did not complete; the result must not be read as clean.');
      break;
  }
  // Which knowledge the verdict rests on, and how current it was.
  if (reg.freshness !== 'unknown') summaryLines.push(`Registry: ${registryFreshnessLine(reg)}.`);
  summaryLines.push('');
  const shown = actionable.slice(0, 20);
  for (const inv of shown) {
    // App users act in Mendr, not on the command line: a patch-eligible finding
    // points at the run page where Approve lives; other decisions keep the CLI's wording.
    const next = inv.decision === 'patch' ? ` Next action: approve the migration in your Mendr App — ${opts.detailsUrl}` : inv.nextAction ? ` Next action: ${inv.nextAction}` : '';
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
        message: `${inv.model} (${inv.provider}): ${appWording(loc.reason ?? inv.reason ?? LABEL[inv.decision])}`,
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
    output: { title: titleFor(report, opts.now ?? new Date()), summary: summaryLines.join('\n'), text, annotations },
  };
}
