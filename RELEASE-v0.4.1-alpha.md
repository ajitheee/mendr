# mendr v0.4.1-alpha — the migration loop closes: prepare, verify, PR, confirm

This is the release external partners should use. It supersedes `v0.4.0-alpha`;
a `v0.4.0-alpha` pin keeps working unchanged.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system
with a prepared, human-approved migration path.** It is not "fully
self-maintaining" and does not claim to be.

New in this release, claimed precisely: **from a finding, a customer can prepare
a verified migration PR in their own CI, see its result on the finding, and see
the finding confirmed resolved by the next completed audit** — without the App
gaining any permission over their repository.

## Since v0.4.0-alpha

**"Prepare migration for review."** A run page with a PATCH ELIGIBLE finding
carries the migration step. The App hands over a second one-click workflow
(`.github/workflows/mendr-migrate.yml`: `workflow_dispatch` only, pinned to this
release) through GitHub's prefilled editor, and links to its Actions page where
GitHub's own "Run workflow" button is. That workflow runs `mendr-action`:
verify every swap on a throwaway copy (type-check, build, the repo's tests),
apply only on `verified`, push one stable branch, open or update one PR. Mendr
never merges. The scanner now reports `coverage.migration.workflowPresent` (it
can see `.github/workflows/`; the App cannot), so the App offers the right step.

**The action reports back.** With the new `app-url` input (and `id-token: write`
in the job — the generated workflow has both), `mendr-action` POSTs a
`mendr-migration-report/v1` to the App, proven by the run's OIDC token exactly
like the audit: outcome, PR url, verdict, the four gate statuses, the model
swaps and the file paths they touch. **Never the diff** — the report is built
from a field whitelist, and the App whitelists again on ingest. The finding then
shows "Migration run: PR #12 · verified · type-check ✓ build — tests ✓ eval —";
not-verified, clean and failed runs say so. Stored encrypted in a new
`migrations` table with the same retention, on-demand deletion and uninstall
cleanup as findings, and audit-logged.

**Resolution is confirmed by evidence, never by an event.** A run page names the
models that were actionable in the previous run and are absent from this one —
with the PR that covered them — but only when this run is a completed scan on a
fresh registry. Inconclusive scans, stale registries and reports without
freshness claim nothing.

**The App wears the landing page's design.** Same tokens, type and state
language as the marketing site; one committed light look, no motion.

**The old JSON-import prototype has left the customer journey.** The marketing
site's `/app` redirects to the real App; the run page no longer links to it.

## Upgrading

- **New connections:** nothing to do. The App generates `v0.4.1-alpha` workflows.
- **Repositories connected earlier:** set the repository variable
  `MENDR_SPEC=v0.4.1-alpha`. To get migration results on the finding page, take
  the current migration workflow from the App's "Prepare migration for review"
  card (it carries `app-url` and `id-token: write`); an older
  `mendr-migrate.yml` keeps opening PRs but reports nothing.
- **Local CLI:** `npx github:ajitheee/mendr#v0.4.1-alpha audit . --refresh-registry`.

## Verification

- 1,021 scanner tests and 109 App tests. New: the migration-report whitelist
  (redaction, caps, every rejection), every run-page state including each case
  in which a resolution must NOT be claimed, the `/api/migrations` route
  (401/403/store/idempotency/page/uninstall), and a cross-package test that runs
  the real report builder on a real migration artifact through the App's real
  validator and proves the diff is absent.
- Trust documents updated: TRUST.md §2 (the action's one POST), §3 (network
  surface), the data inventory (four tables), §7 (permissions);
  [REGISTRY-FRESHNESS.md](REGISTRY-FRESHNESS.md) unchanged.

## Known limits

- The migration workflow is run by hand from the Actions tab — by design; the
  App never triggers it.
- `watch`, `fix-llm` and `migrate` still use the bundled registry (the audit is
  what refreshes).
- Code releases are still not signed (registry snapshots are).
