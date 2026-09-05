# Changelog

## Unreleased

### Added — human-approved migration PRs

- `mendr migrate --write` applies the migration to the working tree, but ONLY
  when the sandbox verdict is `verified` (a real build, test or eval passed).
  Any other verdict (failed, inconclusive, nothing to migrate) writes nothing.
  The write is atomic and drift-checked (fix/atomicWrite), so a file changed
  since the scan aborts the whole write. The artifact's `applied` field lists
  what landed. With `--write`, `migrate` exits 0 whenever a scan completed (the
  applied-or-not is observable), so the PR workflow gates on the change itself.
- The `mendr-action` GitHub Action now runs `mendr migrate . --write` instead
  of `fix-llm --write`: it verifies the migration in your CI's sandbox
  (type-check, your build, your tests, an optional `eval-command`) and opens or
  updates ONE idempotent PR only when the migration verifies. The PR body is
  built from the migration artifact — every swap and each gate's outcome — not
  scraped stdout. New outcomes: `migration-proposed`, `not-verified` (a
  migration exists but did not verify — nothing applied, no PR, existing PR left
  untouched), `clean`, `error`. It never touches the default branch and never
  merges; a human reviews and approves. New `eval-command` input for a
  behavioral gate. Requires a Mendr build that includes `migrate` — pin
  `mendr-spec` to a release tag that has it or a commit SHA.
- Tests: `migrate.test.ts` gains `--write` cases (verified applies to the tree;
  a failing gate writes nothing; `--skip-verify` proves and applies nothing).
  Root suite 70 files/963.

### Added — the migration sandbox (`mendr migrate`)

- A new command proves a model-id migration in an ISOLATED sandbox and emits one
  self-contained artifact, without ever touching the working tree. It reuses
  fix-llm's verified-only swap engine (TS/JS + Python) and the gate sandbox, and
  adds a real, baseline-relative BUILD gate: the repo's own build is run once
  without the change and once with it, so a build that was already broken is
  never blamed on the migration.
- Verification runs four gates — in-memory type-check, the repo's build, the
  repo's tests, and an optional `--eval-command` — and reaches a verdict:
  `verified` (PR-ready) requires a REAL run (build, tests or eval) to have
  passed, not just the in-memory type-check; `failed` if any gate rejects it;
  `inconclusive` when nothing executable ran (e.g. no build script or no
  installed dependencies); `no_migration` when there is nothing to swap. It
  states plainly that behavior is untested unless an eval command passed.
- Output: a human report (verdict first, then swaps, then each gate, then the
  diff), `--json` (`mendr-migration/v1`: migrations, changedFiles, diff,
  per-gate verification, prReady, notes), and `--patch <file>` for the
  git-applyable patch. Exit 1 only when a gate fails. Local path only — the
  sandbox runs your build and tests. This is the input to human-approved
  migration PRs (next) and post-merge monitoring.
- New `src/gates/runBuild.ts` and `src/migrate/`. Tests: `migrate.test.ts`
  (verdict matrix; plan + git-applyable diff with the tree untouched; JS call
  sites; verified/failed with real build+test scripts) and `runBuild.test.ts`
  (detection; not-configured; no-deps inconclusive; pass; baseline-broken
  inconclusive). Root suite 70 files/960.

### Added — reader tie-back for environment-variable config selectors

- A config selector like `OPENAI_MODEL: gpt-4` was always a bare *candidate*:
  the audit found a retiring id in configuration but had not shown any code
  reads it. The audit now proves the one config→code link it can prove soundly
  — an environment-variable selector whose exact name is read in source
  (`process.env.OPENAI_MODEL`, `os.getenv("OPENAI_MODEL")`, `import.meta.env.X`,
  `Deno.env.get("X")`, `os.environ[...]`). When a read exists, the finding
  carries the reader's file and line, the per-model `readerTieBackProven` flips
  true, and the coverage matrix shows Reader tie-back as proven.
- Deliberately conservative and honest: only UPPER_SNAKE keys with an
  underscore are treated as env vars (a generic `model:` never triggers a
  `process.env.model` hunt); TS/JS reads are matched on the **syntax tree**, so
  a mention in a comment or unrelated string never counts; and a proven read
  adds evidence only — config is still never auto-patched, and "read by code" is
  still not "called in production" (that needs runtime evidence). New module
  `src/config/readerTieBack.ts`, surfaced in the CLI report, the audit JSON
  (`locations[].readerTieBack`), the GitHub issue body, and the workspace.
- Tests: `src/config/readerTieBack.test.ts` (env-var key shapes; process.env /
  bracket / import.meta.env / Deno.env.get / os.getenv / os.environ reads; no
  comment/string false matches; non-env keys ignored) and two audit end-to-end
  cases in `auditStdout.test.ts` (proven with reader location; unproven when no
  code reads it). Root suite 68 files/947.

### Added — JavaScript source support

- The audit, `fix-llm` and `watch` now scan JavaScript (`.js`, `.jsx`, `.mjs`,
  `.cjs`), not only TypeScript. JavaScript rides the same syntactic ts-morph
  scanner as TypeScript, so the literal and receiver rules are identical: an
  ES-module first-party SDK call site is Tier A (auto-fixable), and a
  `require()`-based receiver is detected but conservatively capped below Tier A
  (found, never wrongly auto-patched). `.d.ts` and `.min.js`/bundle files are
  excluded; `.test.js`/`.spec.jsx` and the usual test directories are skipped
  by the same rule as TypeScript.
- Coverage now reports a JavaScript file count of its own (`jsFiles` in the
  audit JSON and the check-run/workspace views), and JavaScript is no longer
  named as an "unanalyzed language" gap — a JavaScript-only repository now
  reports real exposure instead of "inconclusive".
- New tests: `src/usage/jsScan.test.ts` (ESM/JSX/MJS Tier A, CJS conservative,
  data not a call site, walker/counter language split), a JavaScript-only audit
  end-to-end in `auditStdout.test.ts`, and census assertions in
  `languages.test.ts`. All run in the existing CI job. Verified end to end:
  `fix-llm` produces and gate-verifies a correct diff on a `.mjs` call site.

### Added — the Action sends evidence to the App, and the workspace reads it back

- `mendr audit --install` now scaffolds an optional, commented "Send audit
  evidence to your Mendr App" step: it POSTs the run's `mendr audit --json` to
  `MENDR_APP_URL/api/ingest`, authenticated by the run's GitHub OIDC token
  (audience `mendr`), with no shared secret. It is OFF by default and turning
  it on is a deliberate three-line change, because it grants `id-token: write`
  to the job; the scaffold says so and points to TRUST.md. The default install
  still asks for `contents: read` + `issues: write` only.
- The investigation workspace (`site/app/`) loads runs straight from the App
  when it is served by it: it probes `/api/me`, offers sign-in when signed out,
  and otherwise shows a repository and run picker backed by `/api/repos` and
  `/api/runs/:id`. The App's run page links to `/app/?run=<id>` to open a run
  directly. Served as a static file or from a plain host, `/api` is absent and
  the paste/drop path is unchanged — nothing is uploaded from the page.

### Added — the Mendr GitHub App (`app/`)

A small hosted service, kept out of the code path on purpose. Your CI still
runs `mendr audit`; the workflow posts the resulting JSON to the App,
authenticated by the run's GitHub Actions OIDC token (no shared secret). The
App re-redacts every string and re-caps every snippet before storing the
evidence, writes one **Mendr audit** check run on the commit (`action_required`
for PATCH ELIGIBLE, `neutral` for review-only or inconclusive, `success`
otherwise, with file:line annotations), and shows the evidence only to users
GitHub confirms can access the repository. Manifest permissions: `checks:
write` + `metadata: read`, nothing else; the App holds no `contents` access and
cannot clone. One-click creation from `/setup`, Postgres or in-memory store,
Dockerfile, tests against a GitHub-shaped fake, its own CI job. TRUST.md
sections 1, 2, 4, 5, 7, 8 and 9 updated to describe it.

### Added — trust package: "nothing is uploaded" enforced in code

- `--offline` (or `MENDR_OFFLINE=1`) installs an in-process guard that makes
  every outbound network primitive throw (`fetch`, `http`/`https`, `net`, `tls`,
  `dns`). The default audit runs unchanged under it; the optional provider
  usage read, `verify-registry` and GitHub-URL clones fail loudly and name the
  blocked operation (`src/net/offlineGuard.ts`).
- `scripts/no-network.cjs`: the same guard as a Node `--require` preload, so
  anyone can prove the claim on any build without trusting the flag.
- `src/audit/noNetwork.test.ts` runs the audit (`--json`, `--issue-body`,
  `--install`) under the preload on every build and includes a control test
  that the preload bites when a provider read is attempted.
- JSON `snippet.lines` now pass through the same `redactSecrets` as the issue
  body, before clipping, so a truncated key never survives as a partial secret.
  Tested in `auditStdout.test.ts`.
- `TRUST.md`: per-command table of what is read, written and sent; the audited
  network surface; data-flow diagram; threat model (assets, boundaries, ten
  threats with mitigations and residuals); redaction patterns; permissions for
  the CLI, the scaffolded workflow, `mendr-action` and the planned GitHub App;
  known gaps; release, provenance and dependency policy.
- `SECURITY.md`: supported versions, scope, private reporting via GitHub
  advisories, response targets, safe harbour.
- README "what leaves your machine" section; site footer "Security" link.

### Added — investigation workspace prototype (`site/app/`)

A static page that imports `mendr audit --json` output and shows a repository
overview (conclusion, coverage, limits, the three decision counts with unequal
weight, nearest verified retirement), a three-panel investigation view (models
and files · the reported line in context · what was found, why it matters, the
provider surface, production usage, the decision and why, what remains unknown,
the next action), and history across runs (new, continuing, carried, resolved,
reopened, dismissed) keyed on the same finding identity the GitHub issue uses.
Nothing is uploaded: the page parses JSON in the browser and keeps dismissals in
local storage. Served at `/app/` on the site. Built to test whether engineers
understand a report without explanation, before any GitHub App or backend.

### Added — audit JSON (additive, schema stays `mendr-audit/v3`)

- `repo`, `generatedAt`.
- Per investigation: `nextAction` — the same sentence the human report prints.
- Per location: `disposition`, `reason` (the Tier-B reason code), a limited
  `snippet` (up to three lines either side of the reported line, 160 characters
  wide) and `lineHash` (a hash of the exact line, so a later run can tell
  "moved" from "changed"). Never a whole file.

## v0.2.4-alpha — 2026-09-04

**Focused hardening from the first five external repository audits** (Browser
Use, Mem0, CrewAI, Agno, LiteLLM; Windows PowerShell). Every Review finding was
read in code. Zero PATCH ELIGIBLE findings before and after, confirmed correct.
LiteLLM's review count fell from 19 to 3; fourteen genuine defaults Mem0 and
Agno had filed as informational are review candidates. See
`RELEASE-v0.2.4-alpha.md` for the per-repository table and the acceptance gate.

### Fixed — classification

- Templates and fixtures are informational: `.env.example` and other
  `*.example` / `*.sample` / `*-template` / `example_*` files, `cookbook/`,
  `benchmarks/`, `notebooks/`, `example_*/` and `sample_*/` directories, JSON
  Schema files, configs named by the repository's own `.gitignore`, configs
  carrying mock-testing flags; a fake-key/fake-model entry demotes only itself.
- Router `model_list`: `model_name` beside `litellm_params` is an alias; the
  sibling `model:` selects. UI metadata keys (`*_placeholder`, `*_hint`,
  `label`, `description`) never select.
- Never a selector: ids handed to tokenizer/encoding helpers; local model
  assignments, parameter defaults and lookup fallbacks inside pricing, cost,
  tokenizer, logging, metrics or `map_*_params` helpers; a response's own
  `model` field read back. A traced same-function request still wins.
- Genuine defaults are review candidates: assignment expressions
  (`this.model = config.model || "…"`), `getattr` / `.get` / `getenv` fallbacks
  on a model-named key, `model:` inside a default-configuration object or dict
  that is not catalog-shaped, `id` on a model/embedder class, and `models/` or
  `publishers/google/models/` prefixed ids.
- `test-config.ts` / `test_*.ts` are test support, as `test_*.py` already was.

### Fixed — report

- An informational reference never says "migrate now": *"No migration action
  required from this reference. Monitor provider status."*
- A registry date with no provider notice is *"registry date … UNVERIFIED"* and
  the next action asks to verify with the provider; never "OVERDUE".
- Informational references collapse to a count and the first five; `--verbose`
  lists all; `--json` carries all. Each JSON location carries a per-location
  `disposition`.

### Fixed — Windows

- Plain ASCII output when stdout is piped/captured on Windows or the terminal
  is not known UTF-8; `--plain` forces it; `MENDR_UNICODE=1` forces glyphs.
- Progress lines only when stderr is a terminal (no more NativeCommandError
  under PowerShell 5.1); `--quiet` / `--no-progress`.

## v0.2.3-alpha — 2026-09-03

**Hardening release.** `mendr audit` v0.2.2-alpha was run against a validation
corpus of 12 real third-party repositories (chatbot-ui, LibreChat, NextChat,
anything-llm, vercel/ai, lobe-chat, open-webui, ragflow, langflow, langchain,
continue, dify-official-plugins; 37,685 source files). Every Tier-A location
was checked by reading the code, with independent skeptics refuting each claim
(see `VALIDATION-2026-09-03.md`). The verdict on "zero incorrect PATCH ELIGIBLE
findings" was **not met**: 60 of the 62 Tier-A locations checked were wrong.
Every confirmed root cause is fixed below and the corpus was re-run.

**Result: zero incorrect PATCH ELIGIBLE findings across the current validation
corpus.** All 12 previously identified incorrect PATCH ELIGIBLE locations are
eliminated; exactly one Tier-A location remains in the corpus and was manually
confirmed correct. This is a statement about that corpus and that decision
class, not a universal claim of zero false positives. Expect FEWER Tier-A
findings and MORE Tier-B review candidates than before, on purpose.

Still true in this release: JavaScript/JSX is not analyzed (disclosed on every
run); report comprehension has not been validated with external partners; live
provider reconciliation is incomplete and the runtime connectors remain
optional preview. See `RELEASE-v0.2.3-alpha.md`.

### Fixed — the TypeScript scanner gets the Python guards (critical)

- A `model:` property in an object passed to **any** call was a Tier-A model
  argument — a React Query mutation, `JSON.stringify` of a mocked response, an
  internal wrapper method. Now the call's receiver must resolve, **in the same
  file**, to a first-party provider SDK client or factory (`openai`,
  `@anthropic-ai/sdk`, `@google/generative-ai`, `@google/genai`, `@ai-sdk/*`)
  with no `baseURL`/`fetch`/Azure override, and the endpoint family must match
  the client family. Everything else is capped at review.
- Any variable or class property whose name contained "model" was Tier A on
  its name alone (an exported constant, an env fallback in a smoke-test helper,
  a parser label). Declarations are now judged by where they are **used**: a
  request on a resolved first-party client inside a function, or review.
- Module-level execution (a top-level `await`, an agent constructed at import)
  is real but capped at review, as in Python.
- `examples/`, `samples/`, `demos/`, `docs/` trees are informational, never a
  dependency of the shipped product (vercel/ai: 183 of 186 Tier-A locations
  were sample apps). `.test-d.ts`, `smoke-api/` and `__snapshots__/` are test
  support.
- `deploymentName` in a standalone catalog row is data, not a live Azure alias.
- Provider sub-factories (`openai.responses`, `openai.image`, `azure`,
  `google.embeddingModel`, `anthropic.messages`, …) are recognized — and
  resolved like any other receiver.

### Fixed — Python

- LangChain factories (`ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`,
  `init_chat_model`) bypassed the surface guard and reached Tier A even behind a
  `base_url` override. They are wrapper surfaces: review, never an unattended
  swap. First-party factories honor `client_options`/`base_url` overrides.
- A Pydantic class-field default on a model-named field
  (`model_name: str = Field(default="gpt-3.5-turbo")`) and a fallback returned
  from a model-named function (`return cfg.MODEL or "dall-e-2"`) were "no
  selector" Tier C. They are the runtime default; now review candidates.

### Fixed — findings that were invisible or mislabeled

- Provider-prefixed selectors — `openai/gpt-5-nano`, `google/gemini-2.0-flash`,
  `openai:gpt-5-mini` (AI SDK gateway, provider registries) — were invisible.
  They are found and reported as gateway selectors at Tier B.
- A CLI `--model` option default is a review candidate, not data.
- Config: `test-fixtures/`, `*-test-config.yaml` and JSON Schema files are
  fixtures/documentation, not live selectors.

### Fixed — honesty of the report

- "Verified direct provider call site" was said of any code call site,
  including Tier B (9 of 12 repositories). "Verified" is now keyed on the tier
  and nothing else; Tier-B lines read "code default or call not traced to a
  provider request — review before changing". Plural grammar fixed.
- `patchEligible` is per **location** in the JSON, and the patch reason names
  the exact lines fix-llm would rewrite and says any other listed line will
  NOT be rewritten. The next action names the command.
- A repository whose analyzed TypeScript/Python is under a quarter of its source
  files concludes **inconclusive**, not "no exposure" (anything-llm: 22 of
  1,242 files analyzed had read as clean).
- Coverage now discloses skipped test files ("N skipped by rule — ids inside
  were not examined"), the count of files in unanalyzed languages, and names
  SQL, Svelte, Vue, Jupyter, Shell and Markdown as unanalyzed. "files scanned"
  counts only files whose model ids were actually examined.
- An already-retired model says "Migrate now — retired on DATE", never "track
  until the retirement date". Reader tie-back is defined once and printed only
  where a config location is involved. Code locations are listed before
  catalog rows so a catalog block cannot hide the one code reference.

### Not changed

- The registry. Three ids reported missing by validation
  (`gemini-1.0-pro-vision-latest`, `text-embedding-ada-002`,
  `text-embedding-004`) are left for the registry process: an LLM never edits
  authoritative registry facts silently.
- JavaScript/JSX is still not analyzed. It is now the single largest disclosed
  gap (2,947 files across 11 of 12 validation repositories).

## v0.2.2-alpha — 2026-08-30

### Fixed — recursive self-detection (release blocker found in v0.2.1-alpha smoke test)

Mendr scanned its own saved reports and read the model ids inside its own
findings as configuration selectors. On the Mendr repository this produced **75
false review findings, 106 supposed dependencies, and an incorrect
`EXPOSURE DETECTED` conclusion**. The loop was self-amplifying: mendr output →
scanned by mendr → becomes new mendr output.

- **Generated-artifact protection.** `test-results/`, `test-output/`,
  `playwright-report/`, `allure-results/`, `coverage/`, `reports/`, `artifacts/`,
  `.mendr/`, and the usual build directories are never treated as configuration.
- **`"generatedBy": "mendr"` marker** is stamped on every JSON document mendr
  produces, and any file carrying it is refused **wherever it sits** — a report
  renamed and committed at the repo root is still mendr output.
- **Density rule.** A config file naming 8+ distinct deprecated ids is a catalog,
  a registry, or a report — never a runtime selector — regardless of its path.
  This is what stops a vendored model catalog (or Mendr's own
  `registries/llm-deprecations.json`) from counting as dependency exposure.
- **Examples, samples, demos and docs directories** are Tier-C informational data.

### Fixed — catalog records are not dependencies

Catalog, documentation, fixture and reference occurrences no longer count as
exposure. A scan finding only those now concludes
`NO EXPOSURE IN COMPLETED SURFACES` and lists them separately as informational
references. The summary no longer calls them "retiring AI dependencies".

### Fixed — other

- `Next action: Track until the retirement date` is now `Monitor provider status`
  for records with no dated deadline.
- Repeatability is regression-tested: run mendr, save its JSON inside the
  repository, run again — counts and decisions are unchanged.

**Verified:** the Mendr repository self-scan went from 75 false review findings /
`EXPOSURE DETECTED` to **0 exposures / `NO EXPOSURE IN COMPLETED SURFACES`**,
while real exposures elsewhere were preserved (chatbot-ui 2, LibreChat 2,
dify-official-plugins 23 genuine call sites).

## v0.2.1-alpha — 2026-08-30

**Version note:** the `v0.2.0-alpha` tag was published on 2026-08-27 against an
earlier commit that predates the `audit` command. Rather than re-point a
published tag — which would silently change the code under anyone who pinned it,
exactly the hazard this project warns about — this release ships as
`v0.2.1-alpha`. `v0.2.0-alpha` remains valid for what it originally contained
(`usage-audit` / `config-scan`).

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
