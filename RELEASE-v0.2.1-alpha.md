# mendr v0.2.1-alpha

> **Why not `v0.2.0-alpha`?** That tag was published on 2026-08-27 against a
> commit that predates the `audit` command. Re-pointing a published tag would
> silently change the code under anyone who pinned it — the exact hazard this
> tool warns about — so this ships as `v0.2.1-alpha` instead.

**This is an alpha.** It is offered to design partners for evaluation, not as a
stable release. `v0.1.0` remains the stable line (`fix-llm`, `watch`).

## What this release is

**Connect your repository and mendr locates retiring AI dependencies. If you
choose to connect runtime evidence, mendr can also verify which ones are live.**

No provider key is required. The entry requirement is a repository.

```sh
mendr audit .
```

It scans TypeScript, TSX, Python and supported configuration files, finds
provider call sites and model identifiers, joins them to the deprecation
registry, and reports each finding with its location, retirement deadline,
migration evidence, and a decision:

```
Deprecated model dependency located

Model: gpt-4
Location: src/ai/client.ts:42 — code call site (model argument)
Retirement: deprecated — 54d left (2026-10-23)
Migration evidence: gpt-4o [registry: verified] (evidence only — not applied here)
Production usage: not measured
Reader tie-back: not proven
Decision: REVIEW REQUIRED
Status: No change applied
```

### GitHub-native report

```sh
mendr audit . --install
```

Scaffolds a workflow that runs in **your** CI and maintains **one** issue per
repository — created on the first run, updated in place afterwards, grouping
findings into new / continuing / resolved, with the exact scanned commit and a
coverage matrix. Findings have stable semantic identities, so a reformat does not
churn the issue.

Permissions requested: `contents: read` and `issues: write`. Nothing else. The
default branch cannot be modified, no PR is opened, and nothing is ever merged.

### Optional runtime evidence — four ways, none required

1. **OpenTelemetry** — `--runtime otel.json --runtime-source otel`
2. **Your own sanitized usage export** — `--runtime export.csv`
3. **Your own read-only provider key**, kept in your CI/secret manager
4. **Gateway / Sentry / Datadog / structured app logs** — `--runtime logs.csv --runtime-source gateway_logs`

mendr reads only provider, model, service, environment, timestamp, request
outcome and volume. Never prompts, never responses.

## Honest limits — read this before evaluating

- **Live provider reconciliation has NOT been completed.** The OpenAI and
  Anthropic connectors are available as optional preview functionality, but their
  request and cost figures have **not yet been validated against a non-empty
  organization's provider dashboard**. Do not rely on them as measured spend or
  measured usage. We are not claiming validated live-usage or spending
  measurement, and this release should not be evaluated on that basis.
  (The connectors were repaired against the current provider documentation in
  this release — including an Anthropic endpoint path that previously returned
  zero rows for every request — but repaired-against-docs is not the same as
  reconciled-against-a-real-account.)
- **A config finding is a candidate, not a proven control.** Reader tie-back
  analysis does not exist yet, so mendr says "candidate selector" and keeps every
  config finding review-only.
- **Absence of runtime evidence is not proof a model is unused.** It only means
  liveness is unknown, or that the connected source did not record it.
- **mendr never claims a general "clean" result.** The four possible conclusions
  are `exposure_detected`, `no_exposure_in_completed_surfaces`, `inconclusive`,
  and `audit_failed`. A skipped or failed surface stays visible and blocks any
  no-exposure claim.
- **A located call site is a *verified direct provider call site*, not proof that
  production runs it.** Source analysis proves the call exists in the code; only
  runtime evidence can show it executes. The report says "Production usage was not
  measured" whenever no runtime source is connected.
- **`patch` means ELIGIBLE, not applied.** The human report renders it as
  `PATCH ELIGIBLE` / `Status: No change applied`; the JSON carries
  `patchEligible` and an always-false `patchApplied`.
- **Nothing is applied.** A `patch` decision means a reviewed PR is possible for a
  verified Tier-A code call site — not that a change was made. There is no
  auto-merge, and PR generation is a separate, gated capability.
- **Language coverage** is TypeScript, TSX and Python. Other languages are not
  analyzed, and the coverage report says so.
- **Provider usage reads cover chat/completions only** (not embeddings, images,
  audio, batch, fine-tuning). Anthropic's usage API reports no request counts.
  Google/Vertex is not supported.

## For design partners

One command, no credentials, on a repository you care about:

```sh
npx github:ajitheee/mendr#v0.2.1-alpha audit .
```

What we would like to learn:

1. Did it find anything you did not already know about?
2. Was any finding wrong — and specifically, was anything called a *call site*
   that is not one?
3. Did it MISS a retiring model you know is in the codebase?
4. Is the report readable enough to act on without asking us?
5. Would you connect a runtime source, and which of the four would you accept?

Everything runs locally. Nothing is uploaded, and no key is ever sent to us.
