# Scanner measurement — 12 repositories, shipped artifact

> **Method.** The 12 repositories from `VALIDATION-2026-09-03.md` were cloned fresh and pinned
> to the commits listed in section 7. Three conditions were run against the **same clones**: the
> pre-hardening scanner (v0.2.2-alpha, the build the September 3 adjudication measured), the
> current scanner pinned to the v0.2.2 registry, and the shipped artifact. Running all three on
> identical trees separates the scanner change from the registry growth, and removes the
> confound that these repositories have moved on in twelve days.
>
> An **independent text search**, sharing no code with the scanner, then located every registry
> model id in every `.py/.ts/.tsx/.js/.jsx/.mjs/.cjs` file. One adversarial adjudicator per
> repository read the code behind each candidate; two independent skeptics tried to refute every
> claimed defect. Only defects surviving both are counted.
>
> **Status.** Re-measured on 2026-09-16 at commit `1ca8aaf`, after suppressions, the evidence-rich
> pull request body, the coverage denominator and the config-scanner work landed. It supersedes
> the September 3 figures, which measured v0.2.2-alpha.
>
> **What the re-run changed.** Nothing in section 1, 2 or 3: the same conclusions, the same single
> Tier A finding, the same 4,116 occurrences narrowing to the same 75 candidates with zero
> confirmed misses. What it did catch was a regression introduced three commits earlier — see
> section 5.

## 1. Before and after, on identical clones

| repo | v0.2.2 scanner | current scanner, old registry | shipped artifact | conclusion |
|---|---|---|---|---|
| chatbot-ui | 1 A / 2 B | 1 A / 2 B | 1 A / 2 B | exposure_detected |
| LibreChat | 2 A / 0 B | 0 A / 6 B | 0 A / 6 B | exposure_detected |
| NextChat | 1 A / 0 B | 0 A / 1 B | 0 A / 1 B | exposure_detected |
| anything-llm | 0 A / 0 B | 0 A / 0 B | 0 A / 0 B | no_exposure |
| vercel/ai | **176 A** / 2 B | 0 A / 0 B | 0 A / 0 B | no_exposure |
| lobe-chat | 1 A / 0 B | 0 A / 2 B | 0 A / 2 B | exposure_detected |
| open-webui | 1 A / 0 B | 0 A / 2 B | 0 A / 2 B | exposure_detected |
| ragflow | 0 A / 2 B | 0 A / 2 B | 0 A / 2 B | exposure_detected |
| langflow | 0 A / 0 B | 0 A / 0 B | 0 A / 0 B | no_exposure |
| langchain | 1 A / 0 B | 0 A / 1 B | 0 A / 1 B | exposure_detected |
| continue | 2 A / 3 B | 0 A / 2 B | 0 A / 2 B | exposure_detected |
| dify-official-plugins | 0 A / 5 B | 0 A / 6 B | 0 A / 6 B | exposure_detected |
| **Tier A total** | **185** | **1** | **1** | |
| **Tier B total** | 14 | 24 | 24 | |

**The whole drop is the scanner, not the registry.** Columns two and three use the same 110-entry
registry; only the scanner differs. Column four adds the 48 promoted entries and changes nothing,
because the ids added are older models these repositories no longer call.

`vercel/ai` is the case that produced the original verdict: 176 Tier A locations, nearly all
under `examples/`, and a conclusion of exposure_detected on a package whose product code has
none. It now reports no exposure, with its 23 remaining ids correctly informational.

Findings did not disappear; **they moved from A to B.** Tier A fell by 184 while Tier B rose by
10. A Tier B finding is still reported and still requires a human — it is simply not offered for
automatic rewriting.

## 2. Precision

**One Tier A location across twelve repositories, and it is correct.**

`chatbot-ui app/api/command/route.ts:24` — `gpt-4-1106-preview`, shutting down 2026-10-23.
`import OpenAI from "openai"` at line 3, the client constructed in the same file at line 18, and
the literal in the `model` argument of `openai.chat.completions.create` inside an exported route
handler. The generated diff changes exactly that one line and nothing else; the 67 other
occurrences of retiring ids in that repository are left alone.

This is the same location the September 3 adjudication judged one of only two correct Tier A
findings in the entire run.

**A precision of one out of one is a weak number and should be quoted as such.** It establishes
that the build produced no wrong auto-fixable finding on this corpus. It does not establish a
rate, because the denominator is one.

## 3. Recall

| stage | count |
|---|---|
| raw occurrences of a registry id in analyzable source | 4,116 |
| distinct files containing one | 703 |
| shaped like a live selector, outside test/example/doc paths | 75 |
| adjudicated correctly demoted | 54 |
| not a selector at all | 14 |
| already reported at Tier A | 1 |
| claimed as missed | 6 |
| **confirmed missed after refutation** | **0** |

All six claimed misses were refuted by both skeptics, and independently verified against the
scanner's own output: every one is already reported at **Tier B, decision review**.

- `LibreChat api/server/services/Endpoints/assistants/title.js:25` — `gpt-3.5-turbo`
- `LibreChat api/app/clients/tools/structured/DALLE3.js:161` — `dall-e-3`
- `LibreChat config/translations/anthropic.ts:32` — `claude-3-5-sonnet-20241022`
- `dify-official-plugins tools/openai/tools/dalle2.py:40` — `dall-e-2`
- `dify-official-plugins tools/openai/tools/dalle3.py:47` — `dall-e-3`
- `langchain libs/langchain/langchain_classic/evaluation/loading.py:168` — `gpt-4`

Each is a genuine first-party SDK request. Each is Tier B rather than Tier A because the client
is not resolvable in the same file — a function parameter, a constructor-assigned field, or a
local constant hop. That is the documented rule, and it is the rule that removed 184 wrong
findings.

**The trade is therefore explicit: six real call sites are reported but must be fixed by hand.**
Nothing was hidden. The cost of the precision gain is auto-fixability, not visibility.

## 4. What was skipped, and what was not read at all

Every file the walker found now lands in exactly one category, so the column adds up. Two of these
categories did not exist when this document was first written: a file that could not be **opened**,
and a file that **parsed with syntax errors**.

| repo | discovered | analyzed | test files | languages not read | parse failures | unopenable |
|---|---|---|---|---|---|---|
| chatbot-ui | 288 | 259 | 3 | 26 | 0 | 0 |
| LibreChat | 4,956 | 3,078 | 1,860 | 18 | 0 | 0 |
| NextChat | 194 | 154 | 34 | 6 | 0 | 0 |
| anything-llm | 174 | 158 | 13 | 3 | 0 | 0 |
| vercel/ai | 3,139 | 3,090 | 49 | 0 | 0 | 0 |
| lobe-chat | 3,558 | 2,415 | 1,136 | 7 | 0 | 0 |
| open-webui | 1,021 | 349 | 2 | **670** | 0 | 0 |
| ragflow | 4,643 | 1,511 | 703 | **2,429** | 0 | 0 |
| langflow | 310 | 194 | 0 | 116 | 0 | 0 |
| langchain | 2,324 | 1,666 | 645 | 13 | 0 | 0 |
| continue | 1,122 | 727 | 390 | 5 | 0 | 0 |
| dify-official-plugins | 2,350 | 2,111 | 239 | 0 | 0 | 0 |
| **total** | **24,079** | **15,712** | **5,074** | **3,293** | **0** | **0** |

**Zero parse failures and zero unopenable files across all twelve repositories.** That is the
result worth reading: the detector that forces `inconclusive` fires on nothing in real, healthy
code. It was calibrated against exactly this corpus, twice, because the first two versions were
too eager — see section 5.

**65% of everything discovered was analyzed, and 83% of the source that is not a test file.**
Both are true, of different denominators, which is why the report prints the categories rather
than a percentage. Two repositories carry most of the gap: `ragflow` (2,265 Go files) and
`open-webui` (662 Svelte files). Neither is a language Mendr reads, and both are disclosed.

**Within the languages it does read, nothing is unaccounted for.** Counting every
`.py/.ts/.tsx/.js/.jsx/.mjs/.cjs` file on disk and comparing against scanned plus
test-files-skipped, the difference is between -26 and +3 files per repository — counting noise,
not coverage loss:

| repo | supported files on disk | scanned + tests skipped | difference |
|---|---|---|---|
| LibreChat | 4,935 | 4,938 | +3 |
| lobe-chat | 3,525 | 3,551 | +26 |
| vercel/ai | 3,139 | 3,139 | 0 |
| dify-official-plugins | 2,350 | 2,350 | 0 |
| langchain | 2,311 | 2,311 | 0 |
| ragflow | 2,217 | 2,214 | -3 |
| continue | 1,104 | 1,117 | +13 |
| open-webui | 352 | 351 | -1 |
| chatbot-ui | 262 | 262 | 0 |
| anything-llm | 172 | 171 | -1 |
| NextChat | 189 | 188 | -1 |
| langflow | 195 | 194 | -1 |

So the two numbers to quote are different statements and both are true: **82.7% of all discovered
source files**, and **effectively 100% of files in the languages Mendr claims to read**. The
unanalyzed column is out-of-scope languages, not files the scanner failed to open.

**No coverage regressed.** Adding back the test files the new build excludes from its scanned
count, every repository is seen at least as completely as before, and `anything-llm` went from
0 files analyzed to 158. `langflow` fell from 6,120 files to 194 because the repository itself
restructured: it has 195 source files on disk today.

## 5. What the harness caught, and what it cost to calibrate

The first run of this harness found two defects in the migration path. Both are now fixed, and
re-running it caught a third — a regression introduced by one of those fixes.

**Fixed: the Tier A summary named a parameter rename the diff did not contain.** The sentence was
built from the parameter sites *located*, while the other half of the same sentence counted the
edits *applied*. Pass 2 evaluates against the model pass 1 just wrote, so a rule that applied to
the old id can correctly decline on the new one. The summary therefore announced renames that were
not in the diff below it, under a heading marked VERIFIED. Labels now come from the edits made.

**Fixed: the parameter rule did not cover the models it migrates to.** `max_tokens` to
`max_completion_tokens` listed `on_models: [o1, o3, o4, gpt-5]`, and the matcher requires an exact
prefix, so `gpt-5.6-sol` did not match — the replacement target of 20 registry entries, with
`gpt-5.6-terra` behind another 18. Every one of those migrations swapped the model and left a
`max_tokens` the new model rejects. `chatbot-ui`, the single auto-fixable finding in this whole
corpus, now renames the parameter in the same diff. A `validate-registry` check fails when a
replacement starts with a parameter rule's family yet does not match it: 0 on the fixed registry,
41 on the one from an hour earlier.

**Caught by re-running: commented-out config was promoted to a live selector.** Reading a key
inside a flow mapping (`llm: {model: gpt-4-0613}`) means searching the text to the LEFT of the id,
and that search read straight through a leading `#`. Two commented lines in LibreChat's
`helm/librechat/values.yaml` became runtime selector candidates:

```
#         titleModel: "gpt-3.5-turbo"
#         summaryModel: "gpt-3.5-turbo"
```

Commented-out config is everywhere in Helm values and docker-compose files, and it is the opposite
of a live selection. LibreChat is back to the 6 Tier B findings it had before, and this is the only
number in the entire re-run that moved.

### What calibration cost

The parse-failure detector was too eager twice, and only measuring against these twelve
repositories showed it:

- **Strict JSON parsing called 23 files malformed, and every one was fine.** `.vscode/launch.json`,
  `.vscode/settings.json`, `tsconfig.json`, `.eslintrc.json`. Comments and trailing commas are the
  norm in that family. A check that fires on `tsconfig.json` is a check people switch off.
- **Flagging every YAML anchor fired on anchors that could not hold a model** — ragflow's
  `exclude: &web_exclude [globs]`, dify's `document: &id001`. Narrowed to an alias standing where a
  model would be.
- **Unparseable documentation was pushing a clean repository to inconclusive.** langflow flipped
  from `no_exposure` over three tutorial curl samples under `docs/` containing a literal `...`.
  Genuinely invalid JSON; genuinely irrelevant. The same fixture-path rule the scanner already
  uses for findings now applies to the parse check.

All three were false alarms of the same shape: technically correct detection of something that
could not have hidden a live call site. A scanner that cries wolf on `tsconfig.json` teaches people
to ignore it, which costs more than the gap it was closing.

## 6. What this does not establish

- **The precision result is partly in-sample.** The hardening rules were written after reading
  these same twelve repositories. A corpus that found the bugs cannot independently confirm the
  fixes.
- **One Tier A location is not a rate.** No confidence interval is meaningful here.
- **The corpus is wrong for the buyer.** All twelve are multi-provider chat UIs or LLM
  frameworks, where a model id is catalog data by construction. None is a business application
  calling one model to do one job, which is what Mendr is sold to. Prevalence in application
  code remains unmeasured in either direction.
- **Recall was measured through a filter.** 4,116 occurrences were narrowed to 75 by a pattern
  for selector-shaped lines outside test and example paths. A live selector resembling neither
  would never have reached an adjudicator.
- **Nothing here was run by anyone outside this project**, and no engineer has been observed
  reading a Mendr report.
- **Scan times here are not a benchmark.** The whole corpus took 52 seconds on the re-run against
  229 seconds on the first. Most of that is a quieter machine, not faster code: the first run had
  parallel harness jobs competing for CPU, and one of them recorded a 900-second "timeout" on
  `lobe-chat` that completes in 49 seconds when run alone. Treat the per-repo seconds as an order
  of magnitude, nothing finer.
- **The parse-failure detector is calibrated on this corpus.** It reports zero across all twelve
  repositories, which is the right answer for healthy code, but it took three narrowings to get
  there and every one was informed by these same repos. Its behaviour on a repository genuinely
  full of broken files is untested outside synthetic fixtures.
- **The config scanner still has no YAML parser.** Flow mappings are read correctly now, but an
  alias standing where a model would be is declared unreadable rather than resolved. Merge keys,
  nested anchors and multi-document streams need a parser, not a regex, and that remains a
  deliberate gap rather than a solved problem.

## 7. Reproducing this

The harness lives outside the repository, in the session scratchpad:

```
clone.sh                                          # pin the 12 repos
python run.py <old>/dist/cli.js A-old             # pre-hardening scanner
python run.py <new>/dist/cli.js B <old-registry>  # current scanner, old data
python run.py <new>/dist/cli.js C-shipped         # shipped artifact
python compare.py                                 # diff any two runs, to catch a regression
python search.py && python narrow.py              # independent recall search
python compare.py
```

Commits the repositories were pinned to:

```
chatbot-ui            81328b61d2a4ab597a7a057be70e785cf756d9f8
LibreChat             1df448481075d37484f11c4751dc3f60314ee651
NextChat              defdcdb55d850cd12c4c657eb83729fd66e215c0
anything-llm          a145d4d87d086bdb31d50f9bf9cd9c46d311780c
vercel/ai             d93e295f4a3c0869b7363ee3826dbbd5a29bde3c
lobe-chat             7bca055b6a9ce95ad03bd1d83fc6deb426d41aff
open-webui            0a7c15832fb30b1903753e83f81dc7d27e5b0944
ragflow               a3b3984530d1463574bd36540c47549e501984a5
langflow              595cd72a2b2021f2375fa31109af02d20bb17648
langchain             8831544aeebf2eed4f2d4a80e2b963a62a93f25d
continue              5522c6f44ca0ac3528b37244818fbfa39b5af470
dify-official-plugins 331077a2c7f821318ed6aae455847e5dcd7b9246
```

## 8. The sentence this supports

> Across twelve public repositories and 15,712 analyzed source files, the shipped scanner
> reported one automatically fixable finding, and it was correct. An independent search of 4,116
> occurrences of a retiring model id found nothing it had missed. Six further live call sites
> were reported for human review rather than automatic repair, because their client could not be
> resolved in the same file.

Re-verified on 2026-09-16 against a build four features newer. Every number above reproduced.

**And that is the argument for running this again before each release.** The re-run existed to
confirm the figures, and it earned its keep by catching something else: a regression, three
commits old, that had quietly promoted commented-out Helm config to a live selector. No unit test
caught it, because the unit tests assert what the rules should do and this was a rule doing
exactly what it was told to a case nobody had thought of. Twelve real repositories thought of it.

---

## Addendum, 2026-09-16 — the recall filter had a blind spot

The recall claim above ("an independent search of 4,116 occurrences found nothing missed") is
weaker than it reads, and a repository outside this corpus proved it the next day.

**going-doer/Paper2Code** (4,954 stars) audited as **NO EXPOSURE IN COMPLETED SURFACES**. Its
documented Quick Start is `bash run.sh`, and both README evaluation commands take no
`--gpt_version` flag; every one of those paths runs `o3-mini`, which OpenAI retires 2026-10-23.
The scanner saw the literal and filed it as a code data reference — the same bucket as a
docstring.

The cause was a defaulting shape neither language recognized:

```python
parser.add_argument('--gpt_version', type=str, default="o3-mini")
```

Two independent rules had to miss it. `modelNamedAssignmentTarget` looks for a model-named
assignment target, and a bare `add_argument(...)` statement has none. And `isModelLikeName` is
`/model/i`, which `--gpt_version` does not satisfy despite naming a model exactly.

TypeScript had the identical hole, and had it twice: `isCliModelOptionDefault` existed for
commander's positional default but was gated on the same `/model/i` flag-name test, and it knew
nothing of the yargs spelling, where the default is a `default:` property rather than a
positional argument. `yargs.option('gptVersion', { default: 'o3-mini' })` feeding
`model: argv.gptVersion` also audited clean.

Both are fixed, keyed on the CALL rather than the option's name — by that point the value is
already known to match a registry id, so the question is not whether it is a model but whether
it is the one that runs when the flag is omitted. Both cap at **review, never swap-eligible**:
the path from parsed argv to a provider request is not traced.

**What this says about the recall measurement.** The 4,116 occurrences were narrowed by a
pattern filter and the survivors checked. That design can only find ids classified into the
wrong bucket among candidates the filter surfaced; it cannot find a whole POSITION the classifier
misreads, because such a literal is correctly excluded as "data" at every step. A recall search
built from the scanner's own notion of a candidate inherits the scanner's blind spots.

**It also did not show up here because this corpus could not show it.** Re-measured after the
fix, all twelve repositories produce byte-identical output — same conclusions, same tallies.
A precise search confirms why: not one CLI option in the corpus carries a model id as its
default. Twelve repositories agreeing proves less than it appears to when they share a shape.

The honest summary is that this corpus measures precision well and recall only within the
filter's imagination. The Paper2Code class was found by reading a repository by hand, which is
the method that keeps working.
