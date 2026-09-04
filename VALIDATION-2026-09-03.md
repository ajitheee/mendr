# External validation — v0.2.2-alpha against 12 third-party repositories (2026-09-03)

> Method: `mendr audit` was run on 12 public repositories (chatbot-ui, LibreChat, NextChat, anything-llm, vercel/ai, lobe-chat, open-webui, ragflow, langflow, langchain, continue, dify-official-plugins). An independent text search located every registry model id in every file; one adversarial adjudicator per repo read the code behind every Tier-A location and every unmatched occurrence in supported files; two independent skeptics per repo then tried to refute each claimed defect. Only defects that survived both are counted. This document is the synthesis; the harness and per-repo evidence live outside the repo.

> Status: this is the **input to the hardening phase**, not a description of the current build. Every root cause below is tracked to a fix in the following commit(s).


Scope: 12 real repositories, 37,685 source files scanned in 60.5 s of wall time, every Tier A location checked or sampled, every unmatched hit in supported files sampled, all findings adversarially refuted before adjudication. Only adjudicated (non-refuted) defects are counted below; refuted claims are listed separately in section 4.

## 1. Per-repo metrics

| repo | files scanned | scan s | conclusion (+ correct?) | Tier A total / checked / incorrect | false positives | misses (of checked) | unsupported files | phantoms | clarity issues |
|---|---|---|---|---|---|---|---|---|---|
| chatbot-ui | 266 | 0.7 | exposure_detected — correct | 1 / 1 / 0 | 0 | 0 / 37 | JS 6 (disclosed); SQL 26 with 36 registry-id hits (undisclosed) | 0 | 9 |
| LibreChat | 2,350 | 2.9 | exposure_detected — correct, on half-wrong evidence | 2 / 2 / 1 | 1 (same location as the wrong Tier A) | 0 / 22 | JS 678, Go 4 (disclosed) | 0 | 10 |
| NextChat | 175 | 0.9 | exposure_detected — correct by accident (only Tier A should be B) | 1 / 1 / 1 | 0 | 0 / 31 | JS 6, Rust 3 (disclosed); Markdown 28 with 50 hits, SCSS 25 (undisclosed) | 0 | 9 |
| anything-llm | 94 | 1.0 | no_exposure_in_completed_surfaces — correct; 22 of 1,242 source files analyzed | 0 / 0 / 0 | 0 | 0 / 0 | JS 1,220 (disclosed); SQL 40 (undisclosed) | 0 | 7 |
| ai (vercel) | 5,278 | 5.3 | exposure_detected — INCORRECT (should be no_exposure_in_completed_surfaces) | 186 / 52 / 52 (4 wrong on their own terms, 48 examples/ sample code; ai-3 extends to all 186) | 12 (10 Tier A + 2 Tier B, all examples/) | 5 entries = 13 locations / 23 | JS 202 (disclosed as 194); Vue 21, Svelte 12 (undisclosed) | 3 reported, 0 real | 12 |
| lobe-chat | 9,795 | 22.2 | exposure_detected — correct by accident (0 real Tier A exist) | 2 / 2 / 2 | 11 (azure.ts catalog deploymentName rows at Tier B) | 0 / 27 | JS 79 (disclosed as 56); SQL 160, MD/MDX 806 (undisclosed) | 1 reported, 0 real | 12 |
| open-webui | 437 | 2.4 | exposure_detected — correct by accident | 1 / 1 / 1 | 0 | 1 / 13 | Svelte 662 (undisclosed); JS 12 (disclosed); Markdown 12 | 0 | 10 |
| ragflow | 2,932 | 3.1 | exposure_detected — correct | 0 / 0 / 0 | 0 | 0 / 18 | Go 2,142, C++ 31 (+23 .cc, 65 .h uncounted), JS 10, C 10 (disclosed); SQL 3, Markdown 221 (undisclosed) | 0 | 11 |
| langflow | 6,120 | 8.9 | no_exposure_in_completed_surfaces — reviewer marked incorrect; adjudication refuted that basis (contract-correct) | 0 / 0 / 0 | 0 | 2 claimed / 24, both refuted | JS 656 (disclosed); MDX 1,391 with 74 doc hits, sh 449 (undisclosed; refuted as a gap) | 0 | 9 |
| langchain | 2,579 | 1.9 | exposure_detected — correct (Tier A unearned, outcome defensible) | 1 / 1 / 1 | 0 | 2 / 80 | JS 2, .ambr 26 (unanalyzedLanguages = []; refuted as a gap) | 0 | 11 |
| continue | 1,505 | 3.2 | exposure_detected — correct by accident (0 real Tier A) | 2 / 2 / 2 | 4 distinct (3 test-fixtures/ YAML rows + 1 JSON-Schema default) + 1 overlapping the Tier A | 2 / 58 | Kotlin 86, JS 60 (76 on disk), Rust 10, Java 4 (disclosed); ipynb 1 | 0 | 11 |
| dify-official-plugins | 6,154 | 8.0 | exposure_detected — correct | 0 / 0 / 0 | 0 | 4 claimed / 65, all refuted | none (0 unsupported code files) | 2 reported, 0 real | 10 |

## 2. Totals and the "zero incorrect PATCH ELIGIBLE" verdict

- Files: 37,685 scanned; 60.5 s total; slowest lobe-chat at 22.2 s for 9,795 files (2.3 ms/file vs 0.5–1.7 ms/file elsewhere).
- Conclusions: 10 correct (5 of those by accident: NextChat, lobe-chat, open-webui, continue, langchain), 1 incorrect (ai), 1 disputed and adjudicated contract-correct (langflow).
- Tier A: 196 total / 62 checked / 60 incorrect. Exactly 2 checked Tier A locations were correct: chatbot-ui `app/api/command/route.ts:24` and LibreChat `config/translations/anthropic.ts:32`. Excluding ai: 10 / 10 / 8.
- False positives listed: 28 (LibreChat 1, ai 12, lobe-chat 11, continue 4+1).
- Misses of checked: 10 confirmed entries of 398 locations checked (ai 5 entries = 13 locations, open-webui 1, langchain 2, continue 2); 6 further claimed misses (langflow 2, dify 4) refuted. 9 of the 10 confirmed misses are under-tiering (reported at Tier C), not absence; the only invisible-by-scanner miss is ai's provider-prefixed ids.
- Phantoms: 6 reported by the harness, 0 real (all verified present at the stated line).
- Clarity issues: 121 quoted.

**Verdict on "zero incorrect PATCH ELIGIBLE findings": NOT MET.** 8 of 9 repos that produced any PATCH ELIGIBLE decision produced at least one wrong one. Offending locations:

| repo | location | model | why it must not be PATCH ELIGIBLE |
|---|---|---|---|
| LibreChat | `client/src/components/Chat/Messages/Content/EditMessage.tsx:138` | gpt-3.5-turbo | `?? 'gpt-3.5-turbo'` default in a React Query mutation to the app's own REST API; backend uses it for tokenizer selection only |
| NextChat | `app/constant.ts:424` | gemini-pro | `export const GEMINI_SUMMARIZE_MODEL = "gemini-pro"`; repo has no provider SDK, requests go via app wrapper + raw fetch + user-set base URL |
| ai | `examples/ai-functions/src/generate-text/anthropic/tool-order.ts:29` | claude-3-5-haiku-20241022 | field of a fake API response body inside `new Response(JSON.stringify({...}))` in a mocked fetch |
| ai | `packages/anthropic/src/anthropic-provider.test-d.ts:7`, `:10`, `:13` | claude-3-haiku-20240307 | vitest type-only assertions; never issues a request |
| ai | 183 further Tier A locations across 16 PATCH ELIGIBLE investigations, all under `examples/` (ai-functions, ai-e2e-next, express, hono, next-openai-pages, next-openai-telemetry*, nuxt-openai, next-workflow) | 16 ids | sample/e2e-fixture code; informational per contract |
| lobe-chat | `packages/business/const/src/llm.ts:8` and `apps/desktop/stubs/business-const/src/index.ts:7` | gemini-3-flash-preview | `export const DEFAULT_ONBOARDING_MODEL = ...`; reaches Google only via lobe-chat's model-runtime wrapper |
| open-webui | `src/lib/utils/index.ts:859` | gpt-3.5-turbo | `const model = ...model_slug || 'gpt-3.5-turbo'` in a ChatGPT-export import parser; fix would relabel users' imported history |
| langchain | `libs/langchain/langchain_classic/evaluation/loading.py:168` | gpt-4 | `ChatOpenAI(model="gpt-4")` wrapper; Mendr's own surface detector says `unknown_wrapper` (max Tier B); the factory path bypasses the guard. Outcome would work here, tier is unearned |
| continue | `core/llm/llms/llm.ts:57` | gpt-3.5-turbo | `this.complete(..., { model: ... ? "gpt-3.5-turbo" : this.model })` on Continue's provider-neutral BaseLLM behind a user-set apiBase |
| continue | `extensions/cli/src/smoke-api/smoke-api-helpers.ts:53` | claude-3-haiku-20240307 | `const SMOKE_MODEL = process.env.SMOKE_MODEL || "..."` at module level in a smoke-test helper |
| chatbot-ui | `app/[locale]/[workspaceid]/layout.tsx:162` | gpt-4-1106-preview | Tier B (type_cast_masked) location printed under "Decision: PATCH ELIGIBLE / A verified auto-fix exists" because `patchEligible` is per investigation, not per location; fix-llm will not rewrite it |

Count: 12 discrete wrong PATCH ELIGIBLE locations outside ai, plus 186 in ai. Repos with a correct PATCH ELIGIBLE set: chatbot-ui (with the leak above), and the three repos that produced none (anything-llm, ragflow, dify-official-plugins).

## 3. Confirmed defects, deduplicated into root causes

### Critical

**C1. TS scanner: any variable whose name matches `/model/i` becomes `model_arg` → Tier A.** `src/usage/scanLiterals.ts:491-499` rule (b); `src/report/classifyOccurrence.ts:42-47` maps model_arg + verified replacement to Tier A with no SDK, callee, base_url, wrapper or module-level guard. Affects 4 repos, 5 PATCH ELIGIBLE locations: NextChat `app/constant.ts:424`; lobe-chat `packages/business/const/src/llm.ts:8`, `apps/desktop/stubs/business-const/src/index.ts:7`; open-webui `src/lib/utils/index.ts:859`; continue `extensions/cli/src/smoke-api/smoke-api-helpers.ts:53`.
Repro: `node dist/cli.js audit <NextChat> --json | python -c "import json,sys;d=json.load(sys.stdin);print(d['investigations'][0]['locations']['selectors'])"` then `sed -n 424p app/constant.ts` and `grep -rnE "from ['\"](openai|@anthropic-ai/sdk|@google/generative-ai)" app || echo NO_SDK`.

**C2. TS scanner: a `model:` property in an object passed to ANY call is `model_arg` — no callee check.** `scanLiterals.ts:379-389` `isEnclosingObjectACallArgument` returns true for every CallExpression; `MODEL_FACTORIES` (line 301) is consulted only for direct string arguments. Affects 4 repos: LibreChat `EditMessage.tsx:138` (React Query mutation, Tier A); ai `tool-order.ts:29` (`JSON.stringify` of a mock response, Tier A); continue `core/llm/llms/llm.ts:57` (internal wrapper, Tier A); chatbot-ui `components/utility/global-state.tsx:80` (`useState` initializer) and `layout.tsx:162` (`setChatSettings`) landed in Tier B only because of a quarantined replacement and an `as LLMID` cast — the one correct Tier A in that repo is correct by luck of the repo, not by rule.
Repro: `node dist/cli.js audit <LibreChat> --json | grep -o 'EditMessage.tsx","line":138[^}]*'`; `sed -n 136,141p client/src/components/Chat/Messages/Content/EditMessage.tsx`.

**C3. No `examples/` directory rule in the TS path.** Neither `scanLiterals.ts` nor `classifyOccurrence.ts` demotes samples/demos; the config scanner (`scanConfig.ts:189`) does. Affects 1 repo, ai: 183 of 186 Tier A and both Tier B locations are `examples/**`; 16 PATCH ELIGIBLE investigations; conclusion flips from no_exposure to exposure_detected; summary says "We found 17 retiring AI dependencies" for a package whose `packages/` contains only type unions and fixtures.
Repro: `node dist/cli.js audit <ai> --json | python -c "import json,sys;d=json.load(sys.stdin);print(sorted(set(l['file'].split('/')[0] for i in d['investigations'] for k,v in i.items() if isinstance(v,list) for l in v if isinstance(l,dict) and l.get('tier')=='A')))"`.

**C4. Test-path filter misses `.test-d.ts` and `smoke-api/`.** `scanLiterals.ts:549-555` regex `\.(test|spec|vitest|e2e)\.[mc]?[jt]sx?$` does not match the vitest type-test suffix, and the directory list lacks smoke-api. Affects 2 repos, 4 PATCH ELIGIBLE locations: ai `packages/anthropic/src/anthropic-provider.test-d.ts:7,10,13` (the only non-examples Tier A in that repo); continue `smoke-api-helpers.ts:53`.
Repro: `node dist/cli.js audit <ai> | grep -n "anthropic-provider.test-d.ts"`.

**C5. Python: `PROVIDER_MODEL_FACTORIES` literals bypass G4 surface/base_url/receiver guards.** `src/python/scanPy.ts:579` exempts factories from the unrecognized-sink cap and the G4 block at `:587-611` runs only `if (sink)`; the variable-hop path (`judgeSinkCall :665-670`) does cap by surface, so the guard is inconsistent. Affects 1 repo (langchain `loading.py:168`, file surface = `unknown_wrapper`, max Tier B) but the probe proves the hole generalizes: `ChatOpenAI(model="gpt-4", base_url="http://localhost:11434/v1")` → A; `base_url="https://openrouter.ai/api/v1"` → A; `def build(ChatOpenAI): return ChatOpenAI(model="gpt-4")` with no import → A.
Repro: `node scripts/tier-probe.mjs <scratchpad>/probe/wrap_localhost.py` → `A line 5`.

### Major

**M1. Report wording "verified direct provider call site" / "verified auto-fix" is keyed on role, never on tier or any verification.** `src/report/auditReport.ts:197` emits it for any selector with `role === 'code_call_site'`; `src/audit/investigation.ts:266-269` grants that role to every Tier B occurrence unless reason is usage_unverified/dynamic_model_value. Affects 9 repos: chatbot-ui, LibreChat, NextChat, ai (calls a Tier B REVIEW REQUIRED item "verified"), lobe-chat ("12 are a verified direct provider call site" — 0 are), open-webui, langchain, continue, dify-official-plugins (two Tier B sites behind a credentials-sourced base_url called "verified direct"). Also ungrammatical in every instance ("Two are a ... site"; `auditReport.ts:216`).
Repro: `node dist/cli.js audit <dify-official-plugins> | grep -n "verified direct"`.

**M2. Default-value selectors that feed an SDK/HTTP request are filed as Tier C "code data reference" / "no selector".** Python: `scanPy.ts:563` treats class_body + call as catalog; TS: `scanLiterals.ts:484-486` files non-call-argument objects as catalog_entry and `:512-518` accepts string call args only for MODEL_FACTORIES callees. Affects 4 repos, 7 locations: open-webui `backend/open_webui/routers/images.py:205` (`else 'dall-e-2'` → `session.post(.../images/generations)`, retired 114 d); langchain `libs/partners/openai/langchain_openai/chat_models/base.py:731` (`Field(default="gpt-3.5-turbo")`, class default of `ChatOpenAI`, retires in 50 d) and `llms/base.py:176` (`gpt-3.5-turbo-instruct`, 25 d); continue `core/config/onboarding.ts:73,82` (gemini-3-pro/flash-preview written into user config on onboarding) and `core/llm/llms/Anthropic.ts:66` (claude-2 → claude-2.1 wire remap, minor); lobe-chat `apps/cli/src/commands/generate/image.ts:10` (`.option('-m, --model <model>', 'Model ID', 'dall-e-3')` → `createImage.mutate({ model: options.model })`). In three of these repos the false Tier A above sits next to the real exposure that was demoted.
Repro: `node scripts/tier-probe.mjs <open-webui>/backend/open_webui/routers/images.py` → `C line 205 dall-e-2 position=data purpose=generic`; then `sed -n '200,206p;619,650p'` the same file.

**M3. Provider sub-factories are not in `MODEL_FACTORIES`, so real call sites get "code data reference / no selector".** Allow-list is {google, openai, anthropic, createOpenAI, createAnthropic, createGoogleGenerativeAI, getGenerativeModel, generativeModel, languageModel, chat}; `openai.responses`, `openai.image`, `openai.imageModel`, `azure(...)`, `google.embeddingModel`, `anthropic.messages`, and `createAnthropic()` instances fall through. Affects ai (`examples/ai-e2e-next/app/api/chat/openai-responses/route.ts:18`, `generate-text/azure/reasoning.ts:11`, `generate-image/openai/many.ts:8`, `embed/google/basic.ts:7`, `custom-provider-name.ts:18` vs `:54` in the same file) and a synthetic production app where `generateText({ model: openai.responses('gpt-3.5-turbo') })` at `src/app.ts:17` and `azure('gpt-3.5-turbo')` at `:26` are the only call sites and read "code data reference" — a false-clean path. Same cause yields two tiers for one construct in one file (ai `test-d.ts:13` chat → A, `:16` messages → C).
Repro: `node dist/cli.js audit <scratchpad>/synthetic | grep -n "app.ts:17\|app.ts:26"`.

**M4. `azure_deployment` is routed before the catalog guard.** `scanLiterals.ts:477-479` returns azure_deployment for any `deploymentName:` key before `isEnclosingObjectACallArgument` at `:481` is consulted. Affects 1 repo, 11 locations: lobe-chat `packages/model-bank/src/aiModels/azure.ts:190,256,313,343,373,457,542,569,595,647,701` — `config: { deploymentName: '<id>' }` rows of an `AIChatModelCard[]` catalog whose sibling `id:` fields are correctly Tier C; they make up 11 of the "12 retiring AI dependencies" in the summary and receive a `gpt-5.6-sol` migration suggestion that is meaningless for customer-chosen Azure deployment names.
Repro: `sed -n 1,3p <lobe-chat>/packages/model-bank/src/aiModels/azure.ts && sed -n 188,192p` the same file.

**M5. Config fixture-path regex misses `test-fixtures/` and `-test-config.yaml`; JSON-Schema `default` examples are treated as live config.** `src/config/scanConfig.ts:191` matches `fixtures?/` but not `test-fixtures/`; `:194` does not match `-test-config.yaml`. Affects 1 repo, 4 Tier B locations: continue `extensions/cli/test-fixtures/model-switch-test-config.yaml:7,12,17` (`apiKey: test-api-key-N`) — 2 of the 3 REVIEW REQUIRED decisions and the sentence "Three are a possible configuration selector"; and `extensions/vscode/config_schema.json:2752` (a `"default": [...]` example with `"apiKey": "sk_..."`, while the other 33 ids in the same file are catalog).
Repro: `node dist/cli.js audit <continue> | grep -n "model-switch-test-config.yaml\|config_schema.json:2752"`.

**M6. `patchEligible` is computed per investigation (`src/cli.ts:3062`) and the text report prints every selector of a patch investigation under "PATCH ELIGIBLE / A verified auto-fix exists for the code call site(s)".** Affects chatbot-ui `layout.tsx:162` (Tier B type_cast_masked; fix-llm will not touch it; the engineer is told both sites get fixed and only `route.ts:24` does). The JSON-level variant was refuted (per-location `tier` exists), the text-level defect stands.
Repro: `node dist/cli.js audit <chatbot-ui> --json | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const i=j.investigations.find(x=>x.model==='gpt-4-1106-preview');console.log(i.patchEligible,i.locations.selectors.map(s=>s.file+':'+s.line+' '+s.tier))"`.

**M7. `src/audit/languages.ts:21-26` UNANALYZED map has no `.sql`, `.svelte`, `.vue` entries, so those files are dropped silently and omitted from "Limits of this run".** Affects 5 repos with content: chatbot-ui (26 SQL files, 36 hits, including the live production default — `supabase/migrations/20240125192042_upgrade_openai_models.sql:96` stamps `'gpt-4-turbo-preview'` (retired 161 d) into every new user's `default_model` via the `create_profile_and_workspace()` trigger; `layout.tsx:161` → `chat/openai/route.ts:28` sends it to `chat.completions.create`); open-webui (662 Svelte files, the whole frontend, with `Audio.svelte:492 TTS_MODEL = 'tts-1'`); ai (21 Vue, 12 Svelte, no ids); anything-llm (40 SQL, no ids); lobe-chat (160 SQL, no ids); ragflow (3 SQL, no ids).
Repro: `node dist/cli.js audit <chatbot-ui> --json | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(j.coverage.source.unanalyzedLanguages)"` → prints only JavaScript.

**M8. Headline overclaims a clean result when unanalyzed languages dominate.** `auditReport.ts:179-181` prints "We found no retiring AI dependencies in use ... not as something this application selects" regardless of coverage ratio. Affects anything-llm: 22 of 1,242 source files (1.8%) analyzed, and the four "informational" ids are the hardcoded defaults of first-party OpenAI SDK calls in unanalyzed JS (`server/utils/AiProviders/openAi/index.js:24` → `responses.create` at `:155-157`; `server/utils/agents/index.js:318,373,375`; `server/utils/ImageGenerators/openAi/index.js:15`).
Repro: `node dist/cli.js audit <anything-llm>`; `grep -n 'gpt-4.1-nano' server/utils/AiProviders/openAi/index.js server/utils/agents/index.js`.

**M9. Provider-prefixed ids (`'openai/gpt-5-nano'`, `'google/gemini-2.0-flash'`, `'openai:gpt-5-mini'`) are invisible and the blind spot is undisclosed.** Exact-value matching only. Affects ai: 13 locations (`generate-text/gateway/pdf.ts:7` retired gemini-2.0-flash; `gateway/tool-*.ts:6` × 8; `stream-text/gateway/image-edit-tool.ts:10,42`; `stream-text/gateway/auth.ts:133` `gateway('openai/gpt-4')`; `registry/stream-text-openai.ts:7` `registry.languageModel('openai:gpt-5-mini')` — `languageModel` is in the allow-list, only the prefix hides it).
Repro: `grep -rn "model: '\(openai\|google\|anthropic\)/" <ai>/examples/ai-functions/src` then confirm none appear in `reported[]`.

**M10. Coverage counts test files as "scanned" while their literals are skipped, and never says so.** `scanPy.ts:952/1057` `isPyTestPath`, `scanLiterals.ts:251/591` `isTestPath`. Affects 6 repos: langchain (815 of 2,579 Python files, 137 registry hits, major); LibreChat (1,219 of 3,565 TS files, 1,280 hits); lobe-chat (~3,354 files, 2,082 hits); NextChat (35 of 183); ragflow (13 hits); dify-official-plugins (~100 hits in 17 files). The summary sentence "N further ids appear only in catalog, documentation or fixture data" is then asserted about files that were not read.
Repro: `grep -n 'files scanned' <validation>/langchain.report.txt; grep -n 'isPyTestPath(source.path)' src/python/scanPy.ts`.

**M11. JavaScript unsupported hides the repos' real call sites (disclosed, product gap).** See section 5; LibreChat-4 and anything-llm-2 are the confirmed instances.

### Minor

**m1. "Next action: Track until the retirement date" printed on entries already OVERDUE** (720 d, 666 d, 636 d, 454 d, 114 d). Affects NextChat, open-webui, langchain, continue (the undated branch correctly says "Monitor provider status", so only the dated-overdue branch is wrong). Repro: `grep -n -B8 'Track until the retirement date' <validation>/langchain.report.txt | grep OVERDUE`.

**m2. Undefined vocabulary that survived refutation:** `Retirement: listed` (auditReport.ts:35 fallback, no source link, undefined); registry states `verified / unverified / quarantined / unverifiable` never explained; replacement ids `gpt-5.6-sol / -terra / -luna` unexplained and inconsistent to the eye (gpt-4 → gpt-5.6-sol, gpt-4-32k → gpt-4o); `○ Generated output: excluded — dirs: .git`; `16 deprecated model(s)`; surface tags `provider_ambiguous` etc. Affects all 12 repos. ("Reader tie-back" undefined was refuted — it is defined in the footer — but it is still printed 16–78 times per report before that definition.)

**m3. Location truncation drops code rows behind catalog rows.** ragflow gpt-3.5-turbo: 5 `conf/*.json` rows then "… and 3 more" hides the only code reference (`rag/app/resume.py:49`); same for gpt-5 (`rag/llm/chat_model.py:203`, `model_meta.py:1183`). Repro: `node dist/cli.js audit <ragflow> | grep -n -A6 'Model: gpt-3.5-turbo  (openai)'`.

**m4. Unanalyzed counts are wrong or incomplete.** lobe-chat JS 56 reported vs 79 on disk (`languages.ts:53` skips dot-directories, so `.agents/` 13 and `.github/` 10 are dropped while dot-files are counted); ai JS 194 vs 202; ragflow C++ 31 vs 31 .cpp + 23 .cc + 65 .h; continue ipynb 1 unnamed; Markdown/MDX never named anywhere (28 / 806 / 221 / 1,391 files).

**m5. Summary wording for Tier B defaults:** ragflow "We found two retiring AI dependencies. / Two are a possible code call." for two `__init__` parameter defaults every production caller overrides.

**m6. Registry content gaps (not scanner faults):** `gemini-1.0-pro-vision-latest` absent (ragflow `rag/llm/cv_model.py:883`, structurally identical to a reported Tier B); `text-embedding-ada-002` and `text-embedding-004` absent (anything-llm `.env.example` ×13).

## 4. Refuted claims worth knowing

- **Same replacement both "verified" and "quarantined"** (LibreChat): registry is per migration pair; gpt-3.5-turbo→gpt-5.6-terra verified, gpt-3.5-turbo-16k-0613→gpt-5.6-terra quarantined. Both lines correct.
- **Duplicate `.env.example:632` location** (LibreChat): the line contains `gpt-image-1` twice (columns 23 and 63). Two real hits; the report simply lacks column numbers.
- **All 6 harness "phantoms"** (ai ×3 dall-e-3, lobe-chat image.ts:10, dify dalle2.py:40 / dalle3.py:47): ids present verbatim at the stated line. Harness search defects (missing `dall-e-2` key; boundary-aware match failing on `model="dall-e-3",`; stale partial clone).
- **langflow `vertexai.py:23` `value="gemini-1.5-pro"` as Tier B / false-clean**: the literal is the `value=` kwarg of `MessageTextInput(...)`, a capitalised non-SDK constructor in a class-body list; scanPy G1/G2 deliberately classes it as UI-schema data, and no in-file name binds it to `ChatVertexAI(model_name=self.model_name)` — the link is framework reflection the contract does not cover. Contract-consistent Tier C; a real product concern, not a misclassification.
- **langflow `provider_service.py:27` preference tuple**: a model list (explicit Tier C); runtime lookup filters with `include_deprecated=False`, so a retired id is never selected.
- **dify `tool_parameters.get("model", "gpt-image-1")` defaults and YAML `default: gpt-image-1`**: the literal is the fallback of a runtime config read (contract: deliberately invisible) and only ever splatted; the YAML `default` sits in a `form: form` select block (UI option list). Both contract-correct at C. The reviewer's concern that the one id retiring in 50 days is filed as "not a dependency" remains a product question.
- **Commented `# OPEN_MODEL_PREF='gpt-4.1-nano'` lines as "config catalog reference"** (anything-llm): template/doc material is Tier C by contract; label is taste.
- **Text report shows 4 locations, JSON 12** (anything-llm): "(4)" counts ids; one exemplar per id is by design (`auditReport.ts:241-247`).
- **"Five dependencies" vs "52 models"** (continue) and "one dependency" vs "25 models" (langchain): reconciled in-report (5 + 47 = 52).
- **`.js` (2) / `.ambr` (26) not named** (langchain), **`.ipynb` not named** (continue): below `MIN_FILES=3` or fixture data; zero ids lost.
- **JS count 60 vs 76** (continue): exact under the `vendor` exclusion (`core/vendor` holds 16).
- **Tier-B cap message "could not be resolved to a first-party provider client"** (dify dalle3.py): literally true — `resolveReceiverSurface` (`sinks.ts:402-405`) refuses to bind a constructor carrying a base_url override.
- **JSON has no per-location patch flag** (continue): each selector carries `tier`; Tier A is patch-eligible by definition.

## 5. Product gaps quantified against the founder's list

Unsupported code files across the 12 repos: JavaScript-family 2,947 (11 of 12 repos), Go 2,146, Svelte 674, SQL 229, C/C++ 129, Kotlin 86, Vue 21, Rust 13, Java 4, ipynb 1. Documentation not read: Markdown/MDX ≥ 2,458 files.

1. **JavaScript / JSX / MJS / CJS — 2,947 files, present in 11 of 12 repos; the single largest hole.** Strongest example: LibreChat `api/server/services/Endpoints/assistants/title.js:24-25` `openai.chat.completions.create({ model: 'gpt-3.5-turbo', ...})` on `new OpenAI({ apiKey, ...opts })` (`initalize.js:59`), reached from `chatV1.js:716` / `chatV2.js:555` — the repo's only production call hitting the 2026-10-23 shutdown, invisible, while the audit flagged a false TS site instead. Second: anything-llm — 162 of 174 registry-id occurrences (93%) in JS; `server/utils/AiProviders/openAi/index.js:20-24` `new OpenAIApi({ apiKey })` + `this.model = ... || "gpt-4.1-nano"` → `responses.create({ model: this.model })` at `:155-157`. Also lobe-chat `.i18nrc.js:30 modelName: 'gpt-4o'`, `.seorc.cjs:5 'gpt-4o-mini'`, continue `core/llm/tiktokenWorkerPool.mjs:4`. JSX is folded into "JavaScript" without being named (anything-llm 463 .jsx).

2. **More configuration formats — SQL 229 files (4 repos), all undisclosed; `.ambr` snapshots; Markdown 2,458+.** Strongest: chatbot-ui `supabase/migrations/20240125192042_upgrade_openai_models.sql:96` — the Postgres trigger `create_profile_and_workspace()` inserts `'gpt-4-turbo-preview'` (retired 161 d) as `default_model` for every new workspace; this is the app's actual production default and the report says the only unread code is 6 JS build files. Plus the earlier version at `20240108234541_add_profiles.sql:129` and 5 `UPDATE ... SET default_model = 'gpt-4-turbo-preview'` data migrations at lines 4,14,24,34,44. The `.env.example` surface works but reports commented lines as "config catalog reference" (24 locations across anything-llm).

3. **Wrapper and variable data-flow tracing — the root of every wrong PATCH ELIGIBLE (C1, C2, C5) and of 9 of 10 confirmed misses (M2).** The TS path has none of the Python path's G1–G5 guards: no SDK/import/receiver check, no base_url check, no module-level cap, no examples/ rule. Strongest single example: open-webui, where the parser label `src/lib/utils/index.ts:859` (never reaches any request) is PATCH ELIGIBLE and the real default `images.py:205` `else 'dall-e-2'` → `session.post(f'{IMAGES_OPENAI_API_BASE_URL}/images/generations')` is "no selector / track until the retirement date" (114 d past). Quantified across repos: 12 wrong Tier A outside ai vs 2 right; langchain class defaults `Field(default="gpt-3.5-turbo")` (50 d) and `"gpt-3.5-turbo-instruct"` (25 d) at Tier C; 13 provider-prefixed selectors invisible in ai.

4. **Monorepo support — 4 of 12 repos are workspaces and the scanner treats them as one flat tree.** Strongest: vercel/ai — 183 of 186 Tier A are `examples/**` sample apps; `packages/` (the product) has zero exposure; conclusion wrong. Also lobe-chat (`apps/desktop/stubs/business-const` duplicates `packages/business/const` and is excluded from the root tsconfig, yet is a second PATCH ELIGIBLE site), anything-llm (the only TS scanned is the unrelated `open-computer/` CLI, 1.8% of source), langflow (`src/bundles`, `src/backend`, `src/lfx` each with own catalogs). No workspace/package boundary, no examples/ rule, no per-package conclusion.

5. **Large-repository performance — not a blocker.** 37,685 files in 60.5 s. lobe-chat is the outlier: 9,795 files in 22.2 s (2.3 ms/file) vs ai 5,278 in 5.3 s (1.0 ms/file), langflow 6,120 in 8.9 s (1.5 ms/file), dify 6,154 in 8.0 s (4 s on rerun). No timeouts, no errors, reruns reproduced identical results.

6. **Stable JSON output contract — three observed inconsistencies.** (a) `patchEligible` is per investigation while the text report renders per location (chatbot-ui `layout.tsx:162`); (b) no column offset, so two hits on one line render as an apparent duplicate (LibreChat `.env.example:632`); (c) text and JSON disagree by design (anything-llm 4 vs 12 locations; "… and 74 more" in ai) with no pointer from text to `--json`. The harness also truncated `raw.unmatched` at 400 of 1,428–2,278 entries in 3 repos.

7. **Predictable exit codes — no data.** No run in this set exercised or recorded an exit code; unmeasured.

8. **Supported-language and provider matrix — the matrix Mendr believes in and the one it ships differ.** `languages.ts` UNANALYZED map lacks `.sql`, `.svelte`, `.vue`, `.ipynb`, `.cc`/`.h`; skips dot-directories but not dot-files; `MIN_FILES=3` hides small surfaces silently. Provider side: `MODEL_FACTORIES` lacks `openai.responses/image/imageModel`, `azure`, `google.embeddingModel`, `anthropic.messages`; Azure `deploymentName` fires before the catalog guard (11 false Tier B); gateway/registry `provider/` and `provider:` prefixes unsupported; the Python factory path (`ChatOpenAI` etc.) skips the surface cap. Registry: 3 retired/deprecated ids absent (`gemini-1.0-pro-vision-latest`, `text-embedding-ada-002`, `text-embedding-004`).

## 6. Clarity: top wording problems and rewrites

1. **"Two are a verified direct provider call site."** (9 repos; false in 8) → "1 is a model id passed directly to a first-party provider SDK request (auto-fix available). 1 is a code default we could not trace to a provider request — review before changing."

2. **"Location: app/constant.ts:424 — code call site (model argument)"** (a constant declaration; same mislabel for `useState`, `setChatSettings`, `deploymentName`, `const SMOKE_MODEL`) → "app/constant.ts:424 — exported constant `GEMINI_SUMMARIZE_MODEL`; no provider request found in this file."

3. **"Reason: A verified auto-fix exists for the code call site(s) — fix-llm can migrate to gpt-5.6-sol in place. It is proposed as a reviewed PR, never auto-merged."** → "Next: run `mendr fix-llm <path>` to open a PR rewriting app/api/command/route.ts:24 to gpt-5.6-sol. app/[locale]/[workspaceid]/layout.tsx:162 will NOT be rewritten (type cast). No PR exists until you run the command."

4. **"Retirement: retired — 720d OVERDUE (2024-09-13) … Next action: Track until the retirement date"** → "Retired 2024-09-13 (720 days ago). Requests using this id fail today. Replace it now."

5. **"We found no retiring AI dependencies in use."** (anything-llm, 1.8% of source analyzed) → "No retiring model ids in the 22 TypeScript/Python files analyzed. 1,220 JavaScript files (98% of this repo's source) were NOT analyzed; this result says nothing about them."

6. **"Limits of this run: these languages are present but NOT analyzed: JavaScript (6 files)"** (chatbot-ui, omits 26 SQL files with the production default) → "Not analyzed: SQL (26 files, 36 retiring-id mentions incl. supabase/migrations), JavaScript (6 files, build config). Test/spec files (N) are counted but their model ids are not examined."

7. **"○ Generated output: excluded — dirs: .git"** → "Excluded directories: .git, artifacts, build. Test and fixture paths: skipped by rule (N files)."

8. **"16 deprecated model(s): 1 patch, 1 review, 14 monitor"** → "16 deprecated model ids: 1 patch-eligible (no change applied), 1 needs human review, 14 informational only."

9. **"Retirement: listed — 720d OVERDUE (2024-09-13)"** → "Retirement date 2024-09-13 (from Mendr registry; no provider source link) — 720 days past."

10. **"Migration evidence: gpt-5.6-terra [registry: quarantined] (quarantined — not a recommended swap)"** → "Registry replacement candidate: gpt-5.6-terra — not verified for this migration pair; do not swap automatically. Choose a replacement during human review."

11. **"Reason: Only catalog / reference / data occurrences found (no selector)."** (printed on `openai.image('dall-e-3')`, `images.py:205`, `Field(default="gpt-3.5-turbo")`) → "Found only in positions Mendr classifies as data (lists, comparisons, defaults, sub-factory calls). If this value sets a default that reaches a request, treat it as exposure and review manually."

12. **"Reader tie-back: not proven"** (16–78 repetitions per report before its footer definition) → print once in coverage as "Config-to-runtime link: not proven (Mendr does not yet verify that a config value controls the model actually requested)" and drop it from per-model blocks that have no config locations.

## 7. What is still unmeasured

Nothing in this validation observed an engineer reading a Mendr report: every clarity finding is a reviewer's inference from the text, so whether a senior engineer opens the right file, runs `fix-llm` only on the correct sites, ignores the fixture rows, and keeps trusting the tool after the first mislabeled "code call site" is unknown. Also unmeasured: time-to-correct-action, whether the JSON contract is consumed without the text, and exit-code behaviour — none of which can be established without human testers on real repositories.