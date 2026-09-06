# mendr v0.4.0-alpha — registry freshness: pin the code, refresh the data, signed

This is the release external partners should use. It supersedes `v0.3.0-alpha`.
A `v0.3.0-alpha` pin keeps working unchanged — but it re-scans forever with the
registry of the day that tag was cut, which is exactly what this release fixes.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system**
with a prepared, human-approved migration path. It is not "fully
self-maintaining" and does not claim to be.

New in this release, claimed precisely: **a pinned scanner can now audit against
current retirement knowledge** — a signed, dated registry snapshot — and a
zero-finding result is only called "no exposure" when that knowledge is provably
fresh. Stale knowledge can still prove an exposure; it can never prove the
absence of one.

## Since v0.3.0-alpha

**Signed registry snapshots.** Mendr's CI publishes `registries/llm-deprecations.json`
byte-identical with a canonical manifest (content hash, sha256, `publishedAt`,
source commit) and an Ed25519 signature to the rolling release `registry-latest`
— on every registry change, weekly after the verify job passes, and on every
release tag. The publisher refuses a registry that fails integrity validation and
a key no shipped scanner trusts. The private key exists only as a CI secret; the
public key is built into this release (`src/registry/trustedKeys.ts`).

**Opt-in refresh, offline by default.** `--refresh-registry` (or
`MENDR_REGISTRY_REFRESH=on`, which the generated workflows set) makes one GET of
those three public files, then verifies signature → schema → sha256 → rollback
floor → the same entry validation as the bundled file. Any failure falls back to
the bundled registry and is disclosed. The default audit still makes **no
network call** — the offline test that proves it is unchanged — and `--offline`
always wins.

**Freshness graded by age; fail-closed conclusion.** Whichever registry is in use
is dated (a signed `publishedAt`, or this release's stamp for the bundled copy)
and graded: older than 14 days (`MENDR_REGISTRY_MAX_AGE_DAYS`) is stale, and a
zero-finding scan on a stale registry is `inconclusive` (exit 3). The Registry
coverage row shows the date and grade (✗ when stale); "limits of this run" and
the GitHub issue body explain it; `--json` carries `coverage.registry.*`.

**Daily scheduled scans.** The workflow the App hands a repository now also runs
on a daily off-the-hour cron, so a retirement announced on an idle repository is
caught without a push.

**Inconclusive evidence is delivered, and shown as such.** The generated workflow
posts the report to the App before exiting with the audit's own code, so the
dashboard shows an inconclusive run as what it is instead of a stale "last good
run" — and the step still fails truthfully. The run page says "Inconclusive —
not a clean result" with the reason; run pills never show a green "nothing
found" for an inconclusive or failed audit; the check run names the registry it
rested on.

**Operator and mirror knobs.** `MENDR_REGISTRY_FILE` (your own registry, graded
by a signed manifest beside it; unsigned = stale), `MENDR_REGISTRY_URL` (a mirror
— the signature, not the host, is the trust anchor),
`MENDR_REGISTRY_TRUSTED_KEYS_FILE` (replaces the built-in keyring; same trust
level as `MENDR_SPEC`).

## Upgrading

- **New connections:** nothing to do. The App now generates `v0.4.0-alpha`
  workflows with the refresh on.
- **Repositories connected on v0.3.0-alpha:** set the repository variable
  `MENDR_SPEC=v0.4.0-alpha`, and add `MENDR_REGISTRY_REFRESH: 'on'` under the
  audit step's `env:` (or re-run the App's one-click setup to take the current
  workflow). Without the variable, the pin stays on v0.3.0-alpha and simply
  ignores the new line.
- **Local CLI:** `npx github:ajitheee/mendr#v0.4.0-alpha audit . --refresh-registry`.

## Behavior change to know

A zero-finding scan whose registry is older than 14 days now exits **3**
(inconclusive) instead of 0. This is deliberate: silence is only evidence
against current knowledge. With the refresh on — as the generated workflows have
it — the registry stays fresh and the verdict stands.

## Verification

- 1,018 scanner tests and 77 App tests, including every verify failure mode
  (untrusted key, tampered file, edited manifest, future schema, rollback,
  invalid entries, 404, network error, oversize) and a contract test through the
  real CLI. The no-network invariant test is unchanged.
- End to end with the production key before tagging: the publish script signed a
  snapshot, and the built scanner fetched, verified and used it via the baked
  public key alone (`source: snapshot`, `fresh`, `refresh ok`).
- Trust documents updated: TRUST.md §2, §3, §5 (T1, T9, new T11), §9;
  SECURITY.md scope; [REGISTRY-FRESHNESS.md](REGISTRY-FRESHNESS.md).

## Known limits

- `watch`, `fix-llm` and `migrate` still use the bundled registry.
- GitHub pauses scheduled workflows on a public repository with no activity for
  60 days; re-enable from the Actions tab.
- Code releases are still not signed (registry snapshots are).
