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
}

/**
 * The App-connected audit workflow: scan in the customer's CI, send only the
 * JSON here over an OIDC-proven request. Built line-by-line (not a template
 * literal) so GitHub `${{ … }}` expressions stay literal.
 */
export function auditWorkflowYaml(opts: WorkflowTemplateOptions): string {
  const branch = opts.defaultBranch || 'main';
  return [
    '# Mendr audit — sends this repository\'s retiring-AI-model findings to your Mendr App.',
    '#',
    '# The scan runs HERE, in your CI. Only the sanitized JSON (findings, paths, line',
    '# numbers, classifications, redacted snippets, hashes) is sent — never your code.',
    '# It is authenticated by THIS run\'s GitHub OIDC token, so there is no secret to store.',
    '#',
    '# It runs on every push and pull request AND once a day, so a newly announced',
    '# retirement is caught even when no code has changed. (GitHub pauses schedules on',
    '# a public repo with no activity for 60 days — re-enable it from the Actions tab.)',
    '#',
    '# NETWORK: besides fetching the pinned Mendr release (npx) and sending the JSON',
    '# to your App, the scan makes ONE outbound GET of public, signed registry files',
    '# from github.com (MENDR_REGISTRY_REFRESH) so it audits against current retirement',
    '# knowledge, not the knowledge of the day the release was cut. Nothing about this',
    '# repository is sent by that request. Remove the variable to stay fully offline —',
    '# a registry older than 14 days then makes a zero-finding result inconclusive.',
    '#',
    '# SUPPLY CHAIN: pinned to a Mendr ref via the MENDR_SPEC repo variable (a tag, or a',
    '# 40-char commit SHA for the strictest pin). Never point it at a branch.',
    'name: mendr audit',
    '',
    'on:',
    '  schedule:',
    "    - cron: '37 6 * * *' # daily, off-the-hour (GitHub throttles :00 crons)",
    '  push:',
    `    branches: [${branch}]`,
    '  pull_request: {}',
    '  workflow_dispatch: {}',
    '',
    '# Least privilege: read the code to scan it, and id-token to PROVE this run to',
    '# your Mendr App. No contents:write, no pull-requests:write, no secrets.',
    'permissions:',
    '  contents: read',
    '  id-token: write',
    '',
    'concurrency:',
    '  group: mendr-audit',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  audit:',
    '    runs-on: ubuntu-latest',
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
    '            TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\',
    `              "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${opts.audience}" | jq -r .value)`,
    '            curl -sS --fail-with-body -X POST "$MENDR_APP_URL/api/ingest" \\',
    '              -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
    '              --data-binary @mendr-audit.json',
    '          fi',
    '          exit $MENDR_STATUS',
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
// "Prepare migration for review" hands the customer a SECOND workflow, run by
// hand from the Actions tab: mendr-action verifies every patch-eligible swap in
// THEIR CI (a baseline-relative type-check and build, plus their tests) and
// opens ONE human-approved pull request only when it verifies. The App writes
// nothing and gains no permission — the branch push and the PR happen with the
// workflow's own token, exactly as the action's published example does.

export const MENDR_MIGRATE_WORKFLOW_PATH = '.github/workflows/mendr-migrate.yml';

export function migrateWorkflowYaml(opts: { mendrSpec: string }): string {
  const spec = opts.mendrSpec;
  return [
    '# Mendr migration — prepares a human-approved pull request for the retiring AI',
    '# model ids this repository calls. Run it from the Actions tab ("Run workflow")',
    '# after the Mendr audit shows a PATCH ELIGIBLE finding.',
    '#',
    '# Everything happens in THIS runner: `mendr migrate . --write` verifies each swap',
    '# on a throwaway copy — a baseline-relative type-check and build, plus YOUR test',
    '# suite — and applies it ONLY if the verdict is `verified`. Then it pushes ONE',
    '# stable branch (mendr/deprecated-model-ids) and opens or updates ONE pull',
    '# request. When verification fails nothing is applied and no PR is opened.',
    '# Mendr never merges and never touches your default branch. A human reviews.',
    '#',
    '# PERMISSIONS: contents:write to push that branch, pull-requests:write to open',
    '# the PR. Nothing else — no secrets, no provider key.',
    '#',
    '# SUPPLY CHAIN: both refs below pin the same Mendr release; bump them together',
    '# (a 40-char commit SHA is the strictest pin). Never point them at a branch.',
    'name: mendr migrate',
    '',
    'on:',
    '  workflow_dispatch: {}',
    '',
    'permissions:',
    '  contents: write',
    '  pull-requests: write',
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
    '          # eval-command: npm run eval   # optional: a behavioral gate, run in the sandbox',
    '',
  ].join('\n');
}

/** The one-click "add the migration workflow" link: GitHub's prefilled new-file editor. */
export function setupMigrateWorkflowUrl(opts: { webUrl: string; repoFullName: string; defaultBranch: string; mendrSpec: string }): string {
  return newWorkflowFileUrl(opts.webUrl, opts.repoFullName, opts.defaultBranch, migrateWorkflowYaml({ mendrSpec: opts.mendrSpec }), MENDR_MIGRATE_WORKFLOW_PATH);
}

/** The Actions page for the migration workflow — GitHub's own "Run workflow" button lives there. */
export function migrateActionsUrl(webUrl: string, fullName: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/actions/workflows/mendr-migrate.yml`;
}
