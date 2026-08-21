#!/usr/bin/env bash
set -euo pipefail

# Runner for the Mendr GitHub Action.
#
# The trust model is deliberately simple: we let Mendr's own verification gate
# decide. `mendr fix-llm . --write` applies ONLY a Tier A fix it verified (the
# type-check passed and your test suite ran as the gate). A Tier A candidate that
# failed its gates, a Tier B review-only finding, or a clean result all write
# nothing. So "did any tracked file change?" is an
# exact, honest signal for "was there a verified fix?". We never parse stdout to
# decide what to apply, and we never touch the default branch.

REPORT="$(mktemp)"

# Run Mendr and capture its exit status EXPLICITLY. mendr exits 0 only when a
# scan actually ran (clean or fixes); nonzero means it never analyzed the repo
# (registry outage, bad spec, unsupported repo). A failed run must NEVER be
# reported as "clean" — that would green-light a broken build and, worse, close
# a legitimate open fix PR below.
#
# --fail-on none is passed EXPLICITLY: this script gates on exit 0 and treats
# only exit 2 as "mendr never ran", so a future default change to --fail-on
# must never turn a findings-bearing scan into a phantom error here.
set +e
npx --yes "$MENDR_SPEC" fix-llm . --write --fail-on none >"$REPORT" 2>&1
MENDR_STATUS=$?
set -e
cat "$REPORT"

{
  echo "### Mendr - deprecated LLM model ids"
  echo
  echo '```'
  cat "$REPORT"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# Guard: if mendr did not complete (nonzero exit) or produced no output at all
# (e.g. npx silently no-ops on a malformed spec), report an error, exit red, and
# do NOT touch any existing PR.
if [ "$MENDR_STATUS" -ne 0 ] || [ ! -s "$REPORT" ]; then
  echo "outcome=error" >> "$GITHUB_OUTPUT"
  echo "pr_url=" >> "$GITHUB_OUTPUT"
  echo "Mendr did not complete (exit $MENDR_STATUS). Leaving any open Mendr PR untouched." >&2
  exit 1
fi

# Did Mendr actually apply a verified fix to any tracked file?
if git diff --quiet --exit-code; then
  echo "outcome=clean" >> "$GITHUB_OUTPUT"
  echo "pr_url=" >> "$GITHUB_OUTPUT"
  # Tidy up: if a previous Mendr PR is open but the repo is clean now, close it.
  old=$(gh pr list --head "$MENDR_BRANCH" --state open --json number -q '.[0].number // empty' 2>/dev/null || true)
  if [ -n "${old:-}" ]; then
    gh pr close "$old" --comment "Mendr: no deprecated model ids remain; closing." --delete-branch || true
  fi
  echo "Mendr: nothing to fix (or nothing it could verify). No PR opened."
  exit 0
fi

echo "outcome=fixes-proposed" >> "$GITHUB_OUTPUT"

BASE="${MENDR_BASE:-$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)}"
MARKER="<!-- mendr-bot:llm-deprecations -->"

git config user.name  "mendr-bot"
git config user.email "mendr-bot@users.noreply.github.com"
# Move the applied changes onto the stable bot branch (rebuilt from HEAD each run
# so the PR stays current), commit, and force-update it. Force is safe: this
# branch is owned entirely by Mendr.
git checkout -B "$MENDR_BRANCH"
git commit -am "chore(deps): fix deprecated LLM model ids (Mendr)"
git push --force origin "$MENDR_BRANCH"

BODY="$(mktemp)"
{
  echo "$MARKER"
  echo "Mendr found deprecated LLM model ids or coupled params and applied a verified fix."
  echo "The type-check passed and your test suite ran as the gate before this landed on the branch."
  echo
  echo "Review and merge if it looks right. Mendr updates this same branch on each run, so re-running keeps one PR current instead of stacking new ones."
  echo
  echo '<details><summary>Full Mendr report</summary>'
  echo
  echo '```'
  cat "$REPORT"
  echo '```'
  echo '</details>'
} > "$BODY"

# Make sure the labels exist (ignore "already exists"), then upsert exactly one
# PR keyed by the head branch. Labels are trimmed; an empty list skips --label
# entirely (gh errors on --label "").
LABEL_ARGS=()
CLEAN_LABELS=""
IFS=',' read -ra LABELS <<< "$MENDR_LABELS"
for lab in "${LABELS[@]}"; do
  lab="$(echo "$lab" | xargs)" # trim whitespace
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
    --title "chore(deps): fix deprecated LLM model ids (Mendr)" \
    --body-file "$BODY" "${LABEL_ARGS[@]}")
  echo "pr_url=$url" >> "$GITHUB_OUTPUT"
  echo "Opened Mendr PR: $url"
fi
