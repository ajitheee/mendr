#!/usr/bin/env bash
set -euo pipefail

# Runner for the Mendr GitHub Action.
#
# The trust model is deliberately simple: we let Mendr's own verification gate
# decide. `mendr fix-llm . --write` applies ONLY a Tier A fix it verified (the
# type-check passed and your test suite ran as the gate). A downgraded (Tier C)
# or a clean result writes nothing. So "did any tracked file change?" is an
# exact, honest signal for "was there a verified fix?". We never parse stdout to
# decide what to apply, and we never touch the default branch.

REPORT="$(mktemp)"

# Run Mendr. It applies a verified fix in place, or changes nothing. Don't let a
# non-zero exit (e.g. a pure-JS repo Mendr can't analyze yet) abort the job; the
# git-diff check below is the real decision.
set +o pipefail
npx --yes "$MENDR_SPEC" fix-llm . --write | tee "$REPORT"
set -o pipefail

{
  echo "### Mendr - deprecated LLM model ids"
  echo
  echo '```'
  cat "$REPORT"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# Did Mendr actually apply a verified fix to any tracked file?
if git diff --quiet --exit-code; then
  echo "outcome=clean" >> "$GITHUB_OUTPUT"
  echo "pr_url=" >> "$GITHUB_OUTPUT"
  # Tidy up: if a previous Mendr PR is open but the repo is clean now, close it.
  old=$(gh pr list --head "$MENDR_BRANCH" --state open --json number -q '.[0].number' 2>/dev/null || true)
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
# PR keyed by the head branch.
IFS=',' read -ra LABELS <<< "$MENDR_LABELS"
for lab in "${LABELS[@]}"; do
  gh label create "$lab" --color ededed >/dev/null 2>&1 || true
done

existing=$(gh pr list --head "$MENDR_BRANCH" --state open --json url -q '.[0].url' 2>/dev/null || true)
if [ -n "${existing:-}" ]; then
  gh pr edit "$existing" --body-file "$BODY"
  echo "pr_url=$existing" >> "$GITHUB_OUTPUT"
  echo "Updated existing Mendr PR: $existing"
else
  url=$(gh pr create --base "$BASE" --head "$MENDR_BRANCH" \
    --title "chore(deps): fix deprecated LLM model ids (Mendr)" \
    --body-file "$BODY" --label "$MENDR_LABELS")
  echo "pr_url=$url" >> "$GITHUB_OUTPUT"
  echo "Opened Mendr PR: $url"
fi
