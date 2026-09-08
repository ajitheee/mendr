# mendr v0.4.2-alpha — evidence that survives a blip, an overview that tells the truth, and owners

This is the release external partners should use. It supersedes `v0.4.1-alpha`;
a `v0.4.1-alpha` pin keeps working unchanged.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system
with a prepared, human-approved migration path.** It is not "fully
self-maintaining" and does not claim to be.

New in this release, claimed precisely: **evidence reaches the App even when
the App is asleep or GitHub blips; the overview says which scan a result rests
on and whether monitoring is alive; and a person can own a finding without
changing what the evidence says.**

## Since v0.4.1-alpha

**Every GitHub call retries with backoff.** The App's GitHub client retries
429s, 5xxs and secondary rate limits three times with exponential backoff
(500 ms base, ±25 % jitter, 30 s cap) and honours `Retry-After` — a check-run
write no longer fails on the first hiccup, and a failed write still never loses
the evidence. The generated audit and migration workflows and `mendr-action`'s
report POST retry the OIDC token fetch (`curl --retry 3 --retry-delay 2
--retry-all-errors`) and the upload itself (`--retry 4 --retry-delay 5
--retry-all-errors --max-time 120`), so a sleeping free-tier App or a blip does
not lose a report. Both uploads are
idempotent per workflow run attempt, so a repeat is safe.

**The overview: last completed scan vs latest attempt, and a monitoring
signal.** A repository's result rests on its newest COMPLETED scan; a newer
attempt that did not complete (inconclusive, failed) is shown beneath it,
never in its place. A "Monitoring" column reads `active` (evidence arrived
within a day) or `quiet · N d` — the daily workflow may be paused (GitHub
pauses schedules on a public repository inactive for 60 days). The expected
cadence — every push and pull request, and daily at 06:37 UTC — is stated
under the table.

**Acknowledge a finding: who has seen it, who owns the follow-up.** A new
"Ownership" part on every finding card. A signed-in person with access
acknowledges a finding with an owner and a short note; the acknowledging login
comes from the session, never the form. Keyed by repository + provider + model,
so it follows the finding across runs until cleared (one click). It never
changes the finding's status — only a completed scan can. Stored in a new
`acknowledgements` table (names and a capped, escaped note; never the finding),
purged with the repository's data on demand and on uninstall, and audited as
`finding_acknowledged` / `acknowledgement_cleared` — the note stays out of the
audit log.

**The prototype is gone for good; the CLI pin is compiled in.** The App no
longer serves the pre-App JSON-import prototype at `/app/` (it redirects home)
and the marketing site's stale drafts are deleted. The CLI release the App pins
in generated workflows is now a compiled-in constant (`MENDR_CLI_SPEC` in
`app/src/config.ts`) that the release checklist bumps, so a stale environment
variable on the host can never pin customers to an old release.

## Upgrading

- **New connections:** nothing to do. The App generates `v0.4.2-alpha` workflows.
- **Repositories connected earlier:** set the repository variable
  `MENDR_SPEC=v0.4.2-alpha`. To get the retrying uploads, take the current
  workflow from the App's one-click setup (or add `--retry 4 --retry-delay 5
  --retry-all-errors --max-time 120` to the upload `curl` by hand).
- **`mendr-action`:** `uses: ajitheee/mendr/mendr-action@v0.4.2-alpha`.
- **Local CLI:** `npx github:ajitheee/mendr#v0.4.2-alpha audit . --refresh-registry`.

## Verification

- 1,021 scanner tests and 129 App tests. New: retry/backoff (which errors
  retry, `Retry-After`, jittered delays, the attempt cap), six overview states
  (completed vs attempt, active/quiet/not connected, cadence), the
  acknowledgement flow (session-derived actor, cross-run persistence,
  escaping and caps, sign-in and access, purge on demand and on uninstall),
  and the data inventory (five tables, still no credential-shaped column).
- Trust documents updated: TRUST.md status line and data inventory (five
  tables, the acknowledgement fields and their sensitivity);
  [REGISTRY-FRESHNESS.md](REGISTRY-FRESHNESS.md) unchanged.

## Known limits

- `quiet` is inferred from evidence arrival (no run for more than 26 hours),
  not read from GitHub's schedule state; a paused workflow is a likely cause,
  not a proven one.
- The migration workflow is run by hand from the Actions tab — by design; the
  App never triggers it.
- `watch`, `fix-llm` and `migrate` still use the bundled registry (the audit is
  what refreshes).
- Code releases are still not signed (registry snapshots are).
