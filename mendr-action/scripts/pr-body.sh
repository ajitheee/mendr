#!/usr/bin/env bash
# Sourced by run-mendr.sh; also sourced on its own by src/migrate/actionOutcome.test.ts, so what
# goes into the pull request body can be tested with bash alone.
#
# A PULL REQUEST BODY HAS A HARD LIMIT.
#
# GitHub refuses a pull request body longer than 65,536 characters. `gh pr create` then fails, and
# so does `gh pr edit`, after the branch has already been force-pushed with the new swaps. The
# evidence block bounds its own held list (PR_BODY_MAX_SKIPPED in src/report/prBody.ts), but the
# body also carries the whole human report, which lists every held call and the full diff. Past
# about 80 held calls that report alone pushed the body over the limit, so a verified migration
# could no longer open or update its pull request. The copy in the body is now cut to what fits,
# at a line boundary, with a sentence saying where the whole report is: the job summary of the
# run, which carries it uncut.

PR_BODY_LIMIT=65536
# Kept free for what embed_report adds around the report (the fences, the details tags and the
# sentence about the cut), so the body stays under the limit with them.
PR_BODY_REPORT_RESERVE=1024

# The URL of this workflow run, or nothing outside GitHub Actions.
run_url() {
  if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf '%s/%s/actions/runs/%s' "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID"
  fi
}

# The collapsed "Full Mendr report" section of the pull request body, cut so the whole body fits.
# Sizes are counted in bytes, which is never fewer than GitHub's count of characters.
# $1: the human report file. $2: bytes the body already holds before this section.
# $3: the run's URL (may be empty).
embed_report() {
  local report="$1" used="${2:-0}" url="${3:-}" budget size
  budget=$((PR_BODY_LIMIT - used - PR_BODY_REPORT_RESERVE))
  size=$(($(wc -c < "$report")))
  echo '<details><summary>Full Mendr report</summary>'
  echo
  echo '```'
  if [ "$size" -le "$budget" ]; then
    cat "$report"
    echo '```'
  else
    # Cut at the last whole line that fits: the line `head -c` cuts through is dropped.
    if [ "$budget" -gt 0 ]; then
      head -c "$budget" "$report" | sed '$d'
    fi
    echo '```'
    echo
    if [ -n "$url" ]; then
      echo "Mendr cut this report here, because GitHub does not accept a pull request description longer than 65,536 characters. The whole report, with every call held for review and the full diff, is in the job summary of the run that last updated this pull request: $url"
    else
      echo "Mendr cut this report here, because GitHub does not accept a pull request description longer than 65,536 characters. The whole report, with every call held for review and the full diff, is in the job summary of the run that last updated this pull request."
    fi
  fi
  echo '</details>'
}
