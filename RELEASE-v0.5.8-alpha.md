# v0.5.8-alpha

**The release that knows about 2026-10-23.** OpenAI switches off a batch of models on that date,
and v0.5.7-alpha's bundled registry missed five of them. A repository whose only model call was
`o1` audited **NO EXPOSURE IN COMPLETED SURFACES**, with the registry graded fresh. This tag ships
them, removes four deadlines OpenAI never set, and changes how four kinds of call site are
reported.

The deprecation registry moves from `sha256:e5f920c0fe57840f` (161 entries) to
`sha256:079c0af585316432` (167 entries: 163 model ids, 4 parameter rules).

Scans with registry refresh switched on already received this registry content: `registry-publish`
signed and published it when #41 merged. This tag is for everyone else. It puts the same registry
in the bundled copy, and it carries the scanner changes, which nothing but a tag can deliver.

---

## What a customer gets

### 1. The 2026-10-23 retirements are in the bundled registry

Ten ids are added, all retiring on **2026-10-23**:

- `o1`, `o1-pro`, `o1-pro-2025-03-19`
- `o3-mini-2025-01-31`, `o4-mini-2025-04-16`, `gpt-4.1-nano-2025-04-14`
- `gpt-3.5-turbo-completions`, `gpt-4-completions`, `gpt-4-0613-completions`,
  `gpt-4-turbo-completions`

Checked on the release code against a probe that calls each of the five that had no finding:

| call | v0.5.7-alpha | v0.5.8-alpha |
|---|---|---|
| `o1` | no finding | **patch eligible** → `gpt-5.6-sol` |
| `o3-mini-2025-01-31` | no finding | **patch eligible** → `gpt-5.6-sol` |
| `o4-mini-2025-04-16` | no finding | **patch eligible** → `gpt-5.6-terra` |
| `gpt-4.1-nano-2025-04-14` | no finding | **patch eligible** → `gpt-5.6-luna` |
| `o1-pro` | no finding | **review required**: the replacement needs `reasoning.mode: pro`, which an id swap would silently drop |

Why they were missed:

- `discover` refused any row that lists a snapshot with its alias (`o1-pro-2025-03-19 | o1-pro`).
- It could not see `o1` at all, because an id had to contain `-` or `.`.
- Its refusals never reached a person.

The full account is in `REGISTRY-DATES-2026-10-04.md`.

### 2. Four deadlines OpenAI never set are gone

`gpt-5`, `gpt-5-mini`, `gpt-5-nano` and `gpt-5-pro` carried 2026-12-11, labelled as the
provider's date. OpenAI retires only the dated snapshots that day; its own `gpt-5` page lists
the alias with no deprecation. v0.5.7-alpha reported `gpt-5` as a Tier A patch with "68 days" to
go. It now reports nothing, which is what OpenAI has said.

The registry build now fails if a shipped shutdown date is not on the provider's page
(`mendr check-dates`, weekly in `registry-verify`). Twenty-one past alias retirements that were
inferred from a snapshot now say so (`inferredFrom`), rather than passing as the provider's word.

### 3. A swap that starts applying a parameter rule goes to review

A model swap could be an automatic patch even when the replacement brings a parameter rule the
old model never had. OpenAI counts reasoning tokens inside `max_completion_tokens`, so
`gpt-3.5-turbo` with `max_tokens: 20`, renamed onto a reasoning model, is a valid request that can
come back empty. Tests that mock the API cannot see that. Such a swap is now **review required**
(`param_behaviour_change`), with its own sentence. The edit is still written when a person
approves it.

The four parameter rules now quote the provider's own sentence, and `mendr check-rules` re-reads
those pages weekly. Measured on 12 public repositories, this changed no finding: none of them has a
Tier A location for it to act on. See `PARAM-RULES-2026-10-05.md`.

### 4. Three call shapes that were silenced are now reported

All three are **capped at review**, never patched automatically:

| shape | v0.5.7-alpha | v0.5.8-alpha |
|---|---|---|
| A gateway config selecting `model: openai/gpt-4-0613`, the canonical LiteLLM spelling (#31) | **INCONCLUSIVE**: "no retiring AI dependencies" | **EXPOSURE DETECTED**, review required |
| A file under `examples/`, `samples/`, `demos/` or `docs/` that makes a real provider request, in TypeScript or Python (#32, #33) | informational | review required |
| A model argument to a wrapper class, `new OpenAiChat({ model: "gpt-4" })` (#33) | monitor | review required |

On the repositories that motivated this:

- **langgraph** went from a false `NO EXPOSURE` to `EXPOSURE DETECTED`. One finding is its
  registered graph entrypoint, `examples/graphs/agent.py:14`.
- **openai-cookbook** went from 0 actionable findings to 4 at review.

Data in an example (a picker list, a pricing table, a docstring) stays informational.

### 5. The App runs this build

The App's check has led with the deadline since #30 deployed on 2026-09-28; that needed no tag.
What changes here is the CLI the App runs. Its pinned `MENDR_CLI_SPEC` moves to `v0.5.8-alpha`,
and the App redeploys when this release merges, so App scans get everything above.

### 6. The rollback floor moves

The bundled stamp was re-run right before the tag. A downloaded snapshot published before it is
refused, so a replayed old snapshot cannot hide these retirements, even though it is still
correctly signed. The bundled registry grades fresh for 14 days from the stamp. After that, a
zero-finding scan reports `inconclusive` rather than clean.

---

## New commands, for whoever maintains the registry

Nothing runs these on a customer's behalf.

- **`mendr check-dates`:** every shipped shutdown date must be on the provider's page.
- **`mendr check-rules`:** every parameter rule's quoted sentence must still be on its page.
- **`mendr read-page --provider <name> --url <page>`:** a dry run. A model reads a deprecation
  page, and only claims the page literally supports are kept. It writes nothing. It needs an
  OpenAI-compatible endpoint (`MENDR_READER_URL`, `MENDR_READER_MODEL`, and `MENDR_READER_KEY` if
  the endpoint needs one), and none is configured anywhere. See `AI-READER-2026-10-05.md`.

---

## Upgrading

- **CLI:** `npx github:ajitheee/mendr#v0.5.8-alpha audit .`
- **Audit workflow:** set the repository variable `MENDR_SPEC=v0.5.8-alpha`. No workflow edit is
  needed.
- **Migrate workflow: a workflow edit is required.** Change `@v0.5.7-alpha` to `@v0.5.8-alpha` in
  your committed `mendr-migrate.yml`, or re-run the one-click setup. `reusable-migrate.yml` cannot
  honour `MENDR_SPEC`, because GitHub forbids an expression in `uses:`. Setting the variable alone
  leaves migrate on the old build.

---

## Known and unchanged

- **Anthropic `max_tokens` over-triggers.** A `claude-3-opus` call passing `max_tokens` lands in
  review because the guard treats `max_tokens` as model-dependent for Anthropic. This is
  pre-existing, and measured unchanged.
- **Some review findings carry the wrong sentence.** A call site capped at review for a reason
  other than a parameter rule is explained as sitting "under a deployment key". In LibreChat that
  is 5 of 7 review findings, and none of them has a deployment key. The tier is right; the
  sentence is not.
- **Positional constructor arguments are still missed.** promptfoo's
  `new OpenAiCompletionProvider(modelName || "gpt-4-turbo", {})` is still informational, and a test
  keeps that gap visible.

---

## Evidence

- `npm run validate:registry`: 0 violations across 163 model id records.
- `node scripts/check-pins.mjs`: OK, every release pin is `v0.5.8-alpha`.
- Root suite on the release branch, plus CI on the release PR, which includes the App's tests.
- Probes run on the release code, offline:
  - the five 2026-10-23 ids and `gpt-5` above;
  - the site's sample, `gpt-4` at `src/ai/client.ts:42`, reproduces as a verified call site,
    patch eligible, 2026-10-23 → `gpt-5.6-sol`.
