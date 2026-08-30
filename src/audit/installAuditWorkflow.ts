import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// `mendr audit --install` scaffolds the GitHub Actions workflow that maintains
// ONE audit issue per repository — in the CUSTOMER'S OWN CI, never on Mendr
// infrastructure, and with no provider credential of any kind.
//
// The flow is deliberately three steps so the CLI never needs a GitHub token:
//   1. github-script FINDS the resident issue and writes its body to a temp file
//   2. `mendr audit` RENDERS the new body, diffing against that prior body
//   3. github-script UPSERTS (create / update / close / reopen)
//
// Least privilege: `contents: read` + `issues: write`. NOT contents:write, so the
// default branch cannot be modified; NOT pull-requests:write, because this
// workflow opens no PR (see the commented block for enabling that separately).

export const AUDIT_WORKFLOW_PATH = '.github/workflows/mendr-audit.yml';

/** The immutable Mendr release the generated workflow pins to by default. */
export const AUDIT_MENDR_RELEASE = 'v0.2.0-alpha';

export const AUDIT_WORKFLOW_YAML = `# Maintained by Mendr — the AI dependency audit.
# ONE issue per repository lists every retiring AI dependency, grouped into new,
# continuing and resolved, with the exact scanned commit and a coverage matrix.
# It is edited in place, never re-posted.
#
# Regenerate with: npx github:ajitheee/mendr audit . --install --force
#
# NO PROVIDER KEY IS REQUIRED. This workflow scans the repository only. To also
# prove which models are live, add an optional runtime source — see the commented
# step near the bottom.
#
# SUPPLY CHAIN: pinned to an immutable Mendr release (${AUDIT_MENDR_RELEASE}) —
# never a moving branch. Override MENDR_SPEC (repo variable) to another release
# tag or a full commit SHA. For the strictest posture, also pin the actions below
# to full commit SHAs instead of the \`@v4\`/\`@v7\` major tags.
name: mendr audit

on:
  schedule:
    - cron: '23 7 * * *' # daily, off-the-hour (GitHub throttles :00 crons)
  push:
    branches: [main, master]
  workflow_dispatch: {}

# LEAST PRIVILEGE. contents:read means the default branch cannot be modified.
# issues:write maintains the single audit issue. pull-requests:write is NOT
# granted here — this workflow opens no PR and merges nothing. Add it only if you
# enable verified migration PRs, which are a separate, gated workflow.
permissions:
  contents: read
  issues: write

# One run at a time, no cancellation: two concurrent runs can never race to open
# two issues.
concurrency:
  group: mendr-audit
  cancel-in-progress: false

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # pin to a commit SHA for strict supply-chain safety

      - uses: actions/setup-node@v4 # pin to a commit SHA for strict supply-chain safety
        with:
          node-version: '22' # >=22: a Mendr dep (web-tree-sitter) uses Set.prototype.union

      # 1. Find the resident issue and hand its body to the renderer, so the new
      #    body can report new / continuing / resolved against it.
      - name: Locate the Mendr audit issue
        id: locate
        uses: actions/github-script@v7
        env:
          MENDR_PRIOR: \${{ runner.temp }}/mendr-audit-prior.md
        with:
          script: |
            const fs = require('fs');
            const MARKER = '<!-- mendr-audit:v1 -->';
            const LABEL = 'mendr-audit';
            const { owner, repo } = context.repo;
            const findByMarker = (list) =>
              list.find((i) => !i.pull_request && (i.body || '').includes(MARKER));
            let issue = findByMarker(
              await github.paginate(github.rest.issues.listForRepo, {
                owner, repo, labels: LABEL, state: 'all', per_page: 100,
              }),
            );
            if (!issue) {
              issue = findByMarker(
                await github.paginate(github.rest.issues.listForRepo, {
                  owner, repo, state: 'all', per_page: 100,
                }),
              );
            }
            fs.writeFileSync(process.env.MENDR_PRIOR, issue ? (issue.body || '') : '', 'utf8');
            core.setOutput('number', issue ? String(issue.number) : '');
            core.setOutput('state', issue ? issue.state : '');
            core.info(issue ? 'Found Mendr audit issue #' + issue.number : 'No Mendr audit issue yet');

      # 2. Render the new body. Repository-only: no provider key, no network.
      - name: Run the audit
        env:
          MENDR_SPEC: \${{ vars.MENDR_SPEC || '${AUDIT_MENDR_RELEASE}' }}
        run: |
          npx --yes "github:ajitheee/mendr#$MENDR_SPEC" audit . \\
            --sha "$GITHUB_SHA" \\
            --previous-body "$RUNNER_TEMP/mendr-audit-prior.md" \\
            --issue-body "$RUNNER_TEMP/mendr-audit-issue.md" \\
            --json > "$RUNNER_TEMP/mendr-audit.json"

      # 3. Create / update / close / reopen the ONE issue.
      - name: Upsert the audit issue
        uses: actions/github-script@v7
        env:
          MENDR_JSON: \${{ runner.temp }}/mendr-audit.json
          MENDR_BODY: \${{ runner.temp }}/mendr-audit-issue.md
          MENDR_NUMBER: \${{ steps.locate.outputs.number }}
        with:
          script: |
            const fs = require('fs');
            const MARKER = '<!-- mendr-audit:v1 -->';
            const CLEAR_MARKER = '<!-- mendr-audit:clear -->';
            const LABEL = 'mendr-audit';
            const TITLE = 'Mendr: retiring AI dependencies in this repository';
            const meta = JSON.parse(fs.readFileSync(process.env.MENDR_JSON, 'utf8'));
            const body = fs.readFileSync(process.env.MENDR_BODY, 'utf8');
            const { owner, repo } = context.repo;

            // The renderer is the single authority on whether closing is allowed:
            // it is false whenever a required surface was skipped or failed, so a
            // broken scan can never close a live exposure.
            const openCount = meta.issue.openCount;
            const closable = meta.issue.closable === true;

            try {
              await github.rest.issues.getLabel({ owner, repo, name: LABEL });
            } catch (e) {
              if (e.status === 404) {
                await github.rest.issues.createLabel({
                  owner, repo, name: LABEL, color: '0e8a16',
                  description: 'Mendr — retiring AI dependencies',
                });
              } else { throw e; }
            }

            // Re-resolve by MARKER rather than trusting the earlier step's number:
            // a concurrent run may have created the issue in between.
            const findByMarker = (list) =>
              list.find((i) => !i.pull_request && (i.body || '').includes(MARKER));
            let issue = findByMarker(
              await github.paginate(github.rest.issues.listForRepo, {
                owner, repo, labels: LABEL, state: 'all', per_page: 100,
              }),
            );
            if (!issue) {
              issue = findByMarker(
                await github.paginate(github.rest.issues.listForRepo, {
                  owner, repo, state: 'all', per_page: 100,
                }),
              );
            }

            const hasLabel = (i) =>
              (i.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === LABEL);

            if (!issue) {
              // Never open an empty issue: nothing to report and nothing was skipped.
              if (openCount === 0 && closable) {
                core.info('No exposure and no issue — nothing to open.');
                return;
              }
              const created = await github.rest.issues.create({
                owner, repo, title: TITLE, body, labels: [LABEL],
              });
              core.info('Opened Mendr audit issue #' + created.data.number);
              return;
            }

            const mendrClosed =
              issue.state === 'closed' && (issue.body || '').includes(CLEAR_MARKER);

            if (openCount > 0) {
              // Reopen ONLY an issue Mendr itself closed. A human who closed a live
              // exposure issue on purpose is respected — update in place, never
              // fight them by reopening every run.
              const wantOpen = issue.state === 'open' || mendrClosed;
              const willReopen = wantOpen && issue.state === 'closed';
              if ((issue.body || '') === body && !willReopen) {
                core.info('Mendr audit issue #' + issue.number + ' already current');
              } else {
                const params = { owner, repo, issue_number: issue.number, body };
                if (wantOpen) params.state = 'open';
                await github.rest.issues.update(params);
                core.info((willReopen ? 'Reopened ' : 'Updated ') + 'issue #' + issue.number);
              }
            } else if (closable) {
              // Nothing open AND every required surface completed -> resolve.
              // The body still carries the full resolution history.
              const params = { owner, repo, issue_number: issue.number, body };
              if (issue.state === 'open') params.state = 'closed';
              await github.rest.issues.update(params);
              core.info('Resolved Mendr audit issue #' + issue.number);
            } else {
              // Zero findings but a surface did not complete: update and LEAVE OPEN.
              await github.rest.issues.update({
                owner, repo, issue_number: issue.number, body, state: 'open',
              });
              core.info('Issue #' + issue.number + ' kept open — a required surface did not complete');
            }

            if (!hasLabel(issue)) {
              try {
                await github.rest.issues.addLabels({
                  owner, repo, issue_number: issue.number, labels: [LABEL],
                });
              } catch (e) { core.info('Could not re-add label: ' + e.message); }
            }

# ---------------------------------------------------------------------------
# OPTIONAL: prove which models are actually live. No Admin key is required for
# options 1, 2 and 4 — the customer produces a sanitized file themselves.
#
#      - name: Run the audit with runtime evidence
#        run: |
#          npx --yes "github:ajitheee/mendr#$MENDR_SPEC" audit . \\
#            --runtime telemetry.json --runtime-source otel \\
#            --sha "$GITHUB_SHA" --issue-body "$RUNNER_TEMP/mendr-audit-issue.md" --json
#
# Option 3 uses YOUR OWN read-only provider key, stored in YOUR repository
# secrets — it never reaches Mendr:
#        env:
#          MENDR_PROVIDER_KEY: \${{ secrets.MENDR_PROVIDER_KEY }}
#
# OPTIONAL: verified migration PRs. Requires \`pull-requests: write\`, which is
# deliberately NOT granted above. Mendr opens a PR only for a verified Tier-A
# code call site, and never merges it.
# ---------------------------------------------------------------------------
`;

export interface InstallResult {
  path: string;
  written: boolean;
  reason?: string;
}

/** Write the workflow into the repo (refusing to clobber unless forced). */
export function installAuditWorkflow(repoPath: string, force = false): InstallResult {
  const path = join(repoPath, AUDIT_WORKFLOW_PATH);
  if (existsSync(path) && !force) {
    return { path, written: false, reason: 'already exists (use --force to overwrite)' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, AUDIT_WORKFLOW_YAML, 'utf8');
  return { path, written: true };
}
