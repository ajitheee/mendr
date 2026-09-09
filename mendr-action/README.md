# Mendr GitHub Action

Runs [Mendr](https://github.com/ajitheee/mendr) in your CI. When a provider retires an LLM model id your code still calls, or flips a coupled param on the newer models, Mendr verifies the migration in an isolated sandbox and opens one pull request for you to review.

The whole thing runs inside your own CI. Mendr verifies the migration — a baseline-relative type-check and your build, plus your test suite (and an optional eval) — in a throwaway copy, and applies it to the PR branch ONLY when that verification passes. It never edits your default branch, and it never merges anything on its own. A human reviews and merges.

> Requires a Mendr build that includes the `migrate` command. Pin `mendr-spec` to a release tag that has it, or to a full commit SHA on `main`, until the next tagged release ships.

## quickstart

Add `.github/workflows/mendr.yml` to your repo:

```yaml
name: mendr
on:
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch: {}
jobs:
  llm-deprecations:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: ajitheee/mendr/mendr-action@v0.4.4-alpha
        with:
          # pin the CLI the action runs to the same release as the action itself
          mendr-spec: github:ajitheee/mendr#v0.4.4-alpha
```

That's the whole setup. It runs every Monday and whenever you trigger it by hand from the Actions tab.

Want the read-only version first? `npx github:ajitheee/mendr#v0.4.4-alpha audit . --install` scaffolds a workflow that keeps one tracking issue current and changes no code — `contents: read`, `issues: write`, nothing else. This action is the step after that: it opens the verified migration as a PR.

## approvals from your Mendr App

With `app-url` set and `approval-gated: 'true'`, a run does nothing until a
person has approved a migration on a finding in your Mendr App. Then it
migrates exactly those models, streams each step back to the finding (verifying
→ verified → applying → branch pushed → pull request open), opens the PR, and
enables GitHub's auto-merge only if the approval asked for it. A run with
nothing approved ends in seconds. The App generates this workflow for you —
hourly on a public repository, every three hours on a private one, plus
`workflow_dispatch` so the App can start it at once when it has been granted
`actions: write` (not code access). Everything still happens in your CI with
your token; the App only records the decision and what your CI reports.

## what it does on each run

1. Installs your repo's dependencies (auto-detected from your lockfile) so the build and test gates can actually run.
2. Runs `mendr migrate . --write`, which verifies the migration in a sandbox (type-check, your build, your test suite, an optional `eval-command`) and applies it to the working tree ONLY when the verdict is `verified`.
3. If a tracked file changed, it commits to a stable branch (`mendr/deprecated-model-ids`) and opens or updates a single PR whose body lists every swap and each gate's outcome. If there was nothing to migrate, it closes a stale Mendr PR if one was open. If a migration existed but did not verify, it applies nothing, opens no PR, and leaves any existing PR untouched (`outcome: not-verified`).

Re-running never stacks new PRs. It keeps the one branch current, and it never merges — a human approves.

## inputs

| input | default | purpose |
| --- | --- | --- |
| `working-directory` | `.` | where your code lives, if not the repo root |
| `mendr-spec` | `github:ajitheee/mendr#v0.4.4-alpha` | the CLI that runs in your CI (npm spec once published) |
| `app-url` | (empty) | your Mendr App URL; when set, the result — outcome, PR url, verdict, gate statuses, swaps and file paths, and the diff of the swap itself (see `send-diff`), **never whole files** — is reported there, proven by the run's OIDC token. Grant `id-token: write` in the job; without it nothing is sent and the job still succeeds |
| `send-diff` | `true` | include the unified diff of the model-id swap in the report, so the person who approved sees the change on the finding without opening GitHub (the App redacts secrets and caps it). `false` = everything except the diff |
| `approval-gated` | `false` | `true` = carry out only the migrations a person approved in your Mendr App (needs `app-url` and `id-token: write`): ask the App, claim them, migrate exactly those models (`mendr migrate --only`), stream each step back to the finding, and enable GitHub's auto-merge only when the approval asked for it. Nothing approved = nothing done, in seconds, before any dependency install |
| `approval` | (empty) | the approval id the App passed when it started the workflow (`workflow_dispatch`); informational — every queued approval is picked up regardless |
| `install-command` | auto | override the dependency install step |
| `node-version` | `22` | Mendr needs Node 22 or newer |
| `eval-command` | none | a command run in the sandbox as a behavioral gate (e.g. an eval suite); without it the PR says behavior is untested |
| `branch` | `mendr/deprecated-model-ids` | the branch Mendr owns |
| `base` | default branch | base branch for the PR |
| `pr-labels` | `dependencies,mendr,automated` | labels on the PR |
| `github-token` | `GITHUB_TOKEN` | token used to push and open the PR |

## permissions

The default `GITHUB_TOKEN` is enough. The job needs:

```yaml
permissions:
  contents: write
  pull-requests: write
```

No secrets, no org scopes. The CLI is pulled from the pinned public GitHub release, so it needs no auth.

Note: a PR opened by the default `GITHUB_TOKEN` doesn't retrigger your own `on: pull_request` workflows. That's fine here, since Mendr already ran the type-check, your build and your tests as its gate. If you also want your normal PR CI to fire on Mendr's PR, pass a PAT or GitHub App token as `github-token`.

## limits

Coverage is TypeScript, TSX and Python source plus supported config files, for OpenAI, Anthropic and Google model ids and their coupled params. On a repo with none of those it finds nothing to analyze and the run is a no-op; other languages are named in the report as not analyzed.

## license

MIT
