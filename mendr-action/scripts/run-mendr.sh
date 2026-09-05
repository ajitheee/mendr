#!/usr/bin/env bash
set -euo pipefail

# Runner for the Mendr migration-PR Action.
#
# The trust model is deliberately simple: Mendr's OWN sandbox verification
# decides. `mendr migrate . --write` verifies the migration in an isolated
# sandbox — a baseline-relative type-check and build, plus your test suite (and
# an optional eval) — and applies it to the working tree ONLY when the verdict
# is `verified`. Any other verdict (failed / inconclusive / nothing to migrate)
# writes nothing. So "did any tracked file change?" is an exact, honest signal
# for "was there a VERIFIED migration?". We never parse a diff to decide what to
# apply, we never open a PR for an unverified change, and we never touch the
# default branch or merge anything. A human reviews and merges.

REPORT="$(mktemp)"
ARTIFACT="mendr-migration.json"

# Human report (for the job summary) and the machine artifact (for the PR body
# and the apply gate) come from two runs of the same verified migration: the
# first prints the report, the second applies and emits JSON. Both verify; only
# the second writes. Capture exit status EXPLICITLY — a nonzero exit means Mendr
# never completed a scan (bad path/spec), which must NEVER be reported as clean.
set +e
npx --yes "$MENDR_SPEC" migrate . ${MENDR_EVAL:+--eval-command "$MENDR_EVAL"} >"$REPORT" 2>&1
REPORT_STATUS=$?
npx --yes "$MENDR_SPEC" migrate . --write --json ${MENDR_EVAL:+--eval-command "$MENDR_EVAL"} >"$ARTIFACT" 2>/dev/null
WRITE_STATUS=$?
set -e
cat "$REPORT"

{
  echo "### Mendr — migrate deprecated LLM model ids"
  echo
  echo '```'
  cat "$REPORT"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# Guard: Mendr must have completed AND produced a JSON artifact. Otherwise report
# an error, exit red, and do NOT touch any existing PR.
if [ "$REPORT_STATUS" -ne 0 ] || [ "$WRITE_STATUS" -ne 0 ] || [ ! -s "$ARTIFACT" ] || ! jq -e . "$ARTIFACT" >/dev/null 2>&1; then
  echo "outcome=error" >> "$GITHUB_OUTPUT"
  echo "pr_url=" >> "$GITHUB_OUTPUT"
  echo "Mendr did not complete a migration scan. Leaving any open Mendr PR untouched." >&2
  exit 1
fi

VERDICT="$(jq -r '.verification.verdict' "$ARTIFACT")"

# Did the verified migration actually change a tracked file?
if git diff --quiet --exit-code; then
  # Nothing applied. Two honest cases: nothing to migrate (close any stale PR),
  # or a migration exists but was NOT verified (leave everything as it is).
  if [ "$VERDICT" = "no_migration" ]; then
    echo "outcome=clean" >> "$GITHUB_OUTPUT"
    echo "pr_url=" >> "$GITHUB_OUTPUT"
    old=$(gh pr list --head "$MENDR_BRANCH" --state open --json number -q '.[0].number // empty' 2>/dev/null || true)
    if [ -n "${old:-}" ]; then
      gh pr close "$old" --comment "Mendr: no deprecated model ids remain; closing." --delete-branch || true
    fi
    echo "Mendr: nothing to migrate. No PR opened."
  else
    echo "outcome=not-verified" >> "$GITHUB_OUTPUT"
    echo "pr_url=" >> "$GITHUB_OUTPUT"
    echo "Mendr found a migration but could not verify it (verdict: $VERDICT). No PR opened; nothing applied. Any existing Mendr PR is left untouched." >&2
  fi
  exit 0
fi

echo "outcome=migration-proposed" >> "$GITHUB_OUTPUT"

BASE="${MENDR_BASE:-$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)}"
MARKER="<!-- mendr-bot:llm-migration -->"

git config user.name  "mendr-bot"
git config user.email "mendr-bot@users.noreply.github.com"
# Move the applied changes onto the stable bot branch (rebuilt from HEAD each run
# so the PR stays current), commit, and force-update it. Force is safe: this
# branch is owned entirely by Mendr.
git checkout -B "$MENDR_BRANCH"
git commit -am "chore(deps): migrate deprecated LLM model ids (Mendr)"
git push --force origin "$MENDR_BRANCH"

# Build the PR body from the migration ARTIFACT, not from scraped stdout, so the
# reviewer sees exactly the swaps and the gate outcomes Mendr verified.
BODY="$(mktemp)"
{
  echo "$MARKER"
  echo "Mendr verified this migration in an isolated sandbox and applied it to this branch. **Mendr never merges — review and merge if it looks right.**"
  echo
  echo "**Swaps**"
  jq -r '.migrations[] | "- `\(.from)` → `\(.to)`  (\(.provider), \(.language), \(.sites) site(s): \(.files | join(", ")))"' "$ARTIFACT"
  echo
  echo "**Sandbox verification** (run in this CI, on a throwaway copy)"
  jq -r '.verification | "- type-check: \(.typeCheck.status)\n- build: \(.build.status)\n- tests: \(.tests.status)\n- eval: \(.eval.status)"' "$ARTIFACT"
  echo
  if [ "$(jq -r '.verification.behavioralTested' "$ARTIFACT")" != "true" ]; then
    echo "> Behavior was NOT verified: the gates prove it builds and your existing tests pass, not that the new model matches the old one on quality, latency, cost or response shape. Check those before merging."
    echo
  fi
  echo "Mendr updates this same branch on each run, so re-running keeps one PR current instead of stacking new ones."
  echo
  echo '<details><summary>Full Mendr report</summary>'
  echo
  echo '```'
  cat "$REPORT"
  echo '```'
  echo '</details>'
} > "$BODY"

# Ensure labels exist (ignore "already exists"), then upsert exactly one PR keyed
# by the head branch. Labels are trimmed; an empty list skips --label entirely.
LABEL_ARGS=()
CLEAN_LABELS=""
IFS=',' read -ra LABELS <<< "$MENDR_LABELS"
for lab in "${LABELS[@]}"; do
  lab="$(echo "$lab" | xargs)"
  [ -n "$lab" ] || continue
  gh label create "$lab" --color ededed >/dev/null 2>&1 || true
  CLEAN_LABELS="${CLEAN_LABELS:+$CLEAN_LABELS,}$lab"
done
[ -n "$CLEAN_LABELS" ] && LABEL_ARGS=(--label "$CLEAN_LABELS")

existing=$(gh pr list --head "$MENDR_BRANCH" --state open --json url -q '.[0].url // empty' 2>/dev/null || true)
if [ -n "${existing:-}" ]; then
  gh pr edit "$existing" --body-file "$BODY"
  echo "pr_url=$existing" >> "$GITHUB_OUTPUT"
  echo "Updated existing Mendr PR: $existing"
else
  url=$(gh pr create --base "$BASE" --head "$MENDR_BRANCH" \
    --title "chore(deps): migrate deprecated LLM model ids (Mendr)" \
    --body-file "$BODY" "${LABEL_ARGS[@]}")
  echo "pr_url=$url" >> "$GITHUB_OUTPUT"
  echo "Opened Mendr PR: $url"
fi
