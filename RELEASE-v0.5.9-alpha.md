# v0.5.9-alpha

**The release that stops mendr calling a repository clean when it is not.** In v0.5.8-alpha, a
live call to a retiring model could leave `fix-llm` reporting no Tier A and no Tier B, and a
`--fail-on tierB` gate passing. This happened in two ways:

- A call held for review was dropped from `fix-llm`'s report, which printed "Nothing to fix".
- A request object built in a variable and then passed to the SDK call was listed only as a config
  or catalog entry (Tier C). Running mendr on public repositories found this.

This tag fixes both. It also corrects registry entries that applied wrong fixes ahead of OpenAI's
2026-10-23 shutdowns, adds Claude Sonnet 4.5's retirement, and follows two dates Google moved.

The deprecation registry moves from `sha256:079c0af585316432` (167 entries) to
`sha256:9319f3c6ea52b69d` (197 entries).

Scans with registry refresh switched on already have the registry data: `registry-publish` signed
and published it when it merged. Everything else in this release needed a tag, including the code
that sends an OpenAI fine-tune to its own registry row (section 4).

---

## What a customer gets

### 1. A request built in a variable is followed into the call

```ts
const req = { model: 'gpt-3.5-turbo', messages };
await client.chat.completions.create(req);
```

v0.5.8-alpha reported `gpt-3.5-turbo` here as a Tier C config or catalog entry, and `fix-llm`
reported 0 Tier A and 0 Tier B. The scanner now follows a request object into a provider endpoint
call (`.chat.completions.create`, `.messages.create`, `generateContent` and similar):

- **In TypeScript and JavaScript**, the object is followed when it is passed directly, through
  `??`, `||` or a ternary, or spread into the call's argument.
  - A `const` passed directly and used nowhere else, as above, is judged as if the object were
    written inline: Tier A when it can be patched, held for review when it cannot.
  - Every other form is always held for review (`surface_capped`), even where the inline call would
    be patched: `??`, `||`, a ternary, a spread, a `let`, an export, or any other use of the
    variable.
- **In Python**, a dict such as `params = {"model": ...}` unpacked with `**params` into a
  recognised SDK call is now held for review (`surface_capped`). It used to be reported as catalog
  data. It is never swapped automatically.
- **Also in Python, a client set to `None` and built later is followed.** After
  `self.client = None` and then `self.client = OpenAI()`, a call on `self.client` resolves to the
  built client. A call v0.5.8-alpha held for review is now a Tier A patch. A module-level client
  rebound through `global` is still held.

Objects that never reach a provider call stay as they were: a model-picker list, a docstring, an
object handed to the app's own code.

### 2. `fix-llm` lists every call held for review

The scanner holds some live calls back from an automatic patch. Examples are a parameter whose rule
changes on the replacement, a parameter no rule covers, a real call inside an `examples/` tree, a
gateway-prefixed id, and a wrapper class. `audit` always listed those as Tier B. In TypeScript,
`fix-llm` dropped them:

| call | `audit` | `fix-llm` in v0.5.8-alpha | `fix-llm` now |
|---|---|---|---|
| `gpt-3.5-turbo` + `max_tokens: 20` | review | "Nothing to fix" | review, `param_behaviour_change` |
| `claude-opus-4-1-20250805` + `max_tokens: 1024` | review | "Nothing to fix" | review, `coupled_param_unverified` |
| a real SDK call under `examples/` | review | "Nothing to fix" | review, `surface_capped` |

- **The first two rows were v0.5.8-alpha regressions.** Before v0.5.8-alpha both calls were Tier A
  patches. v0.5.8-alpha's parameter guard moved them to review, which `fix-llm` did not report.
- **The second row is common for Opus.** Anthropic Messages calls pass `max_tokens`. So a
  TypeScript call whose replacement is `claude-opus-4-8` lands here: Claude 2, Claude 3 Opus,
  Opus 4 and Opus 4.1. Calls that migrate to Haiku 4.5 or Sonnet 4.6 are patched as usual.
- **The fix.** `fix-llm` now lists each held model id once per call site, as `audit` does. It uses
  the same reason code and prints the scanner's own sentence for why the call is held. The held
  model id is never swapped.
- **Python now matches `audit` too.** Python held calls used to be listed under
  `usage_unverified`, with the sentence "no supported SDK call or parameter sink was found in this
  file". They now carry the reason `audit` gives them.
- **Untraced TypeScript defaults are listed.** A model const with no traced call
  (`usage_unverified`) was in `audit`'s Tier B but missing from `fix-llm`. It is now listed there
  too, with the scanner's sentence.
- `watch` was never affected.

### 3. Held calls get an honest reason, and fewer edits

- **A new reason code, `surface_capped`.** A call held for where or how it is used used to carry
  `platform_blocked`. Examples are a sample tree, a gateway-prefixed id, a wrapper class, a proxy
  or partner client, and a request made at import time.
  - `platform_blocked`'s sentence says the id "sits under a deployment key", which was false for
    all of them.
  - In `fix-llm --json`, v0.5.8-alpha left the TypeScript ones out and put the Python ones in the
    legacy `usageUnverified` array.
  - They now carry `surface_capped` in `fix-llm`, `audit` and `watch`. `platform_blocked` now means
    a value under a deployment-named key or identifier.
  - A consumer that matched `platform_blocked` to find these calls should match `surface_capped`.
  - A committed `.mendr/exposure.json` changes once on the first run after the upgrade.
- **A gateway-prefixed id keeps its record.** `openai/gpt-4-0613` used to be reported with no
  registry entry and a verdict of "unverified"; it now shows the record it matched and its verdict.
- **Fewer parameter edits inside held calls.** `fix-llm --write` and `migrate` used to rename
  `max_tokens` inside a call the same report listed as "no patch generated". They now skip the
  parameter edits they can tie to a held call. The README's "Held calls: what is and is not
  protected" says which shapes are covered and lists the ones that are not yet.
- **`migrate --only` stays within what was approved.** It used to rename parameters in calls on
  models nobody approved, held calls included. It now edits only approved model ids, and
  parameters only in the calls it swaps. This is the approval-gated Action's path.
- **Annotated files are left alone.** The parameter pass used to edit files marked
  `mendr: ignore-file` or `mendr: model-catalog`; it now skips them, as the model-id scan always
  did.

**If you gate CI on `fix-llm`, the result can change after upgrading, in either direction.**

- **`--fail-on tierB`** (or the deprecated `--fail-on blocked`):
  - A repository that passed on v0.5.8-alpha can fail now, because held calls and untraced
    TypeScript defaults are listed.
  - A repository whose only review item was a Python client set to `None` and built later can pass
    now.
- **`--fail-on tierA`:**
  - A repository whose only Tier A was a parameter edit inside a held call can pass now.
  - A repository can also fail where it passed. These are Tier A now: a request built in a variable,
    a Python client set to `None` and built later, and the three newly automatic registry entries.
- **The legacy counts move.**
  - `summary.usageUnverified` now includes the newly listed TypeScript defaults, and no longer
    includes Python held calls, which v0.5.8-alpha counted there.
  - `summary.blocked` counts only `replacement_unverified`.
  - Read `summary.tierB`.

### 4. Registry corrections before OpenAI's 2026-10-23 shutdowns

Checked on 2026-10-09 and 2026-10-10 against OpenAI's, Google's and Anthropic's own pages. OpenAI's
and Google's deprecation pages and Google's changelog, as read on 2026-10-10, are committed under
`registries/evidence/`. The model pages consulted are not.

- **Wrong fixes stopped.**
  - `gemini-2.0-flash-live-001` and `gemini-live-2.5-flash-preview` were patched to
    `gemini-3.1-flash-live-preview`, which itself shuts down on 2026-11-17. They now point at
    `gemini-3.8-live`, held for review.
  - `gpt-5.2` is removed. OpenAI does not deprecate it; it was patched automatically.
- **Suggested replacements corrected (already review only).**
  - `gpt-image-1` now suggests `gpt-image-2.5-sunburst` instead of `gpt-image-2`. OpenAI names
    `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare`.
  - `o1-preview` now suggests `gpt-5.6-sol` instead of `o1`, which itself shuts down on 2026-10-23.
- **OpenAI fine-tunes get their own date.** `ft:babbage-002:…` and `ft:davinci-002:…` were reported
  as already shut down on 2026-09-28, but OpenAI keeps fine-tunes until 2026-10-23.
  - The registry now has OpenAI's six fine-tune rows.
  - The usage audit (`usage-audit`, `audit --fixture`, `audit --runtime`) sends a fine-tune to its
    own row. Fine-tunes of `gpt-3.5-turbo-1106` move to the 2026-10-23 date too.
  - This part needs v0.5.9-alpha: a v0.5.8-alpha scan with registry refresh gets the rows but still
    reports a fine-tune under its base model.
  - A fine-tune is never swapped automatically, because the swap would drop the training.
- **30 entries added, all held for review:**
  - Google's three Veo 3.1 previews (2026-10-22);
  - Google's Live, native-audio and TTS previews (2026-11-17);
  - OpenAI's `gpt-image-1-mini`, `gpt-image-1.5` and `chatgpt-image-latest` (2026-12-01);
  - OpenAI's six fine-tune rows (2026-10-23);
  - 13 models from the monthly discovery run: OpenAI's older audio, realtime and transcription
    models, and one Gemini preview.
- **Dates and status from the provider pages.**
  - Ten past shutdowns are now marked retired.
  - 12 entries that had no shutdown date now carry the one the provider's page gives.
  - 11 entries quarantined over contradictions in their own notes were rechecked against those
    pages: three become automatic (below) and eight stay review only.
- **Automatic (Tier A) fixes, 135 before and after:**
  - Three become automatic: `gemini-2.0-flash` and `gemini-2.0-flash-001` to `gemini-3.6-flash`,
    and `gpt-4-1106-vision-preview` to `gpt-4o`. Calls on them that `fix-llm` used to hold for
    review are now patched.
  - Three stop: the two Live entries above, and the removed `gpt-5.2`.
- **Held when the provider names two replacements.** OpenAI names "gpt-5 or gpt-4.1" for
  `gpt-4-0314`, `gpt-4-0125-preview` and `gpt-4-turbo-preview`, so they stay review only.
- **Held when the provider's replacement is itself retiring.** Such an entry carries the end of
  that chain and stays review only.
  - `gemini-2.0-flash-lite` and `-001` now point at `gemini-3.5-flash-lite` instead of
    `gemini-3.1-flash-lite`.
  - `text-davinci-003` and `-002` point at `gpt-5.6-terra`, past `gpt-3.5-turbo-instruct`.

### 5. `resolve` counts only provider ids as live

`mendr resolve` uses `registries/model-catalog.json` to decide whether the end of a replacement
chain is live. That file took ids from OpenRouter as well as models.dev, and OpenRouter's ids are
its own routing names. So `claude-sonnet-4.5` and `gpt-6-sol-pro` counted as live provider ids,
although the providers' APIs take neither.

- Only models.dev's ids now make a replacement live.
- OpenRouter-only spellings are kept apart, because a call routed through OpenRouter does send them.
- The catalog also gains `claude-sonnet-5-5` and `gpt-6.1-sol`.

### 6. Claude Sonnet 4.5's retirement, held for review

`claude-sonnet-4-5-20250929` is in the registry. Anthropic retires it on **2026-11-30** and names
`claude-sonnet-5-5` as the replacement. Every call site is **review only**, never patched
automatically:

- Anthropic's Sonnet 5.5 migration guide names settings Sonnet 4.5 accepts that return a 400 error
  on Sonnet 5.5: thinking budgets, sampling parameters, assistant prefill, forced tool choice, and
  thinking type "disabled".
- It also says thinking runs by default, so code that reads `content[0].text` breaks.
- Sonnet 4.5 still works until then, so a bad automatic swap would break code that works today.

`mendr evidence claude-sonnet-4-5-20250929` prints the reason in full. The bare alias
`claude-sonnet-4-5` has no entry, because Anthropic's deprecations page does not name it.

### 7. Two Google dates follow Google

Google moved both shutdowns later. v0.5.8-alpha reports these live models as already past
retirement. Both columns below were run on 2026-10-10:

| model | v0.5.8-alpha says | v0.5.9-alpha says |
|---|---|---|
| `gemini-omni-flash-preview` | "10d OVERDUE" (2026-09-30) | "12d left" (**2026-10-22**) |
| `gemini-2.5-flash-image` | "8d OVERDUE" (2026-10-02) | "156d left" (**2027-03-15**) |

For `gemini-2.5-flash-image`, the replacement is now `gemini-3.1-flash-lite-image`, the one Google's
table names. Both entries stay review only.

### 8. Smaller fixes

- **A deploy template is labelled as one.**
  - `.env.template`, `.env.example`, `*.example.yaml` and similar files now read "config template a
    new install copies" on their own line.
  - `audit --json` gives them the role `config_template` instead of `test_fixture`.
  - The report's summary sentence still groups them with test, fixture or sample data.
  - Their tier is unchanged (C).
- **Token counts are no longer redacted.**
  - The secret redactor rewrote lines such as `max_tokens: config.max_tokens || 1024` as
    `max_tokens=***REDACTED*** || 1024`.
  - A token count (`max_tokens`, `maxOutputTokens`, `budget_tokens`) is now kept.
  - `ACCESS_TOKENS`, `ADMIN_TOKENS`, and names ending in a singular `TOKEN` (`GITHUB_TOKEN`,
    `OUTPUT_TOKEN`) are still redacted.
  - The GitHub App carries the same rule. It was deployed when the fix merged to main, not by this
    tag.

### 9. The rollback floor moves

The bundled registry was stamped at 2026-10-10T19:10:26Z, right before the tag. A downloaded
snapshot published before that is refused. The bundled registry grades fresh for 14 days from the
stamp, through the 2026-10-22 and 2026-10-23 shutdowns.

---

## Upgrading

- **CLI:** `npx github:ajitheee/mendr#v0.5.9-alpha audit .`
- **Audit workflow:** set the repository variable `MENDR_SPEC=v0.5.9-alpha`. No workflow edit is
  needed.
- **Migrate workflow: a workflow edit is required.**
  - On the `uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@…` line, change the ref
    (`v0.5.8-alpha`, or the commit SHA you pinned) to `v0.5.9-alpha`.
  - If you used the one-click setup, that line is in the `migrate` job of `mendr-audit.yml`. Only
    repositories connected before the one-click setup have a separate `mendr-migrate.yml`.
  - You can also re-run the one-click setup.
  - `reusable-migrate.yml` cannot honour `MENDR_SPEC`, because GitHub forbids an expression in
    `uses:`.
- **Open audit issue:** on the first run after the upgrade, each finding in a config template
  (`.env.template`, `.env.example`, `*.example.yaml`) shows once as resolved and once as new,
  because its role changed.

---

## Corrections to v0.5.8-alpha's notes

- **"The edit is still written when a person approves it" was false.** No command swaps the model
  id of a held call, approved or not (`migrate --only` included). A person makes that change by
  hand.
- **Calls that v0.5.8-alpha said need review, or "are now reported", were listed only by `audit`
  in TypeScript.** This covers both the calls its parameter guard moved to review and its three
  newly reported call shapes. `fix-llm` dropped them (section 2 above).

---

## Known issues

- **`migrate` and the Action don't disclose held calls, and this release makes that more
  frequent.**
  - If a repository's only findings are held calls, `migrate` reports no migration, and the Action
    reports the repository clean and closes an open Mendr pull request.
  - In v0.5.8-alpha, `migrate` renamed `max_tokens` inside some of those held calls, an edit its
    own report said it would not make. That edit at least kept the repository from being reported
    clean. Those repositories now get no migration.
  - Read `audit` for the full list until the follow-up lands.
- **A Tier A swap can leave a request the replacement rejects, or change it without review.** The
  review check runs only when the model is a string literal written in the request itself.
  - A model that comes through a `const`, or sits behind an `as const` cast, is swapped as Tier A.
  - With `model: MODEL`, `max_tokens` is renamed, but the call skips the review its inline form
    gets.
  - With shorthand `{ model }`, an `as` cast, or a quoted `'max_tokens'` key beside a const model,
    `max_tokens` is kept, although the registry's own rule says `gpt-5.6` needs
    `max_completion_tokens`. Example: `const model = 'gpt-4-0613'; create({ model, max_tokens })`
    is swapped to `gpt-5.6-sol` with `max_tokens` kept. The inline form of the same call is held
    for review.
  - Check these calls by hand after a swap.
- **In Python, a Tier A swap never checks or edits parameters.** Python has no parameter guard and
  no parameter pass, and the held rows in section 2 are TypeScript only. Check Python swaps by hand.
  - `create(model="gpt-3.5-turbo", max_tokens=20)` is swapped to `gpt-5.6-terra` with `max_tokens`
    kept.
  - A Claude Opus 4.1 call with `temperature` is swapped to `claude-opus-4-8` with `temperature`
    kept.
  - The registry's own rules say the replacement rejects both requests.
- **Held-call shapes the parameter guard cannot tie yet** are listed in the README ("Held calls:
  what is and is not protected"). Examples:
  - the held id under shorthand `{ model }`, `this.model`, or a model-like key other than `model`;
  - a request built in a variable whose model is not a literal written in that object
    (`const req = { model: MODEL, … }`);
  - a second, unheld model value inside a held call, which can still be swapped.
- **Some live calls are still reported as data (Tier C).** Read the Tier C list for ids you know are
  called. Examples:
  - a config object read through a property path (`config.integrations.chatGPT.model`);
  - a request body built in a variable and then passed through `JSON.stringify` to a raw `fetch`;
  - a runtime fallback returned from a helper (`return process.env.MODEL ?? "o4-mini"`) and passed
    as `model: pickModel()`;
  - a positional constructor argument, such as promptfoo's
    `new OpenAiCompletionProvider(modelName || "gpt-4-turbo", {})`.
- **OpenAI fine-tune ids written in source code are not located.** A repository whose only calls
  use `ft:…` ids audits as no exposure. The usage audit reports the fine-tunes it observes.
- **In TypeScript, Anthropic's `max_tokens` is treated as model-dependent when the replacement is
  `claude-opus-4-8`,** the family the sampling rules name. So a call to Claude 2, Claude 3 Opus,
  Opus 4 or Opus 4.1 that passes `max_tokens` goes to review rather than being patched.
- **The rule that sampling parameters return a 400 does not yet cover `claude-sonnet-5-5`.** The
  2026-11-30 Sonnet 4.5 entry is review only, so nothing is patched automatically. A person
  approving that swap by hand should drop `temperature`, `top_p` and `top_k`, as Anthropic's guide
  says.
- **A Live API entry can become automatic later.**
  - `gemini-2.0-flash-live-001`, `gemini-live-2.5-flash-preview` and
    `gemini-3.1-flash-live-preview` are held only because models.dev does not list
    `gemini-3.8-live` yet.
  - Once it does, a maintainer re-stamps them with `mendr verify-registry --write`.
  - They become automatic fixes when that change merges and is published. Nothing re-stamps them by
    itself.
- **Not yet in the registry:**
  - `deep-research-pro-preview-12-2025`, which shuts down on 2026-10-23 and is passed as an
    `agent` value the scanner does not read as a model call;
  - OpenAI's later retirements: `gpt-5.1`, `gpt-5.3-codex` and `gpt-5.4-nano` (2027-04-01);
    `tts-1`, `tts-1-hd` and the two `gpt-4o-mini-tts` snapshots (2027-01-06); `whisper-1` and the
    `gpt-4o-transcribe` family (2027-02-26). Calls to them get no finding;
  - nine retired models from the monthly discovery run that the review accepted but the gate
    refused, still queued.
- **`fix-llm`'s Tier A count can be lower than the edits `--write` applies,** because it locates
  parameter sites before the swap.
- **`migrate --skip-verify` can run out of memory at Node's default heap on very large
  repositories.**
- **A registry with two records for one model id can be handled two ways.** None ships, but one is
  possible through `MENDR_REGISTRY_FILE`. Then `audit` can hold the id under one record while
  `migrate` swaps it under the other. `fix-llm` reads only the bundled registry.
- **Some report wording is still wrong.** The reason codes and tiers are right.
  - `audit`'s human report calls a held proxy call "a code default or call not traced to a provider
    request".
  - In an example tree, a non-provider call such as an Express `res.json({ model: … })` is printed
    with the rule "the id is passed to a real provider request here".
  - The `platform_blocked` sentence says "deployment key" where the scanner also matches a
    deployment-named variable.
  - In Python, an untraced constant in a file that does make a supported SDK call still prints "no
    supported SDK call or parameter sink was found in this file".
- **A Tier B call with an unverified replacement still gets parameter edits.** For
  `replacement_unverified`, the finding says "no patch generated" for the model id. But
  `fix-llm --write` and `migrate` can still rename a parameter in that call's request (for example
  `max_tokens` on `o1-mini`).
- **`satisfies` or `<T>` around a model value or a call's argument, or `as any` on the argument,
  can hide the call from the scanner.** A proxy call written that way is then reported as data or
  untraced, not held, and its parameters can be edited.
- **A gateway-prefixed const imported from another file** does not hold the calls that use it: the
  scanner links a const to its consumers within one file.
- **The parameter pass has no surface rules of its own.** A sample or proxy call on a model that is
  not retiring is not held, and a parameter rule can still apply to it.
- **A gateway-prefixed id loses its record in `fix-llm`** when it sits behind an `as` cast
  (`type_cast_masked`), and shows as unverified; `audit` names the record.
- **In Python, a file that names a local proxy host holds every client in it.** A direct SDK call
  in such a file is held for review (`surface_capped`), and the reason names the host. TypeScript
  has no such rule.
- **A variable named exactly `TOKEN` is not redacted.** It never was.

---

## Evidence

All run on the release tree (`release/v0.5.9-alpha`, main at `307cb6e` plus the stamp) on
2026-10-10.

- **Version pins:** `node scripts/check-pins.mjs` reports OK, with the release pins at `v0.5.9-alpha`.
- **Registry format:** `npm run validate:registry` reports 0 violations across 193 model-id
  records (197 entries).
- **Dates against the live pages:** `mendr check-dates` reports 153 confirmed, 0 failing, 21
  inferred from a stated snapshot (past dates only), and 19 not judged. `mendr check-rules`
  confirms 8 of 8 quoted sentences.
- **Tests:** the full suite on the stamped tree passes, 1843 tests in 109 files.
- **Release-build probes** (`fix-llm --offline --skip-gates` and `audit --offline` on a scratch
  project):
  - `const req = { model: 'gpt-3.5-turbo', … }; create(req)` is a Tier A swap to `gpt-5.6-terra`.
  - `gemini-2.0-flash` is a Tier A swap to `gemini-3.6-flash`.
  - `gpt-5.2` gives no finding.
  - `gemini-omni-flash-preview` shows 12d left and `gemini-2.5-flash-image` 156d left.
  - The bundled registry grades `fresh, 0 d`.
- **Review:** three independent checks compared every claim in these notes with the release
  build, the registry and v0.5.8-alpha. Their corrections are applied.
