# mendr v0.2.3-alpha

**Hardening release.** The audit engine shipped in v0.2.2-alpha was run against
twelve real third-party repositories, every Tier-A location was checked by
reading the code, and every claimed defect was adversarially refuted before it
counted. The result was not good enough to ship a migration on: 60 of the 62
Tier-A locations checked were wrong. This release fixes every confirmed root
cause and re-proves the same corpus.

**This is an alpha.** It is offered to design partners for evaluation, not as a
finished product. Nothing is applied and nothing is merged by any command in it.

## The claim, stated exactly

> **Zero incorrect PATCH ELIGIBLE findings across the current validation corpus.**

That sentence is deliberately narrow. It is a statement about twelve
repositories and one decision class, not a general claim of zero false
positives. Mendr has not been validated on your repository until you run it.

## The validation corpus

Twelve public repositories, chosen for heavy first-party LLM usage across the
supported languages, scanned in full (37,685 source files, 60 s of total scan
time before hardening):

| repository | what it is | source scanned |
|---|---|---|
| mckaywrigley/chatbot-ui | Next.js chat app | 253 TS |
| danny-avila/LibreChat | chat platform (JS backend, TS client) | 2,350 TS |
| ChatGPTNextWeb/NextChat | Next.js chat app | 148 TS |
| Mintplex-Labs/anything-llm | JS/JSX application | 22 TS (98% JavaScript) |
| vercel/ai | AI SDK monorepo | 5,188 TS |
| lobehub/lobe-chat | TS monorepo | 9,795 TS |
| open-webui/open-webui | Python backend, Svelte frontend | 341 TS + Python |
| infiniflow/ragflow | Python + TS | 2,006 |
| langflow-ai/langflow | Python + TS monorepo | 4,017 |
| langchain-ai/langchain | Python monorepo | 1,764 Python |
| continuedev/continue | TS monorepo | 1,283 TS |
| langgenius/dify-official-plugins | Python plugins | 2,107 Python |

Method: an independent boundary-aware text search located every registry model
id in every file, so the audit's output could be compared against ground truth
rather than against itself. One adjudicator per repository read the code behind
every Tier-A location and every unexplained occurrence in a supported file; two
independent skeptics per repository then tried to refute each claimed defect.
Only defects that survived both are in `VALIDATION-2026-09-03.md`.

## What the corpus shows now

- **All 12 previously identified incorrect PATCH ELIGIBLE locations are
  eliminated.** They were: LibreChat `EditMessage.tsx:138`; NextChat
  `app/constant.ts:424`; vercel/ai `tool-order.ts:29` and
  `anthropic-provider.test-d.ts:7,10,13`; lobe-chat `const/src/llm.ts:8` and
  `business-const/src/index.ts:7`; open-webui `utils/index.ts:859`; langchain
  `evaluation/loading.py:168`; continue `llms/llm.ts:57` and
  `smoke-api-helpers.ts:53`. Nine are now Tier-B review candidates, one is
  informational (a mocked response body in a sample), and four are no longer
  reported (type tests and a smoke-test helper are test support). The 183
  further vercel/ai locations under `examples/` are informational.
- **Exactly one Tier-A location remains in the corpus**, chatbot-ui
  `app/api/command/route.ts:24`, a `chat.completions.create` call on a
  first-party OpenAI client constructed in the same file. It was manually
  confirmed correct by the reviewers before and after hardening.
- Four real defaults the previous release had filed as "no selector" are now
  review candidates: open-webui `images.py:205`, langchain
  `chat_models/base.py:731` and `llms/base.py:176`, lobe-chat
  `generate/image.ts:10`.
- 38 provider-prefixed selectors (`openai/gpt-5-nano`, `google/gemini-2.0-flash`)
  that were invisible are reported.
- vercel/ai's conclusion changed from EXPOSURE DETECTED to NO EXPOSURE IN
  COMPLETED SURFACES, which is the truth about its `packages/`. anything-llm's
  changed from NO EXPOSURE to INCONCLUSIVE, because 98% of its source is
  JavaScript that mendr does not read.

Expect the same shift on your repository: **fewer Tier-A findings and more
Tier-B review candidates than v0.2.2-alpha produced.** That is the intended
direction. Uncertainty always reduces authority.

## What changed

Full detail is in `CHANGELOG.md`. In one paragraph: the TypeScript scanner now
applies the same guards the Python scanner already had. A model argument earns
Tier A only when its call resolves, in the same file, to a first-party provider
SDK client with no proxy or Azure override, inside a function, with a matching
endpoint family. Model-named constants are judged by where they are used.
Example and sample trees are informational. LangChain factories are wrapper
surfaces. Real defaults are review candidates. Provider-prefixed ids are found.
"Verified" in the report is keyed on the tier and nothing else; patch
eligibility is stated per line; a repository mendr mostly cannot read concludes
inconclusive; skipped test files and unanalyzed languages are disclosed.

## Honest limits — read this before evaluating

- **JavaScript, JSX, MJS and CJS are not analyzed.** This is the single largest
  coverage gap: 2,947 JavaScript-family files across 11 of the 12 validation
  repositories, including LibreChat's only production call to a model retiring
  on 2026-10-23. Every run names the unanalyzed languages in its coverage
  report. A repository that is mostly JavaScript concludes INCONCLUSIVE.
- **Report comprehension has not been validated with external partners.** Every
  clarity finding so far is a reviewer's inference from the text. Whether an
  engineer opens the right file, runs `fix-llm` only on the correct lines, and
  ignores the fixture rows is unmeasured until people outside this project run
  it. That measurement is the next milestone.
- **Live provider reconciliation has not been completed.** The OpenAI and
  Anthropic usage connectors remain **optional preview** functionality. Their
  request and cost figures have not been validated against a non-empty
  organization's provider dashboard. Do not rely on them as measured spend or
  measured usage; do not connect an organization Admin key to evaluate mendr.
  Repository auditing needs no key and is the product.
- A configuration finding is a candidate, never a proven runtime control: reader
  tie-back analysis does not exist yet.
- Test and spec files are counted but their model ids are not examined, by rule.
  The count is printed in every coverage report.
- Absence from a runtime source is not proof that a model is unused. Provider
  usage reads, where a customer chooses to connect one, cover chat/completions
  only; Anthropic's usage API reports no request counts; Google/Vertex is not
  supported.
- mendr never claims a general "clean" result. The four possible conclusions are
  `exposure_detected`, `no_exposure_in_completed_surfaces`, `inconclusive` and
  `audit_failed`; a skipped or failed surface stays visible and blocks any
  no-exposure claim.
- Three ids reported missing from the registry during validation
  (`gemini-1.0-pro-vision-latest`, `text-embedding-ada-002`,
  `text-embedding-004`) are not added here; registry facts go through the
  registry process, never a silent edit.
- Nothing is ever applied or merged. A PATCH ELIGIBLE decision means a reviewed
  PR is possible, not that a change was made.

## Install

```sh
npx github:ajitheee/mendr#v0.2.3-alpha audit .
```

To keep one GitHub issue current per repository (`contents: read`,
`issues: write`, nothing else):

```sh
npx github:ajitheee/mendr#v0.2.3-alpha audit . --install
```

## For design partners

Run the audit on a real repository and tell us six things:

1. Any finding that is wrong, with the file and line.
2. Any retiring model you know you depend on that the report missed.
3. Whether the summary and the next action were clear on first read.
4. Any friction installing or running it.
5. Whether you would let it run on a schedule.
6. What you would want a migration PR to prove before you merged it.

Those answers decide what gets built next. The classifier stays as it is unless
a partner audit exposes a real defect.

## Version note

`v0.2.2-alpha` remains valid for what it contained. This release supersedes it
for every purpose; the classification changes above mean the two releases will
tier the same repository differently, on purpose.
