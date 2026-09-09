# mendr v0.4.4-alpha — the change on the finding; one file connects a repository

This is the release external partners should use. It supersedes `v0.4.3-alpha`;
a `v0.4.3-alpha` pin keeps working unchanged.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system
with a prepared, human-approved migration path.** It is not "fully
self-maintaining" and does not claim to be.

New in this release, claimed precisely: **after approving a migration in
Mendr, a person sees the change itself on the finding — the diff of the
model-id swap their CI made — without opening GitHub; and connecting a
repository is one file.** The App still holds no access to the code: the diff
is sent by the customer's CI for display, redacted and capped, never whole
files, and nothing is ever applied from the App.

## Since v0.4.3-alpha

**What changes, on the finding.** `mendr-action` sends the unified diff of the
swap with its report (`send-diff`, default on; the action's own artifact, not a
file read). The App keeps only something shaped like a diff, redacts secrets
and caps it at 100 000 characters with a visible mark. The finding shows "What
changes in `src/client.ts`" — just its own file — and the migration card shows
the whole change, each with the note that nothing is applied here. Set
`send-diff: 'false'` to report everything except the diff.

**One file connects a repository.** The one-click setup writes a single
`mendr-audit.yml` with two jobs. `audit` runs on every push and pull request,
daily, and on demand with `contents: read` + `id-token: write`. `migrate` runs
on the approvals schedule — hourly on a public repository, every three hours
on a private one, where checks cost minutes — and whenever the App starts it,
with `contents: write` + `pull-requests: write` + `id-token: write` and
`approval-gated`. Scopes are per job, never workflow-wide; the audit job never
runs on the approvals schedule and the migrate job never runs on a push or a
pull request. A separate `mendr-migrate.yml` keeps working for repositories
that already have one.

**The scanner names the workflow file.** `coverage.migration.workflowFile`
says whether approvals live in `mendr-migrate.yml` or in the two-job
`mendr-audit.yml`; the App remembers it on ingest and starts that file when a
person approves, so an instant start goes to the right place from the first
approval.

## Upgrading

- **New connections:** nothing to do. The App generates the two-job
  `v0.4.4-alpha` workflow.
- **Repositories connected earlier:** set the repository variable
  `MENDR_SPEC=v0.4.4-alpha`, or replace `mendr-audit.yml` with the current
  one-click file to get both jobs (delete an old `mendr-migrate.yml` if you
  do, so approvals are not carried out twice).
- **`mendr-action`:** `uses: ajitheee/mendr/mendr-action@v0.4.4-alpha`.
- **Local CLI:** `npx github:ajitheee/mendr#v0.4.4-alpha audit . --json` now
  reports `coverage.migration.workflowFile`.

## Verification

- 1,026 scanner tests and 144 App tests. New: the diff is kept only when
  diff-shaped, redacted, capped with a mark, and withheld on request; the
  finding and the card render it; the two-job workflow's per-job scopes,
  triggers and guards on public and private repositories; the workflow file
  learned on ingest steers the instant start; the cross-package report test
  proves the diff travels from the real action builder into the real App
  validator, and stops when told.
- Trust documents updated: TRUST.md §2 and the data inventory state that the
  redacted, capped diff of the swap is stored and why; the action's README
  gains `send-diff`.

## Known limits

- The diff arrives with the migration report, at the end of the run; the
  steps before it are streamed, the diff itself is not.
- `watch`, `fix-llm` and `migrate` still use the bundled registry (the audit is
  what refreshes).
- Code releases are still not signed (registry snapshots are).
