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
# SUPPLY CHAIN: pinned to the Mendr release tag ${AUDIT_MENDR_RELEASE}. A TAG IS
# MUTABLE — only a full commit SHA is truly immutable, so set the MENDR_SPEC repo
# variable to a 40-character SHA for the strictest posture. Never point it at a
# branch. For the same reason, consider pinning the actions below to full commit
# SHAs instead of the \`@v4\`/\`@v7\` major tags, which can be re-pointed upstream.
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
        with:
          # Do NOT leave a usable GITHUB_TOKEN in .git/config while third-party
          # npm code runs in this job.
          persist-credentials: false

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
            const STATE_MARK = '<!-- mendr-audit:state';
            const LABEL = 'mendr-audit';
            const TITLE = 'Mendr: retiring AI dependencies in this repository';
            const { owner, repo } = context.repo;
            // Identity must be conservative: an unrelated issue that merely QUOTES
            // the marker must not hijack the audit and get its body overwritten.
            // Require the hidden state block too, prefer the OLDEST match, and
            // never treat a pull request as the issue.
            const findByMarker = (list) => {
              const hits = list.filter(
                (i) => !i.pull_request && (i.body || '').includes(MARKER) &&
                       (i.body || '').includes(STATE_MARK),
              );
              const seeded = hits.length > 0
                ? hits
                : list.filter((i) => !i.pull_request && (i.body || '').includes(MARKER) && i.title === TITLE);
              if (seeded.length > 1) core.info('Multiple marker issues found; using the oldest (#' + seeded[0].number + ')');
              return seeded.sort((a, b) => a.number - b.number)[0];
            };
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
            const STATE_MARK = '<!-- mendr-audit:state';
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
            // Identity must be conservative: an unrelated issue that merely QUOTES
            // the marker must not hijack the audit and get its body overwritten.
            // Require the hidden state block too, prefer the OLDEST match, and
            // never treat a pull request as the issue.
            const findByMarker = (list) => {
              const hits = list.filter(
                (i) => !i.pull_request && (i.body || '').includes(MARKER) &&
                       (i.body || '').includes(STATE_MARK),
              );
              const seeded = hits.length > 0
                ? hits
                : list.filter((i) => !i.pull_request && (i.body || '').includes(MARKER) && i.title === TITLE);
              if (seeded.length > 1) core.info('Multiple marker issues found; using the oldest (#' + seeded[0].number + ')');
              return seeded.sort((a, b) => a.number - b.number)[0];
            };
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
              // Never open an issue with nothing to say: no findings AND nothing
              // was skipped or failed.
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

            // RESPECT A HUMAN CLOSE — in every branch. Mendr may only reopen an
            // issue MENDR closed (it carries the CLEAR marker). Someone who closed
            // this on purpose must not be fought by a daily reopen.
            const mendrClosed =
              issue.state === 'closed' && (issue.body || '').includes(CLEAR_MARKER);
            const mayBeOpen = issue.state === 'open' || mendrClosed;

            // Decide the target state once, then write once.
            let targetState = null;
            if (openCount > 0) targetState = mayBeOpen ? 'open' : null;
            else if (closable) targetState = 'closed';
            else targetState = mayBeOpen ? 'open' : null;

            const bodyUnchanged = (issue.body || '') === body;
            const stateUnchanged = targetState === null || targetState === issue.state;
            if (bodyUnchanged && stateUnchanged) {
              core.info('Mendr audit issue #' + issue.number + ' already current');
            } else {
              const params = { owner, repo, issue_number: issue.number, body };
              if (targetState !== null && targetState !== issue.state) params.state = targetState;
              await github.rest.issues.update(params);
              const verb =
                params.state === 'open' ? 'Reopened '
                  : params.state === 'closed' ? 'Resolved '
                    : 'Updated ';
              core.info(verb + 'Mendr audit issue #' + issue.number);
            }
            if (openCount === 0 && !closable) {
              core.info('Left open — a required surface did not complete this run.');
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
