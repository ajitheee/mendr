# mendr v0.4.6-alpha — one-click connect works again; beta hardening

Supersedes `v0.4.5-alpha`; every earlier pin keeps working unchanged.

## What changed

**One-click connect works again.** GitHub refuses a prefilled-editor URL over
about 8 KB, and the generated two-job workflow had grown to 9.6 KB encoded
("Your request URL is too long"). The file a customer commits is now about 40
lines: two jobs, each with its own least-privilege scopes, each calling a
reusable workflow kept in this repository at the pinned release
(`.github/workflows/reusable-audit.yml`, `reusable-migrate.yml`). Same scan,
same migration, same proofs — in the customer's CI — and a version bump is one
line. A test fails if the setup URL ever exceeds 6 KB, and a contract test
checks the caller's `with:` against the reusable workflows' declared inputs.

**Auto-merge is off in the public beta.** The "merge when checks pass" choice
sits behind the operator flag `MENDR_AUTO_MERGE` (default off): the option is
gone from the Approve form, the server records a pull request for review
whatever a form says, and every promise reads "never merges — a person reviews
the pull request".

**Encryption at rest, provable from the outside.** `GET /healthz` reports
`encryption`: whether a data key is configured, how many stored reports are
sealed vs plaintext, and whether the newest sealed report opens with the
current key. A key set after data already existed seals the plaintext rows at
the next boot.

**Launch copy and docs.** The site headline and supporting line; the exact
meaning of the optional `actions: write`; private vulnerability reporting;
`BETA-ONBOARDING.md` for partners.

## Upgrading

- **New connections:** nothing to do. The App generates the short caller
  pinned to `v0.4.6-alpha`.
- **Repositories connected earlier:** the two-job file from v0.4.4/v0.4.5 keeps
  working; to move to the short caller, take the file from the App's one-click
  setup again (it overwrites `.github/workflows/mendr-audit.yml`).
- **Local:** `npx github:ajitheee/mendr#v0.4.6-alpha audit . --refresh-registry`.

## Verification

- 1,031 scanner tests and 150 App tests. New: the URL-size guard, the
  caller/reusable contract test, the auto-merge flag in both states, the
  `/healthz` encryption block.
- Live: the setup URL for a private repository is 3,697 bytes (was 9,643).

## Known limits

- `watch` and `fix-llm` still use the bundled registry.
- The diff of an approved migration arrives with the final report; progress
  events name the stages and files, not the change itself.
