# Scanner measurement — twelve repositories, 2026-09-28

The build order locked this slice on 2026-09-15:

> **3. Scanner measurement: the 12-repo harness against the shipped artifact, publishing
> precision, recall, skipped files and before/after.**

It was recorded as shipped. It was not. `scripts/tier-probe.mjs` classifies one snippet; no
precision or recall number had ever been published for this scanner. This is the first.

---

## The headline

Two runs, same twelve repositories, **same commits**, same definitions. Run 1 is the baseline;
run 2 followed two recall fixes made the same day. Only the scanner changed between them.

| | run 1 — baseline | run 2 — after the recall fixes |
|---|---|---|
| Repositories scanned | 12 of 12 | 12 of 12 |
| True positives | 29 | **44** |
| False positives | **2** | **6** |
| False negatives | **49** | **36** |
| **Precision** | **93.5 %** | **88.0 %** |
| **Recall** | **37.2 %** | **55.0 %** |

> **Every number in the table above is wrong, and corrected in "Run 3" at the end of this
> document.** litellm's per-repo row was counted in a different unit from the other eleven, so
> it contributes 3 findings where it should contribute 12. Corrected: run 1 precision 94.7 %,
> run 2 precision 89.8 %. The table is left as published so the error is visible rather than
> quietly rewritten. The direction of every conclusion below survives it — run 2 still breached
> the 90 % floor.

**Run 1: the error budget was almost entirely on the recall side, which is the dangerous
direction.** A noisy review is an annoyance. A missed live call is an outage.

**Run 2: recall +17.8 points, precision −5.5 — and precision now sits below the 90 % floor
this document set for itself.** That breach is recorded in full further down rather than
rounded away, and the keep-or-revert decision it forces is written up rather than taken.

This inverts the assumption the work was queued on. The plan's P1-G3 was *"call-site-aware
detection — a free Semgrep rule beats Mendr on precision until this is fixed."* Precision was
never the problem.

## Method

Twelve public repositories, shallow-cloned and scanned with the built artifact on `main`
(`node dist/cli.js audit <dir> --json`). Six agents, two repositories each.

**Every actionable finding was read in its source file.** Classifying by path is the shortcut
being measured, so classifying by path would have measured nothing. False negatives were found
by sweeping every registry id across the repository and checking whether a live call site had
been reported only as `monitor`, or not at all.

**Definitions, stated because they decide the numbers.** A *false positive* is an ACTIONABLE
finding at a location that is not a live model selection — a changelog, a README, a test
fixture, a commented line, a type union, a migration guide; something that would not break at
retirement. `monitor` findings are **not** counted as false positives even when they sit in
documentation: that is precisely what the bucket is for, and counting them would rig the
measurement against Mendr's own design.

TP / FP / FN per repository, both runs. Bold marks a row that moved.

| repo | run 1 | run 2 | what changed |
|---|---|---|---|
| chroma | 2 / 0 / 4 | **4 / 0 / 2** | two sample-app call sites recovered |
| fast-agent | 2 / 0 / 2 | 2 / 0 / 2 | — |
| guardrails | 1 / 0 / 0 | 1 / 0 / 0 | — |
| langgraph | 0 / 0 / 4 | **4 / 0 / 0** | the false clean is gone |
| librechat | 5 / 2 / 0 | 5 / 2 / 0 | — (its 2 FPs are pre-existing) |
| litellm | 2 / 0 / 2 | **3 / 0 / 2** | a cookbook script recovered |
| llama_index | 0 / 0 / 1 | 0 / 0 / 1 | — (its miss is the positional form) |
| openai-cookbook | 0 / 0 / **32** | **7 / 0 / 25** | 0 actionable → 7 |
| paper2code | 5 / 0 / 2 | 5 / 0 / 2 | — |
| promptfoo | 3 / 0 / 2 | **4 / 4 / 2** | +1 real, **+4 false** |
| sodaverse | 4 / 0 / 0 | 4 / 0 / 0 | — |
| tinytroupe | 5 / 0 / 0 | 5 / 0 / 0 | — |

**Seven of twelve are bit-for-bit identical between runs** — same conclusion, same investigation
count, same `file:line:disposition:tier` on every location, verified programmatically against
the run-1 JSON. A narrow fix should change only what it targeted, and it did.

Every regression is in **one repository, in one shape**. Every recovery is a live call site.

---

## What is genuinely good, and should be the claim

**The `monitor` bucket carried 402 findings and did it correctly.** Across nine of twelve
repositories there were zero false positives at either the finding or the location level. It
stayed silent on the cases a grep-based competitor flags: `tiktoken.encoding_for_model(
"gpt-3.5-turbo")`, `encoding_for_model`, pricing tables, commented-out Helm values
(`helm/librechat/values.yaml:101-106`), recorded response fixtures, model-picker lists, and
mkdocs `!!! example` blocks.

**Coverage is disclosed honestly and unprompted.** Every run printed its unanalyzed languages
and file counts. One agent checked the largest gap it was told about — chroma's 723 unread Rust
files, including a whole Anthropic agent subsystem — and found zero real retiring ids there.

**The highest-value pattern is caught reliably.** `process.env.X || 'hardcoded-model'` was
actionable every time. It looks configurable and ships a retiring default, and it is exactly
what a grep misreads.

So **"Mendr does not cry wolf" is an earned claim with evidence behind it.**
**"Mendr finds everything" is not, and must not be said.**

---

## Why recall is 37 %

Three causes, each proven by a controlled probe rather than inferred.

### 1. The blanket `examples/` rule — the single largest cause

Rule C3 forced any file under a path segment named `examples`, `samples`, `demos`, `docs`,
`cookbook`, `playground` or `benchmarks` to informational **regardless of what the code did**.
`src/usage/scanLiterals.ts` did not even collect call sinks for such a file, so the parser
never got a chance.

Proof it was the rule and not the parser: copying langgraph's
`libs/cli/examples/graphs/agent.py` into `src/` produced a correct selector classification from
the same parser. The analysis was already right; the path rule discarded it.

What it cost:

- **langgraph** — `libs/cli/examples/graphs/agent.py:14` constructs `ChatAnthropic(model_name=
  "claude-3-sonnet-20240229")` and is a **registered graph entrypoint** via `langgraph.json`.
  Mendr printed **`NO EXPOSURE IN COMPLETED SURFACES`** on that repository. That is a false
  clean, and it is falsifiable by anyone who runs it.
- **chroma** — three of five live sites, including a Next.js `POST` route handler in
  `sample_apps/movies/`.
- **openai-cookbook** — most of its 32 misses: evaluation harnesses whose
  `DEFAULT_JUDGE_MODEL = "gpt-5.2"` is wired to a real `client.responses.create`.

**Fixed 2026-09-28**, and narrowed rather than removed: an example whose id reaches a real
provider request is now reported and **capped at review**, never Tier A. Everything the parser
reads as data in an example — a picker list, a pricing table, a docstring, a commented line —
stays informational, which is the precision the rule was written to protect.

### 2. Selector recognition is keyed to known SDK symbols

`src/python/sinks.ts` recognises a live call only by a qualified, endpoint-specific first-party
callee suffix (`chat.completions.create`, `messages.create`, `models.generate_content`). A
model selection made through a **first-party wrapper class** is invisible.

Probe: `client.chat.completions.create({ model: 'gpt-4-turbo' })` scores tier A; the same call
behind `new OpenAiChat(...)` scores nothing. This is why promptfoo's
`new OpenAiCompletionProvider(modelName || configuredModel || 'gpt-3.5-turbo-instruct')` was
missed — a real fallback default for a real provider.

**Not fixed.** It is the largest remaining recall gap.

### 3. Smaller, proven causes

- **A `?param=value` suffix on the model string defeats the matcher entirely** (fixture-proven).
- **Shell scripts are never read.** For paper2code the shell script *is* the entrypoint —
  `README` says `bash run.sh`, and `scripts/run.sh:3` sets `GPT_VERSION="o3-mini"` with no
  Python-side default. Honestly disclosed as unanalyzed, and still a miss.
- **The same shape gets two answers.** A model-named keyword default in a Python signature is a
  tier-B selector; a model literal in a constructor keyword argument is not.

---

## Bugs found in passing

1. **`locations[].file` mixes repo-relative and absolute paths inside one JSON document.**
   33 of ~75 fast-agent files came back as absolute Windows scratch paths. Anything parsing the
   JSON must normalise two shapes. **Not fixed.**
2. **The test-file filter is name-based, not location-based.** Both false positives share this
   cause: `api/app/clients/specs/FakeClient.js` sits in a `specs/` directory without matching
   `*.spec.js`, so a test double — whose only importer is a test — was reported as live code,
   despite `testFilesSkipped: 2000`. **Not fixed.**
3. **`git clone --depth 1` fails checkout on Windows long paths while still exiting 0.** Several
   repositories would have silently under-scanned and reported clean. The harness needs
   `git -c core.longpaths=true clone`. Caught by the agents mid-run.

## One thing this measurement does NOT cover

Whether the registry is *right*. Three of librechat's five true positives are image models
(`dall-e-3`, `gpt-image-1`, `gemini-2.5-flash-image`); chroma's only actionable finding rests
entirely on `gemini-embedding-001`. Those locations are correct — the id really is selected
there — but whether those entries belong in the registry is a separate audit. If an entry is
wrong, the precision a user *experiences* is lower than 93.5 % even though every location is
right.

---

## What this changes

**Do not build P1-G3 as scoped.** "Reduce false positives" solves a problem that does not
exist at 93.5 % precision, and would risk the one number that is genuinely good.

**Recall is the work.** In order of measured cost: the `examples/` rule (done), wrapper-class
recognition (open), shell scripts (open), the `?param` suffix (open).

**Re-run this after each recall change.** The number to defend is precision ≥ 90 % while recall
climbs. A recall fix that drops precision below that has traded the strong claim for the weak
one.

---

# Re-measured 2026-09-28, after the two recall fixes

Same twelve repositories, **same commits** (`librechat@c8c5478`, `langgraph@07b3318`, …), same
definitions, same clones. Only the scanner changed, so this is a controlled before/after rather
than a fresh sample.

**Recall +17.8 points. Precision −5.5 points, and it breaks the floor this document set.**
The numbers are in the headline table; what follows is why they moved.

## The floor was breached, and that is recorded rather than rounded

The closing line of the original write-up reads: *"The number to defend is precision >= 90%
while recall climbs. A recall fix that drops precision below that has traded the strong claim
for the weak one."* 88.0 % is below 90 %. Stating it plainly because the alternative — quietly
moving the bar after seeing the result — is the failure this file exists to prevent.

## Where it moved

The per-repository breakdown is in the headline table above, so it is not repeated here.

**langgraph's false clean is gone.** It reported `NO EXPOSURE IN COMPLETED SURFACES` while a
registered graph entrypoint constructed a retiring model. It now reports four, at review.

## Every new false positive is one shape, in one repository

All four are `causedByTheFix`, all in promptfoo, all the same thing: a `model:` key inside a
**simulated** provider under `examples/`.

- `examples/integration-opentelemetry/javascript/provider-simple-traced.js:143, :266, :311` —
  OpenTelemetry **span attributes** (`'model.name': 'gpt-3.5-turbo'`). The whole 415-line file
  has no fetch, no SDK and no network call; the responses are hardcoded template literals.
- `examples/redteam-tracing-example/server.js:234` — a field in a mock server's own fabricated
  HTTP response body. The only outbound request in the file is to an OTLP trace endpoint.

**The fix did not create this imprecision; it revealed it.** Those same lines would have been
reported in `src/` before today. The blanket example rule was acting as a crude precision
backstop over a real weakness: **Mendr cannot tell a mock provider from a live one.** A
telemetry span that merely *records* which model was used, and a stub that *fabricates* a
response, both look like a `model:` argument to a call.

That is the next recall/precision slice, and it is worth more than the four findings here: the
same blindness will report a customer's own test doubles and observability wrappers. It is also
the cause of librechat's two pre-existing false positives (a jest `FakeClient`, and a `model:`
field the server destructures and discards) — so **one fix retires six of the six**.

> ### CORRECTION, same day, before the slice was built
>
> **"One fix retires six of the six" was wrong, and "Mendr cannot tell a mock provider from a
> live one" was the wrong diagnosis.** Both sentences above were written from reading the
> findings, not from reproducing them. Reproducing them first — which is what the next slice
> actually started with — gave four different causes for the six:
>
> | # | finding | what the scanner actually said | cause |
> |---|---|---|---|
> | 1–3 | promptfoo `provider-simple-traced.js:143,:266,:311` | `unknown_wrapper: runInSpan (undeclared)` | `declarationsOf` never collected **function declarations**, so a helper declared at line 39 of the same file read as unresolvable |
> | 4 | promptfoo `server.js:234` | `unknown_wrapper: res (Parameter)` | a call on an injected parameter; the file has a real `fetch` at line 88 |
> | 5 | librechat `FakeClient.js:33` | default-configuration object | the name-based test-file filter — **bug #2 above**, already written up |
> | 6 | librechat `EditMessage.tsx:145` | `unknown_wrapper` | a React Query `mutateAsync` to librechat's **own** API, not a provider |
>
> No single rule spans those. "Mock vs live provider" describes #4 and #5 loosely and #1–3 not
> at all: a span attribute is not a mock of anything, it is a recording. The slice that follows
> fixes #1–3 only, and takes precision to **93.6 %**, not ~100 %.
>
> The general lesson is the one this document already records against the video work: a
> diagnosis written from a summary is a guess. Four of these six had never been opened in their
> source file when the sentence "one fix retires six of the six" was written.

## The decision this forces

Reverting restores 93.5 % precision and puts back a **false clean on langgraph** — the answer
`tsGuards.test.ts` calls "the one answer this product must never give". Keeping it accepts four
review-queue entries in one repository's telemetry examples, none of them `patch`, so nothing
auto-applies.

Thirteen additional live call sites found, against four extra review items in mock files, is
the right trade on the merits. But it is a product judgement and the floor was set in writing,
so it belongs to the founder rather than to whoever happened to run the measurement.

## Unchanged from the baseline

- The **positional constructor form** is still missed (`new P(m || "gpt-4", {})`), asserted by
  a test so it stays visible. It is llama_index's remaining miss.
- Shell scripts are still unread; paper2code's entrypoint is `bash run.sh`.
- The `?param=value` suffix still defeats the matcher.
- Whether the **registry** is right remains a separate audit: three of librechat's true
  positives are image models, and tinytroupe's rest on `gpt-5-mini`, flagged unverified.

---

# Run 3 — the local-helper fix, and a counting defect in the table above

Same twelve repositories, same commits. One scanner change, described below. Written the same
day as runs 1 and 2, after the correction box earlier in this document replaced the diagnosis
the slice had been queued on.

## What changed in the scanner

`declarationsOf` in `src/usage/tsSurface.ts` resolved identifiers syntactically by collecting
import bindings, variable declarations, parameters and class properties — **and never function
declarations.** So `runInSpan`, declared at line 39 of promptfoo's own telemetry file and called
100 lines below, resolved to `unknown_wrapper (undeclared)`: the same verdict an unresolvable
provider wrapper earns, and a review-queue entry either way.

Collecting the declaration is only half the fix. A local function still resolves to no provider,
so the reason string improved and the tier did not. The other half is the first and only
**demotion** in a file whose header says "Nothing here can promote; it can only refuse to
promote": a helper declared in this file, in a file that can reach no provider, records a model
id rather than selecting one.

Three guards decide "can reach no provider", all lexical, all verified by mutation — each one
was broken on purpose and the test that should fail did:

1. every module the file imports is telemetry or the standard library. An **allowlist**, because
   `langchain`, `litellm`, `openrouter` and a relative `./llm` all reach a provider without
   naming one, so "not a first-party SDK" is not "inert";
2. no call in the file puts bytes on the wire;
3. no call in the file has a provider endpoint or model-factory shape.

**Guard 3 exists because the first version of this rule shipped a false clean.** A file with no
imports at all passes guard 1 vacuously, so this was demoted to informational:

```ts
export function ask(client: any, opts: any) { return client.chat.completions.create(opts); }
export function go(client: any) { return ask(client, { model: 'gpt-4', messages: [] }); }
```

A real OpenAI request, reported as data. It was found by probing the rule against a shape the
measurement did not contain, before relying on it, and it is now a regression test. The
measurement set is not a substitute for adversarial probing: nothing in twelve repositories
would have caught it.

## Result: eleven of twelve bit-for-bit identical

Every actionable location in every repository, compared as
`model|file:line -> role|tier|disposition`, plus the conclusion:

| repo | run 2 → run 3 |
|---|---|
| chroma, fast-agent, guardrails, langgraph, librechat, litellm, llama_index, openai-cookbook, paper2code, sodaverse, tinytroupe | **identical** |
| promptfoo | 8 actionable → **5** |

The three removed are exactly the three targeted:

```
- gpt-3.5-turbo  examples/integration-opentelemetry/javascript/provider-simple-traced.js:143
- gpt-4          examples/integration-opentelemetry/javascript/provider-simple-traced.js:266
- gpt-4          examples/integration-opentelemetry/javascript/provider-simple-traced.js:311
```

promptfoo's fourth false positive — `examples/redteam-tracing-example/server.js:234`, a mock
server's fabricated response body — is **deliberately unchanged**: that file has a real `fetch`
at line 88, so guard 2 refuses it. librechat's two are unchanged for the reasons in the
correction box: a test double the name-based filter misses, and a React Query mutation to
librechat's own API.

Conclusions are unchanged everywhere, promptfoo included — it still reports `EXPOSURE DETECTED`
on its four real findings. Nothing was silently dropped: the three demoted lines are still
reported, as informational references.

The run spanned two builds of the scanner. Re-running chroma, librechat and promptfoo against
the final build produced **byte-identical JSON** once `generatedAt`/`sha` are excluded, so the
rebuild is proven non-semantic rather than assumed to be.

## The counting defect: litellm's row is in different units

Restating the headline precision figure meant recomputing it, and it does not reconcile.
**Eleven of the twelve per-repo rows above count actionable LOCATIONS. litellm's row counts
distinct MODELS.** Checked mechanically against both counts:

| repo | recorded TP+FP | actionable locations | distinct models | unit |
|---|---|---|---|---|
| litellm | 3 | **12** | **3** | model |
| chroma, langgraph, librechat, openai-cookbook, paper2code, promptfoo, tinytroupe | — | matches | fewer | **location** |
| fast-agent, guardrails, llama_index, sodaverse | — | matches | matches | either (equal) |

litellm therefore contributes 3 where it should contribute 12 in run 2, and 2 where it should
contribute 9 in run 1. **Every published precision and recall number in this document is wrong.**

Correcting the row, and carrying its own `0 FP` verdict:

| | run 1 | run 2 | run 3 (this fix) |
|---|---|---|---|
| True positives | 29 → **36** | 44 → **53** | **53** |
| False positives | 2 | 6 | **3** |
| False negatives | 49 | 36 | 36 |
| Precision | 93.5 % → **94.7 %** | 88.0 % → **89.8 %** | **94.6 %** |
| Recall | 37.2 % → **42.4 %** | 55.0 % → **59.6 %** | **59.6 %** |

**This is stated as conditional, not settled.** It assumes litellm's 12 locations (9 in run 1)
are all true positives. The row asserts zero false positives, but that verdict was reached per
model, so **nine locations in run 1 and twelve in run 2 were never individually read in source**
— which is precisely the shortcut the Method section said it was not taking. Reading those
twelve is the work that settles the table, and it is not part of this slice.

What does not change either way:

- **The floor was still breached.** Corrected run-2 precision is 89.8 %, under the 90 % this
  document set for itself. The keep-or-revert decision stood on a real breach.
- **This fix clears it.** 94.6 % is above the floor, with recall unmoved at 59.6 %.
- Both corrected precision figures are *higher* than published, so nothing here was flattered.

## Two defects found in passing and not fixed

4. **The report never says why a reference was demoted.** The scanner computes a specific reason
   for every informational demotion — `TS_EXAMPLE_REASON`, `PY_EXAMPLE_REASON` and the new
   `TS_NOT_PROVIDER_REASON` — and `auditReport.ts` prints only the generic role label, "code
   data reference". "It is under `examples/`" explains itself from the path Mendr already
   prints; a reachability judgement about a file in `src/` does not. The one rule that can
   demote is the least legible, and the comment at the render site already says a reader "must
   be able to see WHY". Carrying the text needs a new field on `LocationRef`, which changes the
   `--json` shape this document's own harness parses. **Not fixed.**
5. **`src/gates/runTests.test.ts` has no explicit timeouts — a thin margin, not a live defect.**
   All 16 tests run on vitest's 5 s default. 4 of them failed here and passed in isolation,
   which looked like the defect that blocked v0.5.7-alpha (`--write with --skip-verify` carried
   the 5 s default while its four siblings had `}, 120_000)`).

   **It was not. The cause was this session's own CPU contention:** the full suite was running
   while twelve repository audits ran in the background. CI on this branch ran `build-and-test`
   twice, green at 5 m 13 s and 5 m 29 s, on a smaller runner than this machine. So the claim
   that it "will produce a phantom red release gate" — written before that evidence existed —
   is withdrawn. Giving those tests explicit timeouts is still worth doing, because they spawn
   real subprocesses on a 5 s budget, but it is a margin question and not urgent. **Not fixed.**

   Recorded because the mistake is the same one this document opens with: a cause asserted from
   a symptom without checking the cheap alternative explanation.

---

# Run 5 — the coupled-parameter guard, and a case the corpus does not contain

2026-09-29. One scanner change. **Twelve of twelve repositories bit-for-bit identical, and that
is the point of the entry.**

## What it fixes

A `model_id` record says which id to put there. It says nothing about the REQUEST around the id,
and a model swap can change which parameters the provider accepts. Found while preparing a
one-line fix for a real call site in a public repository — LibreChat,
`api/server/services/Endpoints/assistants/title.js:25`:

```js
openai.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [...],
  temperature: 0.7,
  max_tokens: 20,
})
```

OpenAI's deprecations page maps `gpt-3.5-turbo` → `gpt-5.6-terra` (fetched 2026-09-29, announced
2026-04-22). That replacement is a reasoning model, and reasoning models reject **both** of the
remaining parameters:

| parameter | what the replacement does | did Mendr handle it? |
|---|---|---|
| `max_tokens` | must be `max_completion_tokens` | **yes** — the registry has a `param_rename` whose `on_models` covers `gpt-5.6`, and the fix pass runs AFTER the id swap so it sees the new model. This half was already right. |
| `temperature: 0.7` | rejected: *"Only the default (1) value is supported"* | **no** — the registry's three `param_removal` entries are all Anthropic Opus. Nothing touched it. |

Reproduced before the guard existed: `Decision: PATCH ELIGIBLE`, tier A, *"safe automatic
patch"*, and a diff that swapped the id, renamed `max_tokens`, and left `temperature` in place —
**a call that still fails at runtime.** It escaped only because the fixture had no `openai`
package, so the required type-check gate went inconclusive and refused to write. In a real
checkout that gate passes — a model id is just a string to `tsc` — and Mendr applies it.

**The defect in one sentence: absence of a rule was being treated as absence of a problem.**

## The invariant, and how it is enforced

A model-id replacement is not safe until coupled parameters and behavioural compatibility are
validated. Where no authoritative rule covers a parameter the replacement's family constrains,
the finding **requires review** rather than producing an automatic patch.

The guard is driven by the registry, not by a hand-kept list of model families, so it cannot
drift from the data (`src/usage/coupledParams.ts`):

1. Does the **replacement** fall under any param rule's `on_models`? If no rule anywhere
   constrains a family it belongs to, nothing is known to be constrained about it and the guard
   says nothing. This is what stops it firing on every call site that sets `temperature`.
2. If it does, every model-dependent parameter at the call site must be covered by a real rule
   for that provider and that model. Any that is not is named, and the finding drops to review.

Both halves are mutation-tested: disabling (1) makes the narrowness test fail, disabling (2)
makes the defect tests fail.

The finding also got its own Tier B reason code, `coupled_param_unverified`, because reusing
`platform_blocked` printed *"deployment-alias"* and *"code default or call not traced to a
provider request"* — sending the reviewer to look for an Azure key that is not there and to
re-check a call site that was never in doubt. It now reads:

```
Location: src/title.ts:6 - verified provider SDK call site; request parameters unverified
                           for the replacement (review)
Decision: REVIEW REQUIRED
Reason:   Located at a verified provider SDK call site whose request passes a parameter the
          replacement gpt-5.6-terra may not accept, with no migration rule covering it
          (the call site is proven; the request around it is not).
```

## The result, and why zero movement is the honest headline

| | run 3 | run 5 |
|---|---|---|
| Repositories identical | — | **12 of 12** |
| Actionable locations changed | — | **0** |
| Precision | 94.6 % | **94.6 %** |
| Recall | 59.6 % | **59.6 %** |

**The guard fires on none of the twelve repositories.** No Tier A finding in the corpus has a
replacement in a constrained family AND passes a model-dependent parameter. So this entry reports
no precision or recall movement at all, and that is worth stating plainly rather than dressing up:

**the measurement set did not contain the case.** It was found in a real third-party repository
while preparing an unrelated patch. That is the second time in two days that the twelve-repo
corpus missed a defect an outside shape exposed — the first was the false clean caught by probing
an injected client. Twelve repositories is a floor, not a proof, and a green diff across all of
them means "nothing regressed", never "nothing is wrong".

Full suite 1524/1524. The measurement spanned two builds; re-running chroma, librechat and
promptfoo against the final one produced byte-identical JSON, so the rebuild is proven
non-semantic rather than assumed.

## A defect found next to it, pre-existing, not fixed

6. **`fix-llm` reports nothing for a `surface_capped` finding.** On a repository whose only
   finding is Tier B, `audit` says *"1 needs human review"* and `fix-llm` says **"No deprecated
   LLM model ids or model-coupled params found. Nothing to fix."** with `unique occurrences: 0`.
   Confirmed pre-existing on a clean tree with a module-level call, which has classified as
   `surface_capped` for far longer than this guard has existed. `fix-llm`'s own header promises a
   Tier B count, and for this whole position it is silently always zero — the same two-surface
   drift that `classifyOccurrence.ts` was created to end. This change makes it **wider**: the
   coupled-parameter cap is now another shape that lands in that blind spot. Safety is unaffected
   — refusing to offer the patch is correct — but "Nothing to fix" is the wrong words for it.
   **Not fixed.**

   *Fixed 2026-10-07 in [PR #47](https://github.com/ajitheee/mendr/pull/47) (`138181f`):
   `fix-llm` lists every held call in Tier B with the reason `audit` gives it, and
   `--fail-on tierB` fails on them. The text above is left as it was measured.*

---

# Amendment, 2026-09-29 — run 7: entry-scoped stub detection in gateway configs

Same twelve repositories, same commits. One scanner change (P1-G2, narrowed to LiteLLM
`config.yaml` / `model_list`). Run 7's twelve JSON documents are preserved with a SHA-256
manifest so this table can be re-derived rather than taken on trust.

## Before / after

| | run 5 | run 7 |
|---|---|---|
| Repositories identical | — | **12 of 12** |
| Locations compared | — | **14,171** |
| Locations changed | — | **0** |
| Promotions `test_fixture` → `review` | — | **0** |
| Precision | 94.6 % | **94.6 %** |
| Recall | 59.6 % | **59.6 %** |

The comparison deliberately covers **every location in every bucket**, not just actionable ones:
a promotion moves *between* buckets, so measuring only the actionable set would have hidden the
exact thing being measured.

**The manual review of promoted locations is therefore empty, because there were none.** That is
reported as the result rather than dressed up as a clean bill of health, and the next section
explains why it happened instead of leaving it as a shrug.

## Why nothing moved, verified rather than asserted

The fix stops `FAKE_[A-Z_]*API_BASE` from speaking for a whole file. Nine YAML files in the corpus
carry that marker. Each was checked:

| files | why they did not move |
|---|---|
| 6 | already demoted by **fixture path** (`proxy/example_config_yaml/…`) — that rule is untouched |
| 1 | `proxy_server_config.yaml` has a genuine **file-wide switch**, `dangerously_allow_mock_testing_request_params: true` under root `general_settings:` — correctly still demoted, which preserves the partner-audit conclusion about that file |
| 1 | `docker/build_from_pip/litellm_config.yaml` — its only registry id is `model_name: "gpt-4"`, an **alias**, sitting **inside the stub entry itself**: informational before and after |
| 1 | `.circleci/config.yml` — contains **no registry id at all**, so there is nothing to classify |

**Zero of the nine present the shape the fix addresses**: a live route in a file whose only mock
signal is an entry-level marker. The defect is real — reproduced end to end, where one entry
carrying `os.environ/FAKE_OPENAI_API_BASE` demoted a sibling `model: gpt-4-0613` from review to
informational — and the corpus simply does not contain it.

### What run 7 is evidence OF

**Run 7 is regression evidence, and that is exactly what it was for.** 14,171 locations compared,
zero changed: the fix altered nothing it was not aimed at. That is a real and necessary result, and
it is the whole job of these twelve repositories.

**The twelve repositories are a REGRESSION CORPUS. They are not a discovery corpus and not a
coverage corpus.** Naming that precisely matters, because the same table can be read three ways and
only one of them is true:

| reading | valid? |
|---|---|
| "this change broke nothing across twelve real repositories" | **yes** — that is what was measured |
| "this change was unnecessary, since nothing moved" | no — the defect was reproduced end to end |
| "twelve repositories were checked, so the scanner is broadly correct" | no — they were never sampled for coverage |

**The direct evidence that the defect is fixed is the targeted tests, not the corpus.** The
mixed-entry cases — a stub route beside a live one, stub first, stub sandwiched between two live
routes — fail before the change and pass after it. The mutation runs are the other half: disabling
the parse-error guard fails four abstention tests, and disabling the entry scoping fails two, which
is what shows those branches are load-bearing rather than decorative. Those tests are the proof.
Run 7 is the assurance that the proof cost nothing elsewhere.

**Two other changes in these two days also moved nothing here** — the coupled-parameter guard, and
the injected-client false clean that was caught by adversarial probing rather than by the corpus at
all. Read together the lesson is about the instrument, not the fixes: a green diff across all twelve
means "nothing regressed" and never "nothing is wrong", and the sentence "measured across twelve
repositories" must not be used to imply coverage it does not have.

## A correction to the diagnosis this slice was queued on

I reported that `blockHasMockMarker` leaked across entry boundaries and proposed making it
entry-scoped. **That was wrong.** Isolated separately: a stub entry carrying `openai/fake` and
`fake-key` leaves a sibling `model: gpt-4-0613` at review, correctly — the entry scan does not
leak. The earlier evidence was **confounded**: removing the stub entry removed two markers at
once, and the effect was attributed to the wrong one.

Reproducing a defect is not sufficient if the experiment does not isolate the variable. That is a
sharper version of the lesson this document already records twice.

## What shipped, and what it refuses to do

Entry boundaries now come from the YAML parser's node ranges (`src/config/yamlEntries.ts`), not
from indentation, because a line scanner has no real notion of an entry and cannot be trusted
across four-space indents, several documents in one file, an unexpected key order, or a file that
does not parse.

**Ambiguity never demotes.** `resolved: false` means *no opinion*, never *no stubs*: a parse error
in any document, a `model_list` that is not a sequence, an item with no usable range, no route
list, an empty file. The cost of demoting wrongly is a retirement reported as informational — a
false clean. The cost of not demoting is a review-queue entry on a stub. Those are not comparable.

An "all entries are fake" file rule was **deliberately not added**: per-entry marking already marks
every entry when every entry is a stub, and a file rule would only restate that while
reintroducing the whole-file blast radius this removes.

24 tests, mutation-verified twice. Full suite 1547/1547.

---

# Amendment, 2026-09-29 — runs 8 and 9, recorded separately from run 7

Run 7 is preserved unchanged, with its SHA-256 manifest. These are two further changes, each
measured on its own so each can be attributed.

## Run 8 — the fixture-only conclusion. Reporting-only, verified field by field.

`NO EXPOSURE IN COMPLETED SURFACES` understated a repository that pins a retiring id in a test
double or sample: such a reference fails on the shutdown date like any other caller, and what
breaks is a test run, a docs sample, or a developer setting the project up. The headline is now
**`FIXTURE-ONLY REFERENCES — NO PRODUCTION SELECTOR FOUND`**, below production severity, never
auto-migrated, and explicitly not a clean result.

**The requirement was that this change nothing else, and that was checked rather than assumed.**
Run 7 (preserved) against run 8, comparing every location's role, tier, disposition, key and
patch-eligibility, every investigation decision, and every coverage count:

| | result |
|---|---|
| Repositories | **12 of 12** unchanged apart from the conclusion string |
| Classifications changed | **0** |
| Decisions changed | **0** |
| Denominators changed | **0** |

**The first run of that check reported six failures, and the check was wrong, not the code.** Six
repositories differed on `registry.ageDays: 1.9 → 2` — the bundled registry's age against the wall
clock, which crossed the 2.0-day boundary partway through the twelve. Six scanned before it, six
after, which is exactly the split. The comparison's volatile-field list was incomplete. Recorded
because the failure looked like the thing it was designed to catch, and the correct response was to
read the diff rather than re-run and hope.

Ordering is mutation-verified: **every fail-closed verdict outranks the new one.** A stale registry,
an unparseable file or a mostly-unread repository stays `INCONCLUSIVE` even with fixture references
present, because fixture-only is a claim about what IS there and those are claims about what could
not be seen.

**The new conclusion fires on none of the twelve.** llama_index, the only repository without
exposure, has no fixture reference at all. Consistent with everything else in these two days.

## Run 9 — the mock-switch correction, and the promotions read by hand

Two corrections, both narrowing what may demote:

1. **`mock_timeout` and `mock_response` are per-route, not file-wide.** Both are `litellm_params`
   fields. Verified in litellm's own `proxy_server_config.yaml`, where `mock_timeout: True` sits
   inside a `model_list` entry's `litellm_params`, beside `FAKE_OPENAI_API_BASE`. They moved to
   entry scope.
2. **`dangerously_allow_mock_testing_request_params` no longer classifies anything.** It is
   recognised only at root `general_settings`, and it is recorded as **configuration metadata**,
   not a verdict. The switch says what the proxy PERMITS; it is not evidence that any particular
   route is fake, and a deployment can allow mock answers while serving production traffic. Using
   it to demote every entry was a false clean waiting to happen. An earlier commit in this same
   slice defended keeping it as a file-wide demotion and shipped a test asserting that; both are
   reversed, with the reasoning recorded in the test.

**Blast radius, measured before the change rather than discovered after it.** The previous check had
been YAML-only, which was too narrow — the old regex ran on all eight config extensions. Re-checked
across every format and all twelve repositories: **exactly one file matched**,
`litellm/proxy_server_config.yaml`, and it matched on **`mock_timeout`** — confirming the per-route
field was what had been demoting the file, not the switch.

### Every classification change in that file, inspected individually

17 locations, **16 changed**. They are two different kinds of change and are counted separately,
because only one kind alters what a reader is asked to do:

| kind | count | severity effect |
|---|---|---|
| **Behavioural promotions** — `test_fixture/C/informational` → `runtime_selector_candidate/B/review` | **5** | **yes**: enters the review queue |
| **Label-only corrections** — `test_fixture/C/informational` → `catalog_reference/C/informational` | **11** | **none**: same tier, same disposition, more accurate name |
| Unchanged | 1 | — |

#### Stub-marker leaks: ZERO

**Not one promotion came out of a `model_list` entry carrying a stub marker.** This is the property
the entry-scoping work exists to guarantee, so it is recorded as a result rather than left implied.
The stub entries in this file (`mock_timeout`, `openai/fake`, `FAKE_OPENAI_API_BASE`) contain no
registry-matching id at all, so they produced no location in either run — checked, not assumed.

#### The five behavioural promotions, with a per-location verdict

Each was judged by opening its entry in the config, not by its role string.

| line | id | the entry, as written | stub marker in the entry? | verdict |
|---|---|---|---|---|
| 4 | `gpt-5-mini` | `- model_name: gpt-5-mini-end-user-test` → `litellm_params: { model: gpt-5-mini, region_name: "eu" }` | none | **CORRECT** — a routed target with a real region, not a fixture |
| 10 | `gpt-5-mini` | same alias → `litellm_params: { model: openai/gpt-5-mini, api_key: os.environ/OPENAI_API_KEY }` | none | **CORRECT** — prefixed selector, real env-var key |
| 45 | `gpt-image-1` | `- model_name: dall-e-2` → `litellm_params: { model: openai/gpt-image-1 }` | none | **CORRECT** — the alias is the retiring name, the target is what is routed |
| 48 | `gpt-image-1` | `- model_name: openai-dall-e-3` → `litellm_params: { model: gpt-image-1 }` | none | **CORRECT** — bare target, no marker |
| 55 | `gpt-image-1` | `- model_name: gpt-image-1` → `litellm_params: { model: openai/gpt-image-1, api_key: os.environ/…, api_base: os.environ/RECORDER_OPENAI_BASE_URL }` | none | **CORRECT** — `RECORDER_OPENAI_BASE_URL` is not a fake base; the file's own comment says it is unset outside CI and falls back to `api.openai.com` |

**All five are correct as CLASSIFICATIONS.** Whether `gpt-5-mini` and `gpt-image-1` belong in the
registry at all is a different question, already open in this document as the registry-content audit,
and it is not answered here.

#### The eleven label-only corrections

No severity change in any of them, which is why they are counted apart from the five: nine
`model_name` values now read `catalog_reference` (an alias, which is what they are) instead of
`test_fixture`; one is `context_window_fallbacks`; one is a `text-completion-openai/`-prefixed
target. A reader's queue is unaffected — only the reason printed beside the line improves.

### A risk signal nobody could see is not a risk signal

The switch was first recorded into the classifier's internal `signals` array — which never reaches
a `LocationRef` or `--json`. So it was recorded where no consumer could read it: the same
invisible-reason defect already written up as bug #4 in this document, reproduced by the person who
wrote that entry.

It now travels as `coverage.config.globalMockTestingFiles` and prints in the audit's limits:

```
* 1 config file(s) enable mock testing globally
  (general_settings.dangerously_allow_mock_testing_request_params): config.yaml — requests to
  that proxy can be answered with a mock, which does not by itself mean any route there is fake;
  each was still judged on its own
```

Verified in both surfaces, with the route still `runtime_selector_candidate/B`: disclosed, and
demoting nothing.

Full suite **1565/1565**.

## Two corrections to how this document was being measured and reported

### The clock is now read once, and a batch can pin it

`registry.ageDays: 1.9 → 2` between runs 7 and 8 was treated, at first, as a field to exclude from
the comparison. **That was the wrong fix and excluding it would have hidden the real problem.** The
same clock drives:

* the **registry freshness grade**, which decides whether a zero-finding run reads
  `no exposure in completed surfaces` or `inconclusive` — a conclusion, not a cosmetic; and
* **`daysUntil` and deadline severity** on every finding.

Verified by pinning the instant against a real fixture, which moves severity through every state:

```
MENDR_EVALUATED_AT=2026-10-01  ->  registry date 2026-10-23 (22d ahead)
MENDR_EVALUATED_AT=2026-10-22  ->  registry date 2026-10-23 (1d ahead)
MENDR_EVALUATED_AT=2026-10-23  ->  registry date 2026-10-23 (today)
MENDR_EVALUATED_AT=2026-12-01  ->  registry date 2026-10-23 (39d past)
MENDR_EVALUATED_AT=2026-11-01  ->  registry STALE 33 d -> inconclusive
```

So a batch straddling a boundary could hand two repositories different severities, and therefore
different decisions, for no reason but when their turn came. The audit now reads the clock **once**,
records it as `evaluatedAt` together with `evaluationTimeSource` (`system` or `override`), and
honours `MENDR_EVALUATED_AT` so a batch is one evaluation rather than N. Two runs with the same pin
produce **byte-identical JSON**.

**A pin that cannot be read STOPS the run — exit 2, a sentence on stderr, no report.** The first
version of this fell back to the system clock instead, and that was corrected before commit because
it is the worst available behaviour: someone who deliberately pinned an instant would get a
confident, valid-looking report computed at a different time than they asked for, every deadline in
it shifted and nothing saying so. A pin exists to make a run reproducible; silently ignoring it
defeats the only reason to set it.

Three shapes are refused, each with a message naming the fix. A **naked datetime** such as
`2026-10-23T00:00:00`, because JavaScript reads it as *local* midnight — a different instant on every
machine, which is the irreproducibility a pin is meant to remove; a date-only value is therefore
*defined* as UTC and an offset must be explicit. An **empty** value, because something set it and
meant to pass an instant. And an **impossible calendar date**: `2026-02-30` does not fail in V8, it
rolls over to March 2nd and returns a valid Date — so the calendar fields are validated against the
string before any Date is constructed, not against whatever the parser was willing to accept.
Verified through the real CLI: `garbage`, `2026-10-23T00:00:00` and `2026-02-30` each exit 2 with
zero bytes on stdout.

### `globalMockTestingFiles` is an observation, not coverage and not a limit

It was first put in `coverage.config` and printed under **"Limits of this run"**. Both were wrong in
the same way. Everything in `coverage` is a denominator or a limit — it answers *"what did the scan
manage to read, and what does its silence therefore not prove"*. This is neither: the file was read
completely, every entry in it was classified, and no number moves. Printing it as a limit stated
outright that mendr had failed to inspect something. It had not.

It now lives at **`observations.config.globalMockTestingFiles`** and prints in its own section:

```
Configuration observations (these classify nothing and change no count):
  • mock testing is enabled globally in 1 file(s)
    (general_settings.dangerously_allow_mock_testing_request_params): config.yaml.
    Requests to that proxy can be answered with a mock. That does NOT mean any route
    there is fake, so every entry was still judged on its own markers.
```

Verified: present under `observations`, absent from `coverage.config`, and the route in that file is
still classified `runtime_selector_candidate/B`. An observation may never classify, never alter a
denominator, and never imply something went unread.

### The fixed-clock comparison, and the first attempt that had to be thrown away

The real-repository check — two pinned audits of litellm, compared byte for byte — was run twice
before a valid result existed, and the first two attempts are **discarded**, not reported.

Both tasks wrote to the **same output paths**, and the scanner was rebuilt while they were in
flight. One task's `cmp` therefore compared a file it had written against a file the *other* task
had overwritten, and printed `BYTE-IDENTICAL` directly beneath two byte counts that differed by 38
— the exact size of the `evaluationTimeSource` field the rebuild had added. Files of different
sizes cannot be identical; the verdict was contaminated by its own environment.

That is the same family of error as the volatile-field lists earlier in this document: a check that
cannot detect its own contamination is not a check. The rerun is isolated in its own directory and
**fingerprints the scanner build before and after both runs, refusing its own verdict if the build
changed underneath it.** Its result is recorded below only once it exists; nothing from the two
contaminated attempts is used.

**The clean result, 2026-09-30.** Two pinned audits of litellm in an isolated directory, the
scanner build fingerprinted before and after:

```
build fingerprint before: 80705371ff3855b9
run 1: rc=0 bytes=7297999 elapsed=1240s
run 2: rc=0 bytes=7297999 elapsed=1297s
build fingerprint after:  80705371ff3855b9
BYTE-IDENTICAL under a pinned clock (2026-09-30T00:00:00Z)
evaluationTimeSource: "override"
5f8386d77c2f…22e93  run-1.json
5f8386d77c2f…22e93  run-2.json
```

Same build, same pin, same bytes. That is the reproducibility the pin exists to provide, shown on
a 7.3 MB report of a real repository rather than on a fixture.
