import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// `mendr watch --install` scaffolds the GitHub Actions workflow that keeps the
// Standing Watch issue current — in the CUSTOMER'S OWN CI, never on Mendr
// infrastructure. The workflow computes exposure with the bundled registry and
// upserts one marker-identified issue via github-script. Least privilege: it
// asks for `issues: write` and `contents: read` and nothing else — it opens no
// pull request, runs no customer tests, and pushes no commit.

/** Repo-relative path of the scaffolded workflow. */
export const WATCH_WORKFLOW_PATH = '.github/workflows/mendr-watch.yml';

/**
 * The workflow file content. The install spec is overridable via the
 * `MENDR_SPEC` repo/workflow variable so a fork or a pinned tag can be used;
 * it defaults to the same `github:ajitheee/mendr` path the CLI ships with.
 */
export const WATCH_WORKFLOW_YAML = `# Maintained by Mendr — the Standing Watch.
# One self-updating issue lists the deprecated model ids your code touches,
# sorted by the nearest provider retirement date. It is edited in place, never
# re-posted. Runs on a daily schedule and on pushes to the default branch.
#
# Regenerate this file with: npx github:ajitheee/mendr watch . --install --force
#
# SUPPLY CHAIN: this workflow needs one PIN to be set before it runs — the
# MENDR_SPEC repository variable (see the Compute-exposure step). For the
# strictest posture, also pin the actions below to a full commit SHA instead of
# the \`@v4\`/\`@v7\` major tags (a major tag can be re-pointed upstream).
name: mendr watch

on:
  schedule:
    - cron: '17 8 * * *' # daily, off-the-hour (GitHub throttles :00 crons)
  push:
    branches: [main, master]
  workflow_dispatch: {}

# Least privilege: enough to read the repo and maintain ONE issue. NOT
# contents:write and NOT pull-requests:write — this workflow opens no PR, pushes
# no commit, and never modifies the default branch. PR-authoring is a separate,
# gated workflow.
permissions:
  contents: read
  issues: write

# One run at a time, no cancellation: two concurrent runs can never race to
# open two issues.
concurrency:
  group: mendr-watch
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # pin to a commit SHA for strict supply-chain safety

      - uses: actions/setup-node@v4 # pin to a commit SHA for strict supply-chain safety
        with:
          node-version: '20'

      - name: Compute exposure
        env:
          # PIN THIS. Set the MENDR_SPEC repository variable to a Mendr RELEASE
          # TAG or an exact COMMIT SHA (e.g. \`v0.1.0\` or a 40-char sha) — never a
          # branch. A branch (or \`main\`) is a MOVING reference: a future upstream
          # change would then run inside your CI without review. The step below
          # refuses to run until MENDR_SPEC is set, so Mendr is never unpinned.
          MENDR_SPEC: \${{ vars.MENDR_SPEC }}
        run: |
          if [ -z "$MENDR_SPEC" ]; then
            echo "::error::Mendr Watch is unpinned. Set the MENDR_SPEC repository variable to a Mendr release tag or commit SHA (never a branch), then re-run." >&2
            exit 1
          fi
          npx --yes "github:ajitheee/mendr#$MENDR_SPEC" watch . \\
            --issue-body "$RUNNER_TEMP/mendr-watch-issue.md" \\
            --no-exposure-file \\
            --json > "$RUNNER_TEMP/mendr-watch.json"

      - name: Upsert the watch issue
        uses: actions/github-script@v7
        env:
          MENDR_JSON: \${{ runner.temp }}/mendr-watch.json
          MENDR_BODY: \${{ runner.temp }}/mendr-watch-issue.md
        with:
          script: |
            const fs = require('fs');
            const MARKER = '<!-- mendr-watch:v1 -->';        // identifies THE issue
            const CLEAR_MARKER = '<!-- mendr-watch:clear -->'; // present only when Mendr wrote "all clear"
            const LABEL = 'mendr-watch';
            const TITLE = 'Mendr Watch: deprecated model ids in this repo';
            const meta = JSON.parse(fs.readFileSync(process.env.MENDR_JSON, 'utf8'));
            const body = fs.readFileSync(process.env.MENDR_BODY, 'utf8');
            const { owner, repo } = context.repo;

            // Ensure the label exists (idempotent) — it is cosmetic, NOT how the
            // issue is identified.
            try {
              await github.rest.issues.getLabel({ owner, repo, name: LABEL });
            } catch (e) {
              if (e.status === 404) {
                await github.rest.issues.createLabel({
                  owner, repo, name: LABEL, color: '5319e7',
                  description: 'Mendr Watch — deprecated model ids',
                });
              } else {
                throw e;
              }
            }

            // Identify THE resident issue by the hidden MARKER, never by the
            // label (a maintainer can remove the label; the marker is ours). Try
            // the cheap label-scoped list first, then fall back to a repo-wide
            // scan so a de-labeled issue is still found instead of duplicated.
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

            // The label the issue currently carries (objects or strings).
            const hasLabel = (i) =>
              (i.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === LABEL);

            if (meta.hasExposure) {
              if (issue) {
                // Reopen ONLY when the issue is closed because MENDR closed it
                // (all-clear, carries CLEAR_MARKER). A human who closed a live
                // exposure issue on purpose is respected — update in place, do
                // not fight them by reopening every run.
                const mendrClosed =
                  issue.state === 'closed' && (issue.body || '').includes(CLEAR_MARKER);
                const wantOpen = issue.state === 'open' || mendrClosed;
                const willReopen = wantOpen && issue.state === 'closed';
                const bodyUnchanged = (issue.body || '') === body;

                // Update ONLY when something actually changes — an identical body
                // with no state change is left untouched (no edit-history noise,
                // no wasted write).
                if (bodyUnchanged && !willReopen) {
                  core.info('Mendr Watch issue #' + issue.number + ' already current');
                } else {
                  const params = { owner, repo, issue_number: issue.number, body };
                  if (wantOpen) params.state = 'open';
                  await github.rest.issues.update(params);
                  core.info(
                    (willReopen ? 'Reopened ' : 'Updated ') + 'Mendr Watch issue #' + issue.number,
                  );
                }
                // Self-heal the label only if a maintainer removed it (idempotent).
                if (!hasLabel(issue)) {
                  try {
                    await github.rest.issues.addLabels({
                      owner, repo, issue_number: issue.number, labels: [LABEL],
                    });
                  } catch (e) {
                    core.info('Could not re-add label: ' + e.message);
                  }
                }
              } else {
                const created = await github.rest.issues.create({
                  owner, repo, title: TITLE, body, labels: [LABEL],
                });
                core.info('Opened Mendr Watch issue #' + created.data.number);
              }
            } else if (issue && issue.state === 'open') {
              await github.rest.issues.update({
                owner, repo, issue_number: issue.number, body, state: 'closed',
              });
              core.info('Closed Mendr Watch issue #' + issue.number + ' — exposure cleared');
            } else {
              core.info('No exposure and no open issue — nothing to do');
            }
`;

/** What `installWatchWorkflow` did with the file. */
export type InstallAction = 'created' | 'overwritten' | 'exists';

/** The result of a scaffold attempt. */
export interface InstallResult {
  path: string;
  action: InstallAction;
}

/**
 * Write the watch workflow under `repoPath`. Refuses to clobber an existing file
 * unless `force` — a customer may have edited theirs, and silently overwriting
 * it is exactly the kind of unrequested mutation Mendr does not do.
 */
export function installWatchWorkflow(repoPath: string, force = false): InstallResult {
  const path = join(repoPath, WATCH_WORKFLOW_PATH);
  const existed = existsSync(path);
  if (existed && !force) {
    return { path, action: 'exists' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, WATCH_WORKFLOW_YAML);
  return { path, action: existed ? 'overwritten' : 'created' };
}
