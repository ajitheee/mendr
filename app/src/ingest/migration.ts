import type { AuditReport } from './validate.js';

// Did the scanner see Mendr's migration workflow in the repository? The scanner
// runs INSIDE the repo's CI, so it can look at .github/workflows/ — the App,
// which holds no `contents` permission, cannot. It reports the answer in
// coverage.migration.workflowPresent; the run page uses it to offer the right
// "Prepare migration for review" step: add the workflow, or run it.
//
// null = the report predates the field (an older scanner): unknown, so the page
// offers both.

export function migrationWorkflowPresent(report: AuditReport): boolean | null {
  const cov = report.coverage;
  if (cov === null || typeof cov !== 'object' || Array.isArray(cov)) return null;
  const m = (cov as Record<string, unknown>).migration;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
  const v = (m as Record<string, unknown>).workflowPresent;
  return typeof v === 'boolean' ? v : null;
}
