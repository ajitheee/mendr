// The one workflow file the App hands a customer to "connect" a repository.
//
// We never write it for them (the App holds `checks: write` only, and the whole
// trust story is that nothing of theirs leaves their infrastructure). Instead we
// generate a SHORT caller file and a deep link to GitHub's OWN prefilled new-file
// editor, so one click opens the file, filled in, in the customer's repo — they
// read it and commit it themselves. The file's two jobs call Mendr's reusable
// workflows (.github/workflows/reusable-audit.yml and reusable-migrate.yml in the
// Mendr repository), pinned to a release tag: the scan and the migration still run
// in THEIR CI, and a version bump is one line.
//
// Why a caller and not the whole thing inline: GitHub's prefilled editor is a URL,
// and a URL over ~8 KB is refused ("Your request URL is too long"). The full
// two-job workflow was 9.6 KB encoded; this caller is under 4 KB.

export const MENDR_AUDIT_WORKFLOW_PATH = '.github/workflows/mendr-audit.yml';
export const MENDR_MIGRATE_WORKFLOW_PATH = '.github/workflows/mendr-migrate.yml';

/** Where the reusable workflows live, relative to a release ref. */
export const REUSABLE_AUDIT = 'ajitheee/mendr/.github/workflows/reusable-audit.yml';
export const REUSABLE_MIGRATE = 'ajitheee/mendr/.github/workflows/reusable-migrate.yml';

export interface WorkflowTemplateOptions {
  /** Public URL of this App deployment (the ingest target). */
  appUrl: string;
  /** OIDC audience the workflow requests; the App verifies it. */
  audience: string;
  /** The Mendr release ref the workflow pins to (a tag or a 40-char commit SHA). */
  mendrSpec: string;
  /** The repo's default branch, so the push trigger matches. */
  defaultBranch: string;
  /** A private repository checks for approvals less often — every check costs Actions minutes there. */
  private?: boolean;
}

/** The approvals-check schedule: hourly where minutes are free, every three hours where they are not. */
export function approvalsCron(isPrivate: boolean | undefined): string {
  return isPrivate ? '17 */3 * * *' : '17 * * * *';
}

const DAILY_AUDIT_CRON = '37 6 * * *';

/**
 * The one file: two jobs, each calling a reusable workflow at the same pinned
 * release. Built line-by-line (not a template literal) so GitHub `${{ … }}`
 * expressions stay literal.
 */
export function auditWorkflowYaml(opts: WorkflowTemplateOptions): string {
  const branch = opts.defaultBranch || 'main';
  const cron = approvalsCron(opts.private);
  const spec = opts.mendrSpec;
  return [
    "# Mendr — keeps this repository's retiring-AI-model findings current in your Mendr",
    '# App and carries out the migrations you approve there. Both jobs run HERE, in your',
    '# CI: the audit sends only sanitized findings (paths, line numbers, redacted',
    "# snippets — never your code), proven by this run's OIDC token; the migration",
    '# verifies an approved swap on a throwaway copy, pushes one branch, opens one pull',
    '# request, and never merges. The daily audit catches a newly announced retirement',
    '# when no code has changed. What each job reads and sends, and the one extra GET',
    `# of signed registry files: https://github.com/ajitheee/mendr/blob/${spec}/TRUST.md`,
    '#',
    '# SUPPLY CHAIN: both `uses:` lines pin the same Mendr release; bump them together',
    '# (a 40-char commit SHA is the strictest pin). Never point them at a branch.',
    'name: mendr',
    '',
    'on:',
    '  schedule:',
    `    - cron: '${DAILY_AUDIT_CRON}' # daily audit, off-the-hour (GitHub throttles :00 crons)`,
    `    - cron: '${cron}' # carries out approvals made in the App${opts.private ? ' (every three hours on a private repo; hourly costs ~24 min/day)' : ' (hourly; free on a public repo)'}`,
    '  push:',
    `    branches: [${branch}]`,
    '  pull_request: {}',
    '  workflow_dispatch:',
    '    inputs:',
    '      approval:',
    "        description: 'Mendr approval id (the App sets this when it starts the migration)'",
    '        required: false',
    "        default: ''",
    '',
    'jobs:',
    '  audit:',
    '    # Every push, pull request, the daily schedule and a manual run — not the approvals check.',
    `    if: github.event_name != 'schedule' || github.event.schedule == '${DAILY_AUDIT_CRON}'`,
    '    permissions:',
    '      contents: read # read the code to scan it',
    '      id-token: write # prove this run to your App; no secret to store',
    `    uses: ${REUSABLE_AUDIT}@${spec}`,
    '    with:',
    `      app-url: ${opts.appUrl}`,
    `      audience: ${opts.audience}`,
    '',
    '  migrate:',
    '    # The approvals schedule, and whenever the App starts this workflow — never on a push or pull request.',
    `    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && github.event.schedule == '${cron}')`,
    '    permissions:',
    '      contents: write # push the one migration branch',
    '      pull-requests: write # open the one pull request',
    '      id-token: write',
    `    uses: ${REUSABLE_MIGRATE}@${spec}`,
    '    with:',
    `      app-url: ${opts.appUrl}`,
    '      approval: ${{ inputs.approval }}',
    '',
  ].join('\n');
}

/**
 * A deep link to GitHub's prefilled "create new file" editor for this workflow,
 * in the given repo and branch. The user lands on GitHub with the file path and
 * contents filled in and commits it themselves — the App writes nothing and
 * needs no extra scope.
 */
export function newWorkflowFileUrl(webUrl: string, repoFullName: string, branch: string, yaml: string, path: string = MENDR_AUDIT_WORKFLOW_PATH): string {
  const base = webUrl.replace(/\/+$/, '');
  const b = encodeURIComponent(branch || 'main');
  const filename = encodeURIComponent(path);
  const value = encodeURIComponent(yaml);
  return `${base}/${repoFullName}/new/${b}?filename=${filename}&value=${value}`;
}

/** Convenience: the one-click setup URL for a repo, from the App config + its default branch. */
export function setupWorkflowUrl(opts: WorkflowTemplateOptions & { webUrl: string; repoFullName: string }): string {
  return newWorkflowFileUrl(opts.webUrl, opts.repoFullName, opts.defaultBranch, auditWorkflowYaml(opts));
}

// --- the standalone migration workflow ------------------------------------------
//
// For a repository connected before the one-file setup existed (an audit-only
// mendr-audit.yml): a second, equally short file whose one job calls the reusable
// migration workflow. New connections do not need it.

export function migrateWorkflowYaml(opts: { mendrSpec: string; appUrl: string; private?: boolean }): string {
  const spec = opts.mendrSpec;
  const cron = approvalsCron(opts.private);
  return [
    '# Mendr migration — carries out the migrations you approve in your Mendr App.',
    '# It asks the App what a person approved, verifies each approved swap on a',
    '# throwaway copy HERE in your CI — type-check, build, your tests — applies it',
    '# ONLY if the verdict is `verified`, pushes ONE stable branch, opens or updates',
    '# ONE pull request and reports each step back to the finding. Nothing approved',
    '# = nothing done, in seconds. Mendr never touches your default branch and',
    '# never merges — a person reviews the pull request.',
    '#',
    '# It checks for approvals on a schedule and whenever the App starts it (that needs',
    "# the App's optional \"Actions: write\" permission; without it, the schedule alone",
    '# carries approvals out). PERMISSIONS: contents:write to push that branch,',
    '# pull-requests:write to open the PR, id-token:write to prove this run to the App.',
    '#',
    '# SUPPLY CHAIN: the `uses:` line pins a Mendr release (a 40-char commit SHA is the',
    '# strictest pin). Never point it at a branch.',
    'name: mendr migrate',
    '',
    'on:',
    '  schedule:',
    `    - cron: '${cron}' # ${opts.private ? 'every three hours on a private repo (hourly costs ~24 min/day)' : 'hourly; free on a public repo'}`,
    '  workflow_dispatch:',
    '    inputs:',
    '      approval:',
    "        description: 'Mendr approval id (the App sets this when it starts the migration)'",
    '        required: false',
    "        default: ''",
    '',
    'jobs:',
    '  migrate:',
    '    permissions:',
    '      contents: write',
    '      pull-requests: write',
    '      id-token: write',
    `    uses: ${REUSABLE_MIGRATE}@${spec}`,
    '    with:',
    `      app-url: ${opts.appUrl}`,
    '      approval: ${{ inputs.approval }}',
    '',
  ].join('\n');
}

/** The one-click "add the migration workflow" link: GitHub's prefilled new-file editor. */
export function setupMigrateWorkflowUrl(opts: { webUrl: string; repoFullName: string; defaultBranch: string; mendrSpec: string; appUrl: string; private?: boolean }): string {
  return newWorkflowFileUrl(
    opts.webUrl,
    opts.repoFullName,
    opts.defaultBranch,
    migrateWorkflowYaml({ mendrSpec: opts.mendrSpec, appUrl: opts.appUrl, private: opts.private }),
    MENDR_MIGRATE_WORKFLOW_PATH,
  );
}

/** The Actions page for the migration workflow — GitHub's own "Run workflow" button lives there. */
export function migrateActionsUrl(webUrl: string, fullName: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/actions/workflows/mendr-migrate.yml`;
}
