# mendr v0.4.5-alpha — an approved migration is planned against current knowledge

Supersedes `v0.4.4-alpha`; every earlier pin keeps working unchanged.

## What changed

**`mendr migrate` uses the same fresh, signed registry as the audit.**
`--refresh-registry` (or `MENDR_REGISTRY_REFRESH=on`, which the App-generated
migration workflow now sets on the `mendr-action` step) fetches the latest
signed registry snapshot — one GET of public files from github.com, verified
against a key built into this release, nothing sent; `--offline` wins. Without
it the bundled registry is used and its age is stated.

**The artifact says which registry it planned against.** A `registry` field
(source, version, published date, age, freshness) in the `mendr-migration/v1`
artifact and a `Registry:` line in the human report. A stale registry is called
out in the notes — a newer retirement or replacement may exist — and a clean
repository says it too, since the absence of a migration is not proof either.

**The App shows it.** `mendr-action` passes the provenance in its report; the
App whitelists it field by field and the migration status line reads
"registry 2026-09-09 · fresh" (or stale, in amber).

## Upgrading

- **New connections:** nothing to do. The App generates `v0.4.5-alpha`
  workflows with the refresh already on for the migrate job.
- **Repositories connected earlier:** set the repository variable
  `MENDR_SPEC=v0.4.5-alpha`. To plan migrations against the fresh registry, add
  `env: MENDR_REGISTRY_REFRESH: 'on'` to the `mendr-action` step, or take the
  current file from the App's one-click setup.
- **Local:** `npx github:ajitheee/mendr#v0.4.5-alpha migrate . --refresh-registry`.

## Verification

- 1,031 scanner tests and 145 App tests. New: three `runMigration` provenance
  cases (stale note, fresh, nothing claimed), two real-CLI cases (an unsigned
  operator file → STALE; a signed file → FRESH with the report line), and the
  App whitelist for `registry` (kept field by field, malformed dropped whole).
- TRUST.md §2: the `mendr migrate` row states the one optional GET.

## Known limits

- `watch` and `fix-llm` still use the bundled registry.
- The diff of an approved migration arrives with the final report; progress
  events name the stages and files, not the change itself.
