# mendr v0.4.3-alpha — approve in Mendr; your CI carries it out

This is the release external partners should use. It supersedes `v0.4.2-alpha`;
a `v0.4.2-alpha` pin keeps working unchanged.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system
with a prepared, human-approved migration path.** It is not "fully
self-maintaining" and does not claim to be.

New in this release, claimed precisely: **a person approves a migration on the
finding, in Mendr, and never has to open GitHub to make it happen** — their own
CI carries it out, streams each step back to the finding, and opens the pull
request. The App still holds no access to the code.

## Since v0.4.2-alpha

**Approve migration to X.** Every patch-eligible finding carries the decision:
open a pull request for review, or open it and enable GitHub's auto-merge when
checks pass. The App records who approved what (a new `approvals` table; the
login comes from the session, never the form). When the App has been granted
the optional `actions: write` — which starts workflows and is not code access —
it starts the repository's migration workflow at once; otherwise that
workflow's own schedule picks the approval up within the hour on a public
repository (three hours on a private one, where checks cost minutes). A queued
approval can be cancelled with one click.

**Your CI does the work, and says so as it goes.** The generated
`mendr-migrate.yml` runs `mendr-action` with the new `approval-gated` input: it
asks the App what is approved, claims it, migrates exactly those models
(`mendr migrate --only`, also new), streams each stage — verifying, verified,
applying, branch pushed, pull request open — and the migration report closes
the approval as done or failed, from what the CI said, never from an event. A
run with nothing approved ends in seconds, before any dependency install. The
finding shows the status and timeline and keeps itself current while it runs.

**What the App knows about the workflow.** Besides what the scanner saw
(`coverage.migration.workflowPresent`), the App now records when the migration
workflow last asked for approvals — the proof that an approval made here will
be carried out — and which workflow file it is, so a start is sent to the right
place.

## Upgrading

- **New connections:** nothing to do. The App generates `v0.4.3-alpha` workflows.
- **Repositories connected earlier:** set the repository variable
  `MENDR_SPEC=v0.4.3-alpha`. To approve migrations from the App, take the
  migration workflow from the Migration card on a finding (it carries
  `approval-gated`, the schedule and the App's `workflow_dispatch`); an older
  `mendr-migrate.yml` keeps working the old way, by hand.
- **Instant starts (optional):** grant the App *Actions: read and write* in the
  GitHub App's settings and accept it on the installation. Without it, the
  schedule alone carries approvals out.
- **`mendr-action`:** `uses: ajitheee/mendr/mendr-action@v0.4.3-alpha`; add
  `approval-gated: 'true'` to gate on approvals made in the App.
- **Local CLI:** `npx github:ajitheee/mendr#v0.4.3-alpha migrate . --only openai/gpt-4`.

## Verification

- 1,025 scanner tests and 139 App tests. New: the approval flow end to end
  through the App (approve → dispatch or wait → list → claim → progress →
  report closes it; failed run offers the decision again; cancel; dedupe;
  sign-in, access and token checks; purge on delete and uninstall), every
  approval state on the run page, the generated workflow's triggers and inputs,
  and `restrictRegistry` for `--only`.
- Trust documents updated: TRUST.md summary, §2 (the action's calls to the
  App), the data inventory (six tables) and §7 (the optional `actions: write`,
  stated as what it is); the action's README and example.

## Known limits

- The diff of a proposed change is still read on GitHub's pull request; the
  next release shows it on the finding (redacted, capped, sent by your CI).
- Setting up a repository is still two one-click files (audit, then migration);
  the next release folds them into one.
- `watch`, `fix-llm` and `migrate` still use the bundled registry (the audit is
  what refreshes).
- Code releases are still not signed (registry snapshots are).
