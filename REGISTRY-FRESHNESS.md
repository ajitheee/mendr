# Registry freshness — pin the code, refresh the data, signed

Status: **IMPLEMENTED on `main` (2026-09-06)**, shipping in v0.4.0-alpha once the
signing key exists — see *Release checklist*. Design approved 2026-09-06 with the
defaults below; three refinements made during implementation are recorded as
D5–D7.

## The problem in one line

The scanner is pinned to an immutable ref (`MENDR_SPEC`, e.g. `v0.3.0-alpha`) for
supply-chain safety, and the registry shipped INSIDE that ref. So a customer's
daily scan re-ran forever with the knowledge of the day the tag was cut: a
retirement a maintainer promoted on `main` afterwards was invisible until a new
tag shipped AND they bumped `MENDR_SPEC`.

Pinning the code is right. Pinning the data with it was the bug.

## What already existed — reused, not rebuilt

- **Content pipeline.** `registry-discover.yml` (monthly: provider deprecation
  pages → candidates → PR), `mendr candidates promote <ids>` (human-gated,
  quote-backed evidence, replacement must classify `verified`),
  `registry-verify.yml` (weekly: offline integrity + live-catalog regression
  check), `scripts/validate-registry.mjs`.
- **Loader.** `loadLlmRegistry(path?)`; every entry passes `assertDeprecation()`.
  Now factored so `parseLlmRegistryText()` is THE single validation path for the
  bundled file, an operator file and a downloaded snapshot alike.
- **Provenance.** `registryVersion = 'sha256:' + sha256(file)[:16]` — the manifest
  binds to exactly this value.
- **Conclusion gate.** `concludeAudit()` in `src/audit/investigation.ts`, computed
  in ONE place. Freshness is one more input to it; no new conclusion value, so
  the App's `CONCLUSIONS` enum is untouched.

The only missing piece was DISTRIBUTION of the data to pinned scanners.

## How it works

Principle: the scanner code stays immutable. Only DATA moves, only if it is
signed by a key the pinned scanner already trusts, and whichever registry ends
up in use is graded by AGE so the conclusion gate can refuse "no exposure" on
out-of-date knowledge. Nothing downloaded is ever executed.

### 1. Publish — `.github/workflows/registry-publish.yml` (maintainer side)

Triggers: a push to `main` touching `registries/llm-deprecations.json`;
`workflow_run` of `registry-verify` completed **with success** (the weekly
re-stamp); every `v*` tag; `workflow_dispatch`. A `gate` job skips the whole
thing cleanly while the signing secret does not exist yet.

`scripts/publish-registry.mjs` (using the scanner's OWN built
`dist/registry/manifest.js`, so publisher and verifier cannot drift) writes:

- `llm-deprecations.json` — a byte-identical copy of `main`'s file;
- `manifest.json` — canonical JSON (sorted keys, no whitespace; the exact bytes
  that are signed):
  `{"entryCount":110,"publishedAt":"2026-09-06T23:03:33Z","publisher":"registry-publish@github-actions","registryVersion":"sha256:46cb77bc5e20c16f","schemaVersion":1,"sha256":"<64 hex>","sourceCommit":"<40 hex>"}`
- `manifest.sig` — Ed25519 signature over those bytes, base64.

It refuses (a) a registry failing `validate-registry.mjs`, so a
self-contradicting registry can never be signed, and (b) a key whose PUBLIC half
is not in `src/registry/trustedKeys.ts`, so a snapshot no scanner trusts never
looks published. The assets replace the previous ones on the rolling GitHub
Release `registry-latest` (`gh release upload --clobber`; `--latest=false` so it
never becomes the repo's "Latest release").

Why re-stamp weekly even when nothing changed: `publishedAt` then means "a
maintainer pipeline verified this registry within the last week". If that
pipeline stops, every customer's zero-finding scan turns `inconclusive` instead
of staying silently confident. That is the honest meaning of "self-maintaining".

### 2. Fetch + verify — `src/registry/freshRegistry.ts` (scanner side)

`loadRegistryWithFreshness()` returns the registry to scan with and a
`RegistryFreshness`:

```ts
{ source: 'snapshot' | 'file' | 'bundled';
  version: string;                 // content hash of the registry actually used
  publishedAt: string | null;      // signed manifest time, or the bundled stamp; null = unknown
  ageDays: number; maxAgeDays: number;
  state: 'fresh' | 'stale';
  sourceCommit?: string;
  refresh: { requested: boolean; ok: boolean; error?: string };
  reason?: string }                // plain words when not fresh: what happened, what to do
```

Precedence, every step fail-closed:

1. **`MENDR_REGISTRY_FILE`** — an operator's own registry, no network, wins
   outright. If a `manifest.json` + `manifest.sig` sit beside it and verify, it
   is graded by that manifest; an unsigned file is of unknown age and therefore
   STALE (an operator can prove freshness, not assert it). A sidecar signed by an
   untrusted key is an error, never a silent downgrade.
2. **Refresh** — only when requested (`--refresh-registry` /
   `MENDR_REGISTRY_REFRESH=on`), not offline, and at least one key is trusted.
   Fetch `manifest.json`, `manifest.sig`, `llm-deprecations.json` from
   `MENDR_REGISTRY_URL` (default
   `https://github.com/ajitheee/mendr/releases/download/registry-latest/`), 10 s
   per file, 8 MB cap. Then, in order: signature against ANY trusted key
   (Node's built-in Ed25519; 64-byte signatures only) → `schemaVersion === 1` →
   `sha256(registry) === manifest.sha256` → rollback guard
   (`publishedAt >= BUNDLED_PUBLISHED_AT`) → `parseLlmRegistryText` (every entry
   through `assertDeprecation`). Any failure → bundled, with the reason in
   `refresh.error`. **The scan is never blocked by the network.**
3. **Bundled** — always there, graded by `BUNDLED_PUBLISHED_AT`
   (`src/registry/bundledStamp.ts`, generated by
   `scripts/stamp-bundled-registry.mjs` right before tagging).

Grade: `age = now − publishedAt`; `age ≤ MENDR_REGISTRY_MAX_AGE_DAYS` (default 14,
whole days ≥ 1) → `fresh`, else `stale`. A stale-but-verified snapshot is still
USED (it is newer than the bundled copy); only the conclusion rule cares.

Two distinct "stale" notions, kept apart: **snapshot age** (distribution — was
this registry published recently?) and **verification age** (content — the
existing `REGISTRY_STALE_DAYS` = 30 warning on `verification.checkedAt`).

### 3. Conclusion rule — one line in `concludeAudit`

```ts
if (exposureCount > 0) return 'exposure_detected';                 // unchanged: stale knowledge can still PROVE a problem
if (anySurfaceFailed(coverage)) return 'audit_failed';              // unchanged
if (coverage.registry.freshness !== 'fresh') return 'inconclusive'; // NEW: non-fresh knowledge cannot prove absence
…                                                                   // the existing coverage-share rule
```

Asymmetric and fail-closed: exposure found → `exposure_detected` (exit 0 unless
`--fail-on-exposure`); nothing found on a non-fresh registry → `inconclusive`
(exit 3). A report with no `freshness` at all (an older scanner) is not fresh.

### 4. What the customer sees

```
✓ Registry:   anthropic, google, openai · snapshot 2026-09-06 (fresh, 0 d)
✗ Registry:   anthropic, google, openai · bundled 2026-08-01 (STALE 36 d, max 14) → inconclusive
✗ Registry:   anthropic, google, openai · file undated (STALE age unknown, max 14) → inconclusive
```

The reason and the fix appear under "limits of this run" and in the GitHub issue
body's coverage table. `--json` carries `coverage.registry.{providers, source,
version, publishedAt, ageDays, maxAgeDays, freshness, reason, refresh}`. When a
requested refresh did not happen, stderr says `mendr: registry refresh not
applied — <reason>` (never a stack trace). The App's run page shows a `registry:
snapshot 2026-09-06 · fresh (0 d)` chip; an inconclusive run says
"Inconclusive — not a clean result" with the reason; the check run's summary
names the registry it rested on.

### 5. Threat model — why signing is not optional

The registry drives the replacement ids `mendr migrate --write` proposes in pull
requests. An unsigned refresh channel would let a compromised host, CDN or mirror
inject a wrong or malicious replacement into a PR a human might merge — turning
the data channel into a supply-chain hole.

| Control | Protects |
| --- | --- |
| Ed25519 signature over the manifest bytes | authenticity of the data |
| sha256 binding manifest → registry file | integrity |
| `schemaVersion` check | parser safety |
| rollback guard (`publishedAt >= bundled stamp`) | freshness authenticity (no replay of an old signed snapshot) |
| strict `assertDeprecation` parse | only validated JSON; nothing executable |
| bundled fallback | availability |
| timeout + size caps | denial of service |
| publisher refuses an untrusted key / invalid registry | nothing looks published that is not usable |

## Environment and flags

| Knob | Meaning |
| --- | --- |
| `--refresh-registry` / `MENDR_REGISTRY_REFRESH=on` | Fetch the signed latest snapshot before scanning (one GET of public files; nothing sent). Off by default. |
| `--offline` / `MENDR_OFFLINE=1` | Wins over a refresh: no network call is made, the reason says so. |
| `MENDR_REGISTRY_MAX_AGE_DAYS` | Whole days ≥ 1 (default 14). Older is STALE. |
| `MENDR_REGISTRY_URL` | Base URL of a mirror. The signature, not the host, is the trust anchor. |
| `MENDR_REGISTRY_FILE` | Use this registry file instead; graded by a signed `manifest.json` + `manifest.sig` beside it, else stale. No network. |
| `MENDR_REGISTRY_TRUSTED_KEYS_FILE` | A PEM file (one or more PUBLIC KEY blocks) that REPLACES the built-in keyring. Same trust level as `MENDR_SPEC`. |
| `MENDR_REGISTRY_SIGNING_KEY` | Publisher only: the Ed25519 PRIVATE key PEM, as a repository secret. Never anywhere else. |

## Decisions

- **D1 Max snapshot age: 14 days** (env-overridable).
- **D2 Hosting: GitHub Release `registry-latest`.** Same trust root customers
  already fetch the scanner from; Render uptime stays out of every scan.
- **D3 Rollback guard: `publishedAt >= BUNDLED_PUBLISHED_AT`.**
- **D4 A stale-but-verified snapshot is still used for findings**, while
  "no exposure" is inconclusive.
- **D5 The refresh is OPT-IN, not default** (found during implementation).
  `src/audit/noNetwork.test.ts` proves on every build that the default audit
  makes zero network calls — a tested trust invariant the design would have
  silently broken. The generated workflows turn the refresh on visibly instead,
  via an ENV VAR rather than a flag: a `v0.3.0-alpha` pin ignores an unknown
  variable but would fail on an unknown flag, so the templates carry it today.
- **D6 Freshness is graded by AGE, not by source.** The bundled registry gets a
  release stamp, so on release day it is exactly as fresh as a snapshot published
  the same moment; two weeks later it is stale and says so. States are
  `fresh | stale`; the refresh outcome is reported separately. (The approved text
  had `unavailable ⇒ inconclusive`; that would have made every offline run
  inconclusive on release day, which is less accurate, not more honest.)
- **D7 `MENDR_REGISTRY_TRUSTED_KEYS_FILE`** replaces the keyring at runtime. It
  sits at the same trust level as `MENDR_SPEC` — the customer's own repository
  configuration — so it is no new hole, and it is what makes deterministic tests,
  self-hosted mirrors and air-gapped runs possible.

## Release checklist (v0.4.0-alpha)

Human steps are marked ⚑; everything else is scripted.

1. ⚑ Generate the keypair locally:
   `openssl genpkey -algorithm ed25519 -out mendr-registry.key` and
   `openssl pkey -in mendr-registry.key -pubout`.
2. ⚑ Add the PRIVATE key as the repository secret `MENDR_REGISTRY_SIGNING_KEY`
   (Settings → Secrets and variables → Actions). Never paste it in chat, never
   commit it.
3. ⚑ Paste the PUBLIC key into `src/registry/trustedKeys.ts`.
4. `npm run validate:registry` then `node scripts/stamp-bundled-registry.mjs`;
   commit the stamp. Bump `package.json`, `AUDIT_MENDR_RELEASE`
   (`src/audit/installAuditWorkflow.ts`), the App's `MENDR_CLI_SPEC` default
   (`app/src/config.ts`) and `render.yaml` to `v0.4.0-alpha`.
5. Tag `v0.4.0-alpha` and push the tag — `registry-publish` runs on the tag, so a
   snapshot at least as new as the stamp exists the moment the scanner does.
6. Confirm the release assets exist and a refresh verifies:
   `MENDR_REGISTRY_REFRESH=on npx github:ajitheee/mendr#v0.4.0-alpha audit .`
   shows `Registry: … snapshot <today> (fresh, 0 d)`.
7. Existing connected repositories move by setting the repository variable
   `MENDR_SPEC=v0.4.0-alpha` (no workflow edit) — their committed workflow
   already carries `MENDR_REGISTRY_REFRESH: 'on'` if generated after 2026-09-06;
   older ones add the line or re-run the one-click setup.

## Not in v1

- `mendr watch`, `fix-llm` and `migrate` still use the bundled registry; the
  audit is what the App and the workflows run. Threading freshness into
  `migrate` (so PRs propose replacements from a fresh registry) is the natural
  next step.
- No per-customer private registries; no registry served by the App; no
  automatic promotion (humans still gate what becomes active); no key-rotation
  tooling beyond the trusted-keys array (rotation = add the new key, dual-sign
  for a window, drop the old key in a later tag).
