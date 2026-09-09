// The audit workflow the App hands a customer to "connect" a repository.
//
// We never write it for them (the App holds `checks: write` only, and the whole
// trust story is that nothing of theirs leaves their infrastructure). Instead we
// generate the YAML and a deep link to GitHub's OWN prefilled new-file editor,
// so one click opens the file, filled in, in the customer's repo — they read it
// and commit it themselves. The scan then runs in THEIR CI and posts only the
// sanitized JSON here, authenticated by the run's OIDC token.

export const MENDR_AUDIT_WORKFLOW_PATH = '.github/workflows/mendr-audit.yml';

export interface WorkflowTemplateOptions {
  /** Public URL of this App deployment (the ingest target). */
  appUrl: string;
  /** OIDC audience the workflow requests; the App verifies it. */
  audience: string;
  /** The Mendr CLI ref the workflow pins to (a tag or a 40-char commit SHA). */
  mendrSpec: string;
  /** The repo's default branch, so the push trigger matches. */
  defaultBranch: string;
  /** Private repos pay for Actions minutes, so their approvals check runs less often. */
  private?: boolean;
}

/** The approvals-check schedule: hourly where minutes are free, every three hours where they are not. */
export function approvalsCron(isPrivate: boolean | undefined): string {
  return isPrivate ? '17 */3 * * *' : '17 * * * *';
}

/**
 * The one file that connects a repository: two jobs. `audit` scans in the
 * customer's CI and sends only the JSON here over an OIDC-proven request;
 * `migrate` carries out the migrations a person approved in the App. Built
 * line-by-line (not a template literal) so GitHub `${{ … }}` expressions stay
 * literal.
 */
export function auditWorkflowYaml(opts: WorkflowTemplateOptions): string {
  const branch = opts.defaultBranch || 'main';
  const cron = approvalsCron(opts.private);
  return [
    '# Mendr — keeps this repository\'s retiring-AI-model findings current in your Mendr',
    '# App, and carries out the migrations you approve there. Two jobs, one file.',
    '#',
    '# AUDIT (every push, every pull request, daily, and on demand): the scan runs HERE,',
    '# in your CI. Only the sanitized JSON (findings, paths, line numbers,',
    '# classifications, redacted snippets, hashes) is sent — never your code. It is',
    '# authenticated by THIS run\'s GitHub OIDC token, so there is no secret to store.',
    '# The daily run catches a newly announced retirement when no code has changed.',
    '# (GitHub pauses schedules on a public repo with no activity for 60 days —',
    '# re-enable it from the Actions tab.)',
    '#',
    '# MIGRATE (on a schedule, and at once when the App starts it): asks the App what a',
    '# person approved on a finding, verifies each approved swap on a throwaway copy —',
    '# a baseline-relative type-check and build, plus YOUR test suite — applies it ONLY',
    '# if the verdict is `verified`, pushes ONE stable branch (mendr/deprecated-model-ids),',
    '# opens or updates ONE pull request, and reports each step back to the finding.',
    '# Nothing approved = nothing done, in seconds. Mendr never touches your default',
    '# branch; it enables GitHub\'s auto-merge only if you chose that when you approved.',
    '# Starting it at once needs the App\'s optional "Actions: write" permission;',
    '# without it, the schedule alone carries approvals out.',
    '#',
    '# NETWORK: besides fetching the pinned Mendr release (npx) and talking to your App,',
    '# the scan makes ONE outbound GET of public, signed registry files from github.com',
    '# (MENDR_REGISTRY_REFRESH) so it audits against current retirement knowledge, not',
    '# the knowledge of the day the release was cut. Nothing about this repository is',
    '# sent by that request. Remove the variable to stay fully offline — a registry',
    '# older than 14 days then makes a zero-finding result inconclusive.',
    '#',
    '# PERMISSIONS are per job: the audit reads the code and proves itself to the App',
    '# (contents:read, id-token:write); the migration also pushes its one branch and',
    '# opens its one PR (contents:write, pull-requests:write). No secrets.',
    '#',
    '# SUPPLY CHAIN: pinned to a Mendr ref via the MENDR_SPEC repo variable (a tag, or a',
    '# 40-char commit SHA for the strictest pin). Never point it at a branch.',
    'name: mendr',
    '',
    'on:',
    '  schedule:',
    "    - cron: '37 6 * * *' # daily audit, off-the-hour (GitHub throttles :00 crons)",
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
    "    if: github.event_name != 'schedule' || github.event.schedule == '37 6 * * *'",
    '    runs-on: ubuntu-latest',
    '    # Least privilege: read the code to scan it, and id-token to PROVE this run to',
    '    # your Mendr App. No contents:write, no pull-requests:write, no secrets.',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    concurrency:',
    '      group: mendr-audit-${{ github.ref }}',
    '      cancel-in-progress: false',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          persist-credentials: false',
    '',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: \'22\'',
    '',
    '      - name: Audit and send findings to Mendr',
    '        env:',
    `          MENDR_SPEC: \${{ vars.MENDR_SPEC || '${opts.mendrSpec}' }}`,
    `          MENDR_APP_URL: ${opts.appUrl}`,
    "          MENDR_REGISTRY_REFRESH: 'on' # one signed GET of public registry files; see NETWORK above",
    '        run: |',
    '          # Keep the audit\'s exit code (1 = scanner failure, 3 = inconclusive) so a',
    '          # broken or inconclusive scan still fails this step — but only AFTER the',
    '          # evidence has reached your App, so the dashboard shows this run as what',
    '          # it is instead of a stale "last good run".',
    '          set +e',
    '          npx --yes "github:ajitheee/mendr#$MENDR_SPEC" audit . \\',
    '            --sha "${{ github.event.pull_request.head.sha || github.sha }}" --json > mendr-audit.json',
    '          MENDR_STATUS=$?',
    '          set -e',
    '          if [ -s mendr-audit.json ]; then',
    '            # Retries cover a sleeping (free-tier) App waking up and network blips;',
    '            # the upload is idempotent per workflow run attempt, so a repeat is safe.',
    '            TOKEN=$(curl -sS --retry 3 --retry-delay 2 --retry-all-errors -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\',
    `              "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${opts.audience}" | jq -r .value)`,
    '            curl -sS --fail-with-body --retry 4 --retry-delay 5 --retry-all-errors --max-time 120 -X POST "$MENDR_APP_URL/api/ingest" \\',
    '              -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
    '              --data-binary @mendr-audit.json',
    '          fi',
    '          exit $MENDR_STATUS',
    '',
    '  migrate:',
    '    # The approvals schedule, and whenever the App starts this workflow — never on a push or pull request.',
    `    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && github.event.schedule == '${cron}')`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: write',
    '      pull-requests: write',
    '      id-token: write',
    '    concurrency:',
    '      group: mendr-migrate',
    '      cancel-in-progress: false',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '',
    `      - uses: ajitheee/mendr/mendr-action@${opts.mendrSpec}`,
    '        with:',
    `          mendr-spec: github:ajitheee/mendr#${opts.mendrSpec}`,
    `          app-url: ${opts.appUrl}`,
    "          approval-gated: 'true' # only what a person approved in the App; nothing approved = nothing done",
    '          approval: ${{ inputs.approval }}',
    '          # eval-command: npm run eval   # optional: a behavioral gate, run in the sandbox',
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
export function setupWorkflowUrl(
  opts: WorkflowTemplateOptions & { webUrl: string; repoFullName: string },
): string {
  return newWorkflowFileUrl(opts.webUrl, opts.repoFullName, opts.defaultBranch, auditWorkflowYaml(opts));
}

// --- the migration workflow ---------------------------------------------------
//
// The SECOND workflow a repository gets. It carries out the migrations a person
// approved in the App: every hour (and at once, when the App may start it) it
// asks the App what is approved, claims it, and runs mendr-action for exactly
// those models in THEIR CI — a baseline-relative type-check and build, plus
// their tests, on a throwaway copy — then pushes ONE branch and opens ONE pull
// request, streaming its progress back to the finding. When nothing is
// approved the run ends in seconds. The App writes nothing to the repository
// and gains no permission — the branch push and the PR happen with the
// workflow's own token, exactly as the action's published example does.

export const MENDR_MIGRATE_WORKFLOW_PATH = '.github/workflows/mendr-migrate.yml';

export function migrateWorkflowYaml(opts: { mendrSpec: string; appUrl: string; private?: boolean }): string {
  const spec = opts.mendrSpec;
  // A public repo's Actions minutes are free, so it checks hourly. A private
  // repo pays about a minute per check; every three hours keeps that modest,
  // and an approval made in the App still starts at once when Mendr may start it.
  const cron = approvalsCron(opts.private);
  return [
    '# Mendr migration — carries out the migrations you approve in your Mendr App.',
    '#',
    '# Approve a finding in the App and this workflow does the work, HERE, in your CI:',
    '# it asks the App what you approved, verifies each approved swap on a throwaway',
    '# copy — a baseline-relative type-check and build, plus YOUR test suite — applies',
    '# it ONLY if the verdict is `verified`, pushes ONE stable branch',
    '# (mendr/deprecated-model-ids) and opens or updates ONE pull request, reporting',
    '# each step back to the finding. When verification fails nothing is applied and',
    '# no PR is opened. Mendr never touches your default branch; it enables GitHub\'s',
    '# auto-merge only if you chose that when you approved.',
    '#',
    '# It checks for approvals on a schedule and whenever the App starts it (that needs',
    "# the App's optional \"Actions: write\" permission; without it, the schedule alone",
    '# picks approvals up). A check with nothing approved ends in seconds.',
    '#',
    '# PERMISSIONS: contents:write to push that branch, pull-requests:write to open',
    '# the PR, and id-token:write to PROVE this run to your Mendr App when it asks for',
    '# approvals and reports the result (outcome, PR url, verdict, gate statuses, the',
    '# swaps and the file paths they touch). No secrets, no provider key.',
    '#',
    '# SUPPLY CHAIN: both refs below pin the same Mendr release; bump them together',
    '# (a 40-char commit SHA is the strictest pin). Never point them at a branch.',
    'name: mendr migrate',
    '',
    'on:',
    '  schedule:',
    `    - cron: '${cron}' # carries out approvals made in the App${opts.private ? ' (every three hours on a private repo; hourly costs ~24 min/day)' : ' (hourly; free on a public repo)'}`,
    '  workflow_dispatch:',
    '    inputs:',
    '      approval:',
    "        description: 'Mendr approval id (the App sets this when it starts the workflow)'",
    '        required: false',
    "        default: ''",
    '',
    'permissions:',
    '  contents: write',
    '  pull-requests: write',
    '  id-token: write',
    '',
    'concurrency:',
    '  group: mendr-migrate',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  migrate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '',
    `      - uses: ajitheee/mendr/mendr-action@${spec}`,
    '        with:',
    `          mendr-spec: github:ajitheee/mendr#${spec}`,
    `          app-url: ${opts.appUrl}`,
    "          approval-gated: 'true' # only what a person approved in the App; nothing approved = nothing done",
    '          approval: ${{ inputs.approval }}',
    '          # eval-command: npm run eval   # optional: a behavioral gate, run in the sandbox',
    '',
  ].join('\n');
}

/** The one-click "add the migration workflow" link: GitHub's prefilled new-file editor. */
export function setupMigrateWorkflowUrl(opts: { webUrl: string; repoFullName: string; defaultBranch: string; mendrSpec: string; appUrl: string; private?: boolean }): string {
  return newWorkflowFileUrl(opts.webUrl, opts.repoFullName, opts.defaultBranch, migrateWorkflowYaml({ mendrSpec: opts.mendrSpec, appUrl: opts.appUrl, private: opts.private }), MENDR_MIGRATE_WORKFLOW_PATH);
}

/** The Actions page for the migration workflow — GitHub's own "Run workflow" button lives there. */
export function migrateActionsUrl(webUrl: string, fullName: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/actions/workflows/mendr-migrate.yml`;
}
