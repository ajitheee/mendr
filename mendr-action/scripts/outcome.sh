#!/usr/bin/env bash
# Sourced by run-mendr.sh; also sourced on its own by src/migrate/actionOutcome.test.ts, which is
# why the decisions live here and not inline: they can be tested with bash alone, without jq, gh,
# git or a GitHub runner.
#
# WHAT A RUN THAT APPLIED NOTHING MEANS.
#
# A run that changed no tracked file is one of three things, and only one of them is clean:
#
#   clean            mendr found nothing to migrate AND held nothing for review in the source code
#                    it reads (TypeScript, JavaScript, Python; not configuration files, which only
#                    `mendr audit` reads). The one outcome that may close an open Mendr pull
#                    request as resolved.
#   held-for-review  nothing was migrated because every retiring id it found was held for a
#                    person (a parameter the replacement treats differently, a fine-tune, an
#                    example tree, an untraced const, an unverified replacement, ...). Retiring
#                    ids remain, so this is NOT clean, and an open Mendr pull request stays open,
#                    with a comment saying Mendr no longer verifies it (held_pr_comment).
#   not-verified     a migration exists but did not verify. Nothing applied; nothing touched.
#
# Until v0.5.10-alpha's known issue was fixed, `migrate` reported a held-only repository as
# `no_migration` with an empty list, and the Action reported it clean and closed an open Mendr
# pull request with "no deprecated model ids remain". The count is now read from the artifact's
# `skipped` list, and an artifact that says `no_migration` over a non-empty list, or whose list
# could not be read, is never clean: the only route to `clean` is a count of exactly zero.

# $1: the artifact's verification.verdict. $2: how many items its `skipped` list holds (a
# non-negative integer; anything else means the list could not be read).
nothing_applied_outcome() {
  local verdict="${1:-}" held="${2:-}"
  case "$verdict" in
    no_migration)
      if [ "$(held_count_or_unknown "$held")" = "0" ]; then
        printf 'clean'
      else
        printf 'held-for-review'
      fi
      ;;
    held_for_review) printf 'held-for-review' ;;
    *) printf 'not-verified' ;;
  esac
}

# $1 normalized to a count: digits only (leading zeros dropped), otherwise `unknown`.
held_count_or_unknown() {
  case "${1:-}" in
    '' | *[!0-9]*) printf 'unknown' ;;
    *) printf '%d' "$((10#$1))" ;;
  esac
}

# May a clean run close an open Mendr pull request? Only a run that looked at every retiring
# model. An approval-gated run (MENDR_ONLY) migrates the approved models and looks at nothing
# else, so it cannot say the repository is clean, and the pull request may carry another model's
# swap. $1: MENDR_ONLY (empty when the run was not restricted).
may_close_as_resolved() {
  [ -z "${1:-}" ]
}

# The plain sentence for a held-for-review run: the log line, the job summary and the warning
# annotation all print it. $1: the count from held_count_or_unknown.
held_sentence() {
  local n="${1:-unknown}"
  case "$n" in
    unknown) printf 'Mendr: retiring model ids in the code were held for review, but the number could not be read from the report. This repository is not clean; run mendr audit to see each one.' ;;
    1) printf 'Mendr: 1 place in the code still uses a retiring model id and needs a person. It was held for review, not migrated, so this repository is not clean.' ;;
    *) printf 'Mendr: %s places in the code still use a retiring model id and need a person. They were held for review, not migrated, so this repository is not clean.' "$n" ;;
  esac
}

# AN OPEN MENDR PULL REQUEST AFTER A HELD-FOR-REVIEW RUN.
#
# A held-for-review run leaves an open Mendr pull request open: closing it would say the
# repository is resolved, and it is not. But that pull request came from an earlier run, and its
# body still says Mendr verified the swap. When a newer release or registry holds the same call
# (v0.5.9-alpha swapped `const MODEL = 'claude-opus-4-1-20250805'` used with max_tokens; v0.5.10-alpha
# holds it as coupled_param_unverified), a reviewer reading that body would merge a swap Mendr no
# longer makes. So the run says so on the pull request, where the reviewer acts.
#
# The first line is a marker that names the count and the scope. run-mendr.sh posts the comment
# only when no comment on the pull request already carries that exact line, so an hourly schedule
# does not repeat it; a new count or a new scope is said again.
#
# $1: the held count (held_count_or_unknown). $2: MENDR_ONLY (empty when unrestricted).
# $3: the run's URL (may be empty).
held_pr_comment() {
  local n="${1:-unknown}" only="${2:-}" url="${3:-}"
  printf '<!-- mendr-bot:held-for-review held=%s only=%s -->\n' "$n" "$only"
  printf '%s\n\n' "**Mendr no longer verifies this pull request.**"
  printf '%s\n\n' "$(held_sentence "$n")"
  if [ -z "$only" ]; then
    printf '%s\n\n' "Mendr's latest run made no verified change in this repository, so no change on this branch is verified by Mendr any more. If this branch swaps one of those places, that is a swap Mendr now holds for a person instead of making. Do not merge on the strength of the earlier verification: check each change by hand, or close this pull request."
  else
    printf '%s\n\n' "Mendr's latest run looked only at the approved models ($only) and migrated none of them. If this branch changes a call to one of those models, Mendr no longer verifies that change: check it by hand before merging, or close this pull request."
  fi
  if [ -n "$url" ]; then
    printf '%s\n' "Each held call is listed with its reason in the job summary of that run: $url. \`mendr audit\` and \`mendr fix-llm\` give the evidence."
  else
    printf '%s\n' "Each held call is listed with its reason in the job summary of that run. \`mendr audit\` and \`mendr fix-llm\` give the evidence."
  fi
}

# Does the text of the pull request's comments ($2, one comment body after another) already carry
# the marker line $1? Pure bash, so no pipe can fail under pipefail and read as "no".
already_commented() {
  local key="$1" comments="${2:-}"
  comments="${comments//$'\r'/}"
  case $'\n'"$comments"$'\n' in
    *$'\n'"$key"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}
