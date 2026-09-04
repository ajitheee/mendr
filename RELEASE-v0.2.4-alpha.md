# mendr v0.2.4-alpha

**Focused hardening release** driven by the first audits run outside this
project: five public repositories (Browser Use, Mem0, CrewAI, Agno, LiteLLM),
run on Windows PowerShell with `v0.2.3-alpha`. Every Review finding was read in
the code; the defects that surfaced are fixed here and the same five
repositories were re-run.

**This is an alpha.** Nothing is applied and nothing is merged by any command.
`v0.2.3-alpha` is unchanged and remains valid for what it contained.

## What the five repositories showed

| repository | Patch | Review before → after | informational before → after |
|---|---|---|---|
| browser-use | 0 | 2 → 2 | 28 → 28 |
| mem0 | 0 | 4 → 3 | 8 → 7 |
| crewAI | 0 | 3 → 3 | 58 → 58 |
| agno | 0 | 1 → 2 | 23 → 22 |
| litellm | 0 | 19 → 3 | 57 → 73 |

- **Zero PATCH ELIGIBLE findings, before and after.** None of these codebases
  passes a literal model id to a first-party provider SDK request that resolves
  in the same file; their requests go through their own wrappers, routers or
  Azure. That is the correct answer, and it was confirmed by reading every
  first-party request shape in the five repositories.
- **Every remaining Review finding is a genuine runtime default or a deployable
  configuration value**, each one confirmed in code: a tool's default image
  model that reaches `images.generate`, a provider class default that reaches
  the SDK, a Helm chart's default model, a CLI default, a moderation hook's
  default, a GitHub workflow's `model:` input.
- **Sixteen review candidates in LiteLLM were not selectors** and are now
  informational: cookbook and example-config directories, a form field's
  placeholder text (120 rows from one schema file), a gitignored developer
  config, a CI/QA fixture config carrying mock flags, model literals handed to
  tokenizers, cost calculators and logging payloads, and a capability-probe
  sentinel inside a parameter-mapping helper.
- **Thirteen genuine defaults in Mem0 and one in Agno had been filed as
  informational** and are now review candidates: `this.model = config.model ||
  "…"`, `getattr(config, "model", "…")`, `os.environ.get("…_MODEL", "…")`,
  `DEFAULT_CONFIG = { model: … }`, a `models/`-prefixed id, and an `id` field on
  an embedder class.

The claim from v0.2.3-alpha stands and is not widened: **zero incorrect PATCH
ELIGIBLE findings across the current validation corpus**, which is now the
twelve repositories of the previous release plus these five. It is not a claim
of zero false positives anywhere.

## What changed

- **Templates and fixtures.** `.env.example`, `*.example.*`, `*.sample.*`,
  `*-template.*`, `example_*.yaml`, `cookbook/`, `benchmarks/`, `notebooks/`,
  `example_*/` and `sample_*/` directories, JSON Schema files, a config the
  repository's own `.gitignore` names, and a config carrying mock-testing flags
  are informational. A fake-key or fake-model entry inside a real config demotes
  that entry only.
- **Router `model_list` idiom.** `model_name` beside `litellm_params` is the
  client-facing alias; the sibling `model:` is the selector. UI metadata keys
  (`*_placeholder`, `*_hint`, `label`, `description`) never select.
- **Never a selector:** model ids passed to tokenizer or encoding helpers; local
  model assignments, parameter defaults and lookup fallbacks inside pricing,
  cost, tokenizer, logging, metrics or `map_*_params` helpers; a response's own
  `model` field being read back. A traced request in the same function still
  wins over any of these name rules.
- **Genuine defaults are review candidates:** assignment expressions
  (`this.model = …`), lookup fallbacks on a model-named key, `model:` inside a
  default-configuration object or dict (unless it is catalog-shaped), `id` on a
  model/embedder class, and `models/` or `publishers/google/models/` prefixed
  ids.
- **Report.** An informational reference now says *"No migration action
  required from this reference. Monitor provider status."* — never "migrate
  now". A registry date with no provider notice on file is printed as
  *"registry date YYYY-MM-DD (N d past), UNVERIFIED"* and the next action asks
  you to verify it with the provider; it is never called OVERDUE. Informational
  references are collapsed to a count and the first five by default;
  `--verbose` lists them all and `--json` always carries everything. Each
  location in the JSON now carries its own `disposition`
  (`patch` / `review` / `informational`) beside the model-level decision.
- **Windows.** The report is plain ASCII whenever stdout is not a terminal on
  Windows (Tee-Object, a file, a variable) or the terminal is not known to be
  UTF-8; `--plain` forces it anywhere and `MENDR_UNICODE=1` forces glyphs.
  Progress lines go to stderr only when stderr is a terminal, so PowerShell 5.1
  no longer wraps them in NativeCommandError; `--quiet` / `--no-progress`
  silence them everywhere.

## Acceptance gate (all met on the five repositories)

- Zero incorrect PATCH ELIGIBLE findings.
- Zero example, template or catalog files elevated to Review.
- Genuine runtime defaults remain Review, with evidence.
- No contradictory instructions; no unverified date presented as overdue.
- Clean Windows PowerShell output through Tee-Object, exit code 0, no errors.
- Byte-identical results across repeated runs.

## Honest limits — unchanged from v0.2.3-alpha

- **JavaScript, JSX, MJS and CJS are not analyzed.** Disclosed on every run.
- **Report comprehension has not been validated with external partners.** The
  five repositories above were run by this project, not by their maintainers.
  That measurement is still the next milestone.
- **Live provider reconciliation is incomplete**; the runtime connectors remain
  optional preview. Do not connect an organization Admin key to evaluate mendr.
- A configuration finding is a candidate, never a proven runtime control.
- Test and spec files are counted but their ids are not examined, by rule.
- Registry facts are never edited by a model. The `@YYYYMMDD` Vertex spelling of
  Anthropic ids (`claude-sonnet-4@20250514`) is not yet normalized to the
  `-YYYYMMDD` registry form; it is on the registry list.

## Install

```sh
npx github:ajitheee/mendr#v0.2.4-alpha audit .
```

On Windows, if you pipe or capture the output, it is already plain ASCII.
`--verbose` prints every informational reference; `--json` carries everything.

## For design partners

Run it on a repository you own and tell us six things: any wrong finding (file
and line); any retiring model you know you depend on that it missed; whether the
summary and next action were clear on first read; any installation friction;
whether you would let it run on a schedule; and what a migration PR would have
to prove before you merged it.
