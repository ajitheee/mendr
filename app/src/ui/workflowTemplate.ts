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
    '# SUPPLY CHAIN: pinned to a Mendr ref via the MENDR_SPEC repo variable (a tag, or a',
    '# 40-char commit SHA for the strictest pin). Never point it at a branch.',
    'name: mendr audit',
    '',
    'on:',
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
    '        run: |',
    '          npx --yes "github:ajitheee/mendr#$MENDR_SPEC" audit . \\',
    '            --sha "${{ github.event.pull_request.head.sha || github.sha }}" --json > mendr-audit.json',
    '          TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\',
    `            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${opts.audience}" | jq -r .value)`,
    '          curl -sS --fail-with-body -X POST "$MENDR_APP_URL/api/ingest" \\',
    '            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
    '            --data-binary @mendr-audit.json',
    '',
  ].join('\n');
}

/**
 * A deep link to GitHub's prefilled "create new file" editor for this workflow,
 * in the given repo and branch. The user lands on GitHub with the file path and
 * contents filled in and commits it themselves — the App writes nothing and
 * needs no extra scope.
 */
export function newWorkflowFileUrl(webUrl: string, repoFullName: string, branch: string, yaml: string): string {
  const base = webUrl.replace(/\/+$/, '');
  const b = encodeURIComponent(branch || 'main');
  const filename = encodeURIComponent(MENDR_AUDIT_WORKFLOW_PATH);
  const value = encodeURIComponent(yaml);
  return `${base}/${repoFullName}/new/${b}?filename=${filename}&value=${value}`;
}

/** Convenience: the one-click setup URL for a repo, from the App config + its default branch. */
export function setupWorkflowUrl(
  opts: WorkflowTemplateOptions & { webUrl: string; repoFullName: string },
): string {
  return newWorkflowFileUrl(opts.webUrl, opts.repoFullName, opts.defaultBranch, auditWorkflowYaml(opts));
}
