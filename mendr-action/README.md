# Mendr GitHub Action

Runs [Mendr](https://github.com/ajitheee/mendr) in your CI. When a provider retires an LLM model id your code still calls, or flips a coupled param on the newer models, Mendr applies the fix and opens one pull request for you to review.

The fix runs inside your own CI, gated on a type-check and your test suite. Mendr only commits a change it could verify. It never edits your default branch, and it never merges anything on its own.

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
      - uses: ajitheee/mendr/mendr-action@v1
```

That's the whole setup. It runs every Monday and whenever you trigger it by hand from the Actions tab.

## what it does on each run

1. Installs your repo's dependencies (auto-detected from your lockfile) so the test gate can actually run your tests.
2. Runs `mendr fix-llm . --write`, which applies only a fix it verified.
3. If a tracked file changed, it commits to a stable branch (`mendr/deprecated-model-ids`) and opens or updates a single PR. If nothing changed, it does nothing, and it closes a stale Mendr PR if one was open.

Re-running never stacks new PRs. It keeps the one branch current.

## inputs

| input | default | purpose |
| --- | --- | --- |
| `working-directory` | `.` | where your code lives, if not the repo root |
| `mendr-spec` | `mendr@^0.1` | the CLI version that runs in your CI |
| `install-command` | auto | override the dependency install step |
| `node-version` | `20` | Mendr needs Node 20 or newer |
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

No secrets, no org scopes. `npx mendr` pulls the public package, so it needs no auth.

Note: a PR opened by the default `GITHUB_TOKEN` doesn't retrigger your own `on: pull_request` workflows. That's fine here, since Mendr already ran the type-check and your tests as its gate. If you also want your normal PR CI to fire on Mendr's PR, pass a PAT or GitHub App token as `github-token`.

## limits

Mendr is TypeScript/TSX first. On a pure-JS repo it currently finds nothing to analyze and the run is a no-op. Coverage today is OpenAI, Anthropic, and Google model ids and their coupled params.

## license

MIT
