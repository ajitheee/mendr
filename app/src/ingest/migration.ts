import type { AuditReport } from './validate.js';

// Did the scanner see Mendr's migration workflow in the repository? The scanner
// runs INSIDE the repo's CI, so it can look at .github/workflows/ — the App,
// which holds no `contents` permission, cannot. It reports the answer in
// coverage.migration.workflowPresent; the run page uses it to offer the right
// "Prepare migration for review" step: add the workflow, or run it.
//
// null = the report predates the field (an older scanner): unknown, so the page
// offers both.

function migrationCoverage(report: AuditReport): Record<string, unknown> | null {
  const cov = report.coverage;
  if (cov === null || typeof cov !== 'object' || Array.isArray(cov)) return null;
  const m = (cov as Record<string, unknown>).migration;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  return m as Record<string, unknown>;
}

export function migrationWorkflowPresent(report: AuditReport): boolean | null {
  const v = migrationCoverage(report)?.workflowPresent;
  return typeof v === 'boolean' ? v : null;
}

/**
 * Which workflow file carries the migration job (`mendr-migrate.yml`, or the
 * one-click `mendr-audit.yml` with both jobs) — where the App sends a start
 * when a person approves. Null when the scanner did not say (older scanner,
 * or no workflow). Only a plain workflow file name is accepted.
 */
export function migrationWorkflowFile(report: AuditReport): string | null {
  const v = migrationCoverage(report)?.workflowFile;
  return typeof v === 'string' && /^[\w.-]{1,100}\.ya?ml$/.test(v) ? v : null;
}
