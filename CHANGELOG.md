# Changelog

## v0.2.0-alpha — 2026-08-30

**Preview release for design partners.** `v0.1.0` remains the stable line
(`fix-llm`, `watch`). Everything below is marked preview and may change.

### The headline: no key required

The entry requirement is a **repository**, not a provider Admin key.

```sh
mendr audit .
```

`audit` scans TypeScript, TSX, Python and supported configuration files, finds
provider call sites and model identifiers, joins them to the deprecation
registry, and reports each finding with its location, retirement deadline,
migration evidence and a decision (`patch` / `review` / `monitor`).

### Added

- **`mendr audit`** — one unified command joining source scan, configuration
  scan, registry evidence, optional runtime evidence and a decision engine into a
  single canonical evidence record, so `watch`, `fix-llm` and `audit` cannot
  disagree.
- **Source-code scanning inside `audit`** — reuses the same TS/TSX/Python
  analysis behind `watch`/`fix-llm`; no second scanner.
- **Coverage report on every output**, including JSON: source, configuration,
  registry, runtime usage and reader tie-back, each marked completed (`✓`), not
  run (`○`) or failed (`✗`).
- **Four conclusions only** — `exposure_detected`,
  `no_exposure_in_completed_surfaces`, `inconclusive`, `audit_failed`. A general
  "clean" result is unreachable; a skipped or failed surface stays visible and
  blocks any no-exposure claim.
- **Optional runtime evidence, four ways, none required** — OpenTelemetry
  (`--runtime x.json --runtime-source otel`), a sanitized customer usage export
  (CSV/JSON/NDJSON), your own read-only provider key kept in your own CI, or
  model-gateway / Sentry / Datadog / structured application logs. Only provider,
  model, service, environment, timestamp, outcome and volume are read — never
  prompts or responses.
- **GitHub-native report** — `mendr audit . --install` scaffolds a workflow that
  maintains **one** issue per repository, created on the first run and updated in
  place, grouping findings into new / continuing / resolved / moved / not
  re-checked, with the exact scanned commit and the coverage matrix. Requests
  `contents: read` + `issues: write` and nothing else.
- **Stable finding identity** — provider, normalized model, repository-relative
  path, symbol/config key and evidence type. Line numbers are mutable detail, so
  a reformat does not churn the issue.
- **Unsupported-language disclosure** — languages present but not analyzed are
  named in the coverage report, so a repo that is mostly Go never reads as fully
  covered.

### Fixed

- **Provider connectors repaired against current documentation.** The Anthropic
  usage endpoint used a singular `/v1/organization/...` path where the documented
  path is plural — every call returned zero rows, so an Anthropic audit silently
  read as "no usage". Also: request counts were fabricated (the API reports none),
  cost was hardcoded to `0` (a cost report exists), and cached input tokens were
  dropped. For both providers the end bound is exclusive, so the final day of
  every window was silently omitted; the OpenAI cost query omitted `end_time`, and
  spend for models absent from completions usage was discarded.
- **Test/data fixtures are no longer treated as runtime selectors.** Conversation
  exports under `__data__` were being reported as config selectors.
- **Resolution is now surface-aware.** A failed or skipped source scan previously
  made every code finding vanish, reported them as "Resolved", erased the
  persisted baseline, and caused the next healthy run to re-report all of them as
  new. A finding is now resolved only when the surface that would have found it
  actually completed; otherwise it is carried forward and stays open.
- **The issue can no longer be closed by a broken scan** — closing requires zero
  open findings, no failed surface, and every required surface completed.
- **A human-closed issue is never reopened** by any code path.
- Body-size budgeting (a large repository previously exceeded GitHub's issue
  limit), marker-hijack protection, move-vs-fix detection, repo-controlled text
  sanitization, and `persist-credentials: false` on checkout.

### Known limits

- **Live provider reconciliation has NOT been completed.** The OpenAI and
  Anthropic connectors are optional preview functionality; their request and cost
  figures have not been validated against a non-empty organization's provider
  dashboard. Do not rely on them as measured spend or measured usage.
- A configuration finding is a **candidate**, never a proven runtime control —
  reader tie-back analysis does not exist yet.
- Absence from a runtime source is not proof that a model is unused.
- Language coverage is TypeScript, TSX and Python.
- Provider usage reads cover chat/completions only. Anthropic reports no request
  counts. Google/Vertex is unsupported.
- Nothing is ever applied or merged. A `patch` decision means a reviewed PR is
  possible, not that a change was made.

## v0.1.0

Stable: `fix-llm` (deterministic, verified-only model-id migration with type and
test gates) and `watch` (one self-updating GitHub issue listing deprecated model
ids by retirement date).
