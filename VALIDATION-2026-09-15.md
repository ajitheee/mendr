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
> **Status.** This describes the build at commit `8a0f278`. It supersedes the September 3
> figures, which measured v0.2.2-alpha and are twelve releases old.

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

## 4. What was skipped

| repo | scanned | unanalyzed | tests skipped | docs | seconds |
|---|---|---|---|---|---|
| chatbot-ui | 259 | 26 | 3 | 1 | 3.3 |
| LibreChat | 3,078 | 18 | 1,860 | 41 | 47.9 |
| NextChat | 154 | 6 | 34 | 28 | 4.8 |
| anything-llm | 158 | 3 | 13 | 17 | 2.6 |
| vercel/ai | 3,090 | 0 | 49 | 582 | 13.2 |
| lobe-chat | 2,415 | 7 | 1,136 | 599 | 49.0 |
| open-webui | 349 | **670** | 2 | 16 | 29.4 |
| ragflow | 1,511 | **2,429** | 703 | 230 | 12.9 |
| langflow | 194 | 116 | 0 | 313 | 4.1 |
| langchain | 1,666 | 13 | 645 | 37 | 14.4 |
| continue | 727 | 5 | 390 | 200 | 14.7 |
| dify-official-plugins | 2,111 | 0 | 239 | 423 | 33.0 |
| **total** | **15,712** | **3,293** | **5,074** | **2,487** | |

**82.7% of discovered source files were analyzed.** Two repositories carry most of the gap:
`ragflow` (2,265 Go files) and `open-webui` (662 Svelte files). Neither is a language Mendr
reads, and both are disclosed in the report rather than silently excluded.

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

## 5. Two defects this run found

**The Tier A summary names a parameter rename the diff does not contain.** On a call using
`model: 'gpt-5'` with `max_tokens`, the printed summary reads `1 model-id swap (... rename
"max_tokens" -> "max_completion_tokens" (on gpt-5))` while the diff below it changes only the
model. The parameter transform was located, counted in the Tier A total, then downgraded by the
gates — and the sentence is built from what was *located* rather than what was *applied*. It
appears under a heading marked VERIFIED. A reader applying that diff gets less than the
description promises.

**The parameter rule does not cover the models it migrates to.** `max_tokens` to
`max_completion_tokens` lists `on_models: [o1, o3, o4, gpt-5]`, and the matcher requires an
exact prefix, so `gpt-5.6-sol` does not match. That id is the replacement target of 20 registry
entries and `gpt-5.6-terra` of another 18 — the two most common migration targets in the file.
Whether the `gpt-5.6` line requires the rename is a fact about the provider that the registry
does not record, and nothing in the pipeline raises the question.

Both belong to the evidence-rich pull request body work, where coupled parameters and anything
skipped have to be stated accurately.

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
- One batch run recorded a 900-second timeout on `lobe-chat`. Run alone it completes in 49
  seconds; the timeout was CPU contention between parallel harness jobs, not the scanner.

## 7. Reproducing this

The harness lives outside the repository, in the session scratchpad:

```
clone.sh                                          # pin the 12 repos
python run.py <old>/dist/cli.js A-old             # pre-hardening scanner
python run.py <new>/dist/cli.js B <old-registry>  # current scanner, old data
python run.py <new>/dist/cli.js C-shipped         # shipped artifact
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
