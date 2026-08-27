# v0.2.0-alpha — AI dependency audit (MEASURE + LOCATE)

Prerelease. Adds the read-only audit pair — `usage-audit` (MEASURE) and
`config-scan` (LOCATE) — on top of the stable v0.1.0 (`fix-llm`, `watch`). The
v0.1.0 install instructions remain the recommended path until v0.2.0-alpha is
verified from a fresh installation.

## What's new
- `mendr usage-audit [provider]` — per-model usage/spend from a provider's
  read-only usage API, joined to the deprecation registry: which deprecated
  models actually consume requests and money, with deadlines. Fixture path for
  demo/test; live OpenAI/Anthropic via a read-only Admin key in an env var.
- `mendr config-scan [path]` — locate deprecated ids in config/IaC files,
  separating live selectors (Tier B) from catalog definitions and references
  (Tier C). Report-only.

## Test evidence
- Build: `npm run build` (tsc) — PASS.
- Suite: **649 tests across 49 files — PASS** (625 baseline + 17 config + 7 recon).
- Registry integrity: `node scripts/validate-registry.mjs` — 0 violations.

## Real-repository validation — dify-official-plugins
- Scanned commit: `c62e9d4771e6a46296547c5a08e9b935f2fbff44`
- Scale: 3,845 config files scanned, 75 deprecated ids found.
- **Incorrect Tier B "selectors to change": 148 → 0** after the catalog-definition,
  provider-surface, and verified-gating fixes. Every one of Dify's 75 ids is now a
  Tier C catalog reference, which is correct — Dify defines models in catalogs, it
  does not select them at a call site.

## Known limitations (alpha)
- `config-scan`: report-only (no fix writer); leaf key not full nested key path;
  no override-precedence resolution; non-direct surfaces (Bedrock/Vertex/Azure/
  proxy) → provider-ambiguous, no direct replacement; model-definition catalogs
  are Tier C.
- `usage-audit`: chat/completions usage only; Google/Vertex not supported; the
  live fetch follows the documented usage API and should be verified against a
  live account; an empty live result reports `no_data` / `inconclusive`, not clean.
- MEASURE does not LOCATE; LOCATE does not verify behavioral safety. The report is
  the deliverable — a human decides.

## Fresh-install verification
Before promoting v0.2.0-alpha over the v0.1.0 instructions, verify from a clean
install:
```sh
npx github:ajitheee/mendr#v0.2.0-alpha config-scan <a-repo>
npx github:ajitheee/mendr#v0.2.0-alpha usage-audit --fixture examples/usage-fixture.example.json
```
