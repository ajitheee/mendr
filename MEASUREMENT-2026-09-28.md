# Scanner measurement — twelve repositories, 2026-09-28

The build order locked this slice on 2026-09-15:

> **3. Scanner measurement: the 12-repo harness against the shipped artifact, publishing
> precision, recall, skipped files and before/after.**

It was recorded as shipped. It was not. `scripts/tier-probe.mjs` classifies one snippet; no
precision or recall number had ever been published for this scanner. This is the first.

---

## The headline

| | |
|---|---|
| Repositories scanned | **12 of 12** |
| Actionable findings (`patch` + `review`) | 22 |
| Informational findings (`monitor`) | 402 |
| True positives | 29 |
| False positives | **2** |
| False negatives | **49** |
| **Precision** | **93.5 %** |
| **Recall** | **37.2 %** |

**The error budget is almost entirely on the recall side, which is the dangerous direction.**
A noisy review is an annoyance. A missed live call is an outage.

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

| repo | actionable | informational | TP | FP | FN |
|---|---|---|---|---|---|
| chroma | 2 | 5 | 2 | 0 | 4 |
| fast-agent | 2 | 28 | 2 | 0 | 2 |
| guardrails | 1 | 14 | 1 | 0 | 0 |
| langgraph | 0 | 2 | 0 | 0 | 4 |
| librechat | 5 | 85 | 5 | 2 | 0 |
| litellm | 2 | 101 | 2 | 0 | 2 |
| llama_index | 0 | 4 | 0 | 0 | 1 |
| openai-cookbook | 0 | 29 | 0 | 0 | **32** |
| paper2code | 2 | 17 | 5 | 0 | 2 |
| promptfoo | 2 | 107 | 3 | 0 | 2 |
| sodaverse | 4 | 0 | 4 | 0 | 0 |
| tinytroupe | 2 | 10 | 5 | 0 | 0 |

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
