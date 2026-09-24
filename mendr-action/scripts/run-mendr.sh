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
# The evidence block for the pull request body. `mendr migrate --pr-body <file>` writes it;
# the PR assembly below reads it. It was READ but never WRITTEN and never even defined,
# so under `set -u` every migration pushed its branch and then died one line before
# opening the pull request. Caught on mendr-demo 2026-09-17, approval 5.
PRBODY="$(mktemp)"

# Optional: report what happened to the customer's Mendr App (MENDR_APP_URL),
# proven by THIS run's OIDC token — the same pattern as the audit upload. What is
# sent: outcome, PR url, verdict, the gate statuses, the model swaps and the file
# paths they touch, and (unless MENDR_SEND_DIFF=false) the unified diff of the
# swap so the finding can show what changes — the change, never whole files. It
# needs `id-token: write` in the calling workflow; without it, or without
# MENDR_APP_URL, nothing is sent. It never fails the job: the PR is the
# deliverable, the report is a courtesy to the dashboard.
report_to_app() { # $1 outcome, $2 pr url (may be empty), $3 artifact path (may be empty or missing), $4 branch (may be empty)
  [ -n "${MENDR_APP_URL:-}" ] || return 0
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
    echo "::warning::Mendr: MENDR_APP_URL is set but this job has no 'id-token: write' permission, so the migration result was not reported to the App."
    return 0
  fi
  local body token code
  body="$(mktemp)"
  if ! node "$GITHUB_ACTION_PATH/scripts/build-report.mjs" "${3:-}" "$1" "${2:-}" "${4:-}" > "$body" 2>/dev/null; then
    echo "::warning::Mendr: could not build the migration report for the App; nothing sent."
    return 0
  fi
  # Retries cover a sleeping (free-tier) App waking up and network blips; the
  # report is idempotent per workflow run attempt, so a repeat is safe.
  token="$(curl -sS --retry 3 --retry-delay 2 --retry-all-errors -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${MENDR_APP_AUDIENCE:-mendr}" 2>/dev/null | jq -r '.value // empty' 2>/dev/null || true)"
  if [ -z "$token" ]; then
    echo "::warning::Mendr: could not obtain the GitHub OIDC token; the migration result was not reported to the App."
    return 0
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --retry 4 --retry-delay 5 --retry-all-errors --max-time 120 -X POST "${MENDR_APP_URL%/}/api/migrations" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary @"$body" 2>/dev/null || echo 000)"
  case "$code" in
    2*) echo "Mendr: migration result ($1) reported to the App." ;;
    *) echo "::warning::Mendr: the App did not accept the migration report (HTTP $code). The PR, if any, is unaffected." ;;
  esac
  return 0
}

# Progress for the approval(s) this run carries out (MENDR_APPROVAL_IDS, set by
# the action's approval gate): one short line per stage, proven by the OIDC
# token, so the person who approved can watch it happen in the App. Best effort
# — a failed post never fails the job, and nothing here is code.
post_event() { # $1 stage, $2 detail (optional)
  [ -n "${MENDR_APPROVAL_IDS:-}" ] && [ -n "${MENDR_APP_URL:-}" ] || return 0
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || return 0
  local token payload id
  token="$(curl -sS --retry 2 --retry-delay 2 --retry-all-errors -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${MENDR_APP_AUDIENCE:-mendr}" 2>/dev/null | jq -r '.value // empty' 2>/dev/null || true)"
  [ -n "$token" ] || return 0
  payload="$(jq -cn --arg s "$1" --arg d "${2:-}" '{stage: $s} + (if ($d | length) > 0 then {detail: $d} else {} end)')"
  IFS=',' read -ra ids <<< "$MENDR_APPROVAL_IDS"
  for id in "${ids[@]}"; do
    id="$(echo "$id" | xargs)"
    [ -n "$id" ] || continue
    curl -sS -o /dev/null --max-time 30 -X POST "${MENDR_APP_URL%/}/api/approvals/$id/events" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary "$payload" 2>/dev/null || true
  done
  return 0
}

# Whatever else goes wrong from here on, the App must hear about it: a run that
# dies silently leaves the person who approved staring at "running". The trap
# reports `error` and names the step; the PR step below has its own, more
# specific handling.
on_unexpected_error() {
  local rc=$? cmd="$BASH_COMMAND"
  post_event failed "the migration run stopped unexpectedly at: ${cmd:0:120} (exit $rc)"
  report_to_app error "" "${ARTIFACT:-}"
  exit "$rc"
}
trap on_unexpected_error ERR

# Approval-gated runs migrate exactly the approved models (MENDR_ONLY, e.g.
# "openai/gpt-4,google/gemini-1.5-pro"); everything else is left alone.
ONLY_ARGS=()
[ -n "${MENDR_ONLY:-}" ] && ONLY_ARGS=(--only "$MENDR_ONLY")

# Human report (for the job summary) and the machine artifact (for the PR body
# and the apply gate) come from two runs of the same verified migration: the
# first prints the report, the second applies and emits JSON. Both verify; only
# the second writes. Capture exit status EXPLICITLY — a nonzero exit means Mendr
# never completed a scan (bad path/spec), which must NEVER be reported as clean.
post_event verifying "type-check, build and your tests on a throwaway copy"
set +e
# npm 10 cannot install a git dependency pinned to a FULL 40-character commit SHA when
# that package has a `prepare` script -- it fails with "GitFetcher requires an Arborist
# constructor to pack a tarball". A 39-character prefix works, which is how the boundary
# was found. Node 22 still ships npm 10, and a full immutable SHA is exactly what a
# customer is told to pin, so raise npm rather than ask anyone to truncate a hash. Node
# is untouched: the customer's build and tests still run on the version they chose.
if [ "$(npm --version | cut -d. -f1)" -lt 11 ]; then
  npm install -g npm@^11 >/dev/null 2>&1 || true
fi

npx --yes "$MENDR_SPEC" migrate . "${ONLY_ARGS[@]}" ${MENDR_EVAL:+--eval-command "$MENDR_EVAL"} >"$REPORT" 2>&1
REPORT_STATUS=$?
npx --yes "$MENDR_SPEC" migrate . --write --json --pr-body "$PRBODY" "${ONLY_ARGS[@]}" ${MENDR_EVAL:+--eval-command "$MENDR_EVAL"} >"$ARTIFACT" 2>/dev/null
WRITE_STATUS=$?
set -e

# SANITIZE BEFORE ANY PUBLICATION, AND FAIL CLOSED.
#
# $REPORT is published three ways below — the Actions log, the job summary, and
# the body of a PUBLIC pull request — and the capture above used 2>&1, so it
# holds whatever the process wrote to stderr: node's own stack traces and any
# thrown Error, neither of which passes through mendr's report renderer. The
# renderer sanitizes what it renders; this covers what it never saw.
#
# If the filter cannot run, the report is WITHHELD rather than published raw.
# Keeping it would fail open on a security control to preserve a convenience,
# which is the trade this product refuses everywhere else: an unreadable report
# costs a reviewer one click into the job log, while an unsanitized one is
# published to a public pull request and cannot be recalled. The migration
# itself is unaffected — only this text is withheld.
if npx --yes "$MENDR_SPEC" redact "$REPORT" >"$REPORT.clean" 2>/dev/null && [ -s "$REPORT.clean" ]; then
  mv "$REPORT.clean" "$REPORT"
else
  rm -f "$REPORT.clean"
  echo "::warning::Mendr: the report could not be sanitized, so it was withheld rather than published. The migration and its gates are unaffected; re-run with a mendr build that provides \`mendr redact\`."
  printf 'Mendr withheld this report.\n\nIt could not be passed through the output sanitizer, and this text is published to a public pull request, so it is withheld rather than published unchecked. The migration and its verification are unaffected — see the machine-readable artifact for the result.\n' >"$REPORT"
fi

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
  report_to_app error "" ""
  exit 1
fi

VERDICT="$(jq -r '.verification.verdict' "$ARTIFACT")"
# The gate words go straight into the App's approval timeline, where a human
# reads them. Spell them the way every other surface does (src/gates/status.ts
# CHECK_LABEL) instead of posting the raw union member — `not_run`, underscore
# and all, is a machine token, and the identical bug was fixed in the
# pull-request body at src/report/prBody.ts.
#
# The mapping lives in shell rather than in the jq program so it can be tested
# without jq installed; an unnoticed jq syntax error here would be swallowed by
# the `|| echo ''` below and silently drop the gate line from the timeline.
gate_label() {
  case "$1" in
    passed) printf 'passed' ;;
    failed) printf 'FAILED' ;;
    skipped) printf 'skipped' ;;
    not_run) printf 'not run' ;;
    inconclusive) printf 'could not run' ;;
    # An unknown word is printed as-is rather than guessed at: a sixth state
    # should look wrong in the timeline, not be quietly renamed to a fifth.
    *) printf '%s' "$1" ;;
  esac
}
GATES=''
if GATE_RAW="$(jq -r '.verification | "\(.typeCheck.status) \(.build.status) \(.tests.status) \(.eval.status)"' "$ARTIFACT" 2>/dev/null)"; then
  # shellcheck disable=SC2086
  set -- $GATE_RAW
  if [ "$#" -eq 4 ]; then
    GATES="type-check $(gate_label "$1") · build $(gate_label "$2") · tests $(gate_label "$3") · eval $(gate_label "$4")"
  fi
fi
case "$VERDICT" in
  verified) post_event verified "$GATES" ;;
  no_migration) ;;
  *) post_event not-verified "$VERDICT · $GATES" ;;
esac

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
    report_to_app clean "" "$ARTIFACT"
  else
    echo "outcome=not-verified" >> "$GITHUB_OUTPUT"
    echo "pr_url=" >> "$GITHUB_OUTPUT"
    echo "Mendr found a migration but could not verify it (verdict: $VERDICT). No PR opened; nothing applied. Any existing Mendr PR is left untouched." >&2
    report_to_app not-verified "" "$ARTIFACT"
  fi
  exit 0
fi

echo "outcome=migration-proposed" >> "$GITHUB_OUTPUT"

BASE="${MENDR_BASE:-$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)}"
MARKER="<!-- mendr-bot:llm-migration -->"

git config user.name  "mendr-bot"
git config user.email "mendr-bot@users.noreply.github.com"
post_event applying "$(jq -r '[.migrations[] | "\(.from) → \(.to) in \(.files | join(", "))"] | join("; ")' "$ARTIFACT" 2>/dev/null || echo '')"
# Move the applied changes onto the stable bot branch (rebuilt from HEAD each run
# so the PR stays current), commit, and force-update it. Force is safe: this
# branch is owned entirely by Mendr.
git checkout -B "$MENDR_BRANCH"
git commit -am "chore(deps): migrate deprecated LLM model ids (Mendr)"
git push --force origin "$MENDR_BRANCH"
post_event pushed "$MENDR_BRANCH"

# Build the PR body from the migration ARTIFACT, not from scraped stdout, so the
# reviewer sees exactly the swaps and the gate outcomes Mendr verified.
BODY="$(mktemp)"
{
  echo "$MARKER"
  echo "Mendr verified this migration on a throwaway copy of this repository, in this CI, with this job’s own credentials stripped — then applied it to this branch. **Mendr never merges — review and merge if it looks right.**"
  echo
  # The evidence block: each swap with its retirement date and the provider notice behind it,
  # the replacement verdict, coupled parameters, what actually ran, and what was deliberately
  # left alone. Rendered by `mendr migrate --pr-body` rather than assembled here, because
  # wording those is the part with rules in it and it is covered by tests in report/prBody.ts.
  if [ -s "$PRBODY" ]; then
    cat "$PRBODY"
  else
    # Never leave a PR bodyless if the render is missing.
    echo "**Swaps**"
    jq -r '.migrations[] | "- `\(.from)` → `\(.to)`  (\(.provider), \(.sites) site(s))"' "$ARTIFACT"
  fi
  echo
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
  PR_URL="$existing"
  echo "pr_url=$existing" >> "$GITHUB_OUTPUT"
  echo "Updated existing Mendr PR: $existing"
else
  # The one thing a repository setting can refuse: "GitHub Actions is not
  # permitted to create or approve pull requests" (Settings → Actions → General).
  # The verified change is already on the branch, so say exactly that — to the
  # log, to the job summary and to the App — and fail the job, but never silently.
  set +e
  url=$(gh pr create --base "$BASE" --head "$MENDR_BRANCH" \
    --title "chore(deps): migrate deprecated LLM model ids (Mendr)" \
    --body-file "$BODY" "${LABEL_ARGS[@]}" 2>&1)
  pr_rc=$?
  set -e
  if [ "$pr_rc" -ne 0 ]; then
    trap - ERR
    echo "outcome=pr-blocked" >> "$GITHUB_OUTPUT"
    echo "pr_url=" >> "$GITHUB_OUTPUT"
    NEW_PR_URL="$(gh repo view --json url -q .url)/pull/new/$MENDR_BRANCH"
    echo "::error::Mendr: the verified migration is on branch $MENDR_BRANCH, but GitHub refused to open the pull request from Actions: ${url}. Enable Settings → Actions → General → 'Allow GitHub Actions to create and approve pull requests' and approve again, or open it yourself: $NEW_PR_URL"
    {
      echo
      echo "> **Pull request blocked by a repository setting.** The verified change is on \`$MENDR_BRANCH\`. Enable *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*, then approve again — or open it yourself: $NEW_PR_URL"
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    post_event failed "verified and pushed to $MENDR_BRANCH, but GitHub refused to open the pull request from Actions (repository setting) — open it by hand or enable 'Allow GitHub Actions to create and approve pull requests'"
    report_to_app pr-blocked "" "$ARTIFACT" "$MENDR_BRANCH"
    exit 1
  fi
  PR_URL="$url"
  echo "pr_url=$url" >> "$GITHUB_OUTPUT"
  echo "Opened Mendr PR: $url"
fi
post_event pr "$PR_URL"

# An approval that asked for "merge when checks pass" enables GitHub's own
# auto-merge on the PR — still the customer's token, still their branch rules.
# Mendr itself never merges. If the repository does not allow auto-merge, say
# so and leave the PR open for a person.
if [ "${MENDR_MODE:-pr}" = "auto-merge" ]; then
  if gh pr merge "$PR_URL" --auto --squash >/dev/null 2>&1; then
    echo "Mendr: auto-merge enabled on $PR_URL — it merges when the repository's checks pass."
    post_event pr "auto-merge enabled: merges when the repository's checks pass"
  else
    echo "::warning::Mendr: could not enable auto-merge on $PR_URL (the repository may not allow it, or it has no required checks). The PR is open for review."
    post_event pr "auto-merge could not be enabled here — merge on GitHub when ready"
  fi
fi
report_to_app migration-proposed "$PR_URL" "$ARTIFACT" "$MENDR_BRANCH"
