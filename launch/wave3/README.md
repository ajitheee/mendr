# wave 3 — verified, ready to file, NOT yet filed

Found by GitHub code search for live call sites (not README/doc matches), then each candidate was
cloned, scanned with the shipped v0.5.0-alpha, traced for reachability, and checked for an
existing duplicate issue. Then an adversary re-read every cited line in the repo itself.

**The adversary returned FIX on all four drafts.** Every one contained a factual error that would
have been visible to the maintainer. The bodies in this directory are the CORRECTED versions.

| repo | stars | the finding | date | days |
|---|---|---|---|---|
| guardrails-ai/guardrails | 7,421 | `LiteLLMCallable._invoke_llm` binds `model="gpt-3.5-turbo"` (llm_providers.py:149), reaching `litellm.completion` at :208 | 2026-10-23 | 37 |
| skywalker023/sodaverse | — | `openai.Completion.create(model="gpt-3.5-turbo-instruct")` hardcoded in co3.py:50, not governed by `--model` | 2026-09-28 | **12** |
| microsoft/TinyTroupe | 7,570 | `REASONING_MODEL=o3-mini` default (config.ini:22 + `__init__.py:99` fallback) | 2026-10-23 | 37 |
| going-doer/Paper2Code **[FILED #31]** | 4,954 | `GPT_VERSION="o3-mini"` in scripts/run.sh:3, the documented Quick Start | 2026-10-23 | 37 |

## What the adversary caught (why this pass exists)

- **guardrails** — draft claimed provenance "main as of the 2026-09-13 push". main's HEAD is
  `06d0ff2c`, committed 2026-08-26; the 2026-09-13 `pushed_at` was not a push to main. Also
  miscounted the test-fixture hits (61 occurrences, 45 in tests/, not "43 are test fixtures").
- **TinyTroupe** — draft claimed ":457 is the only chat-completions call site". There are two
  inside `_raw_model_call` alone, and the traced Proposition path reaches the *other* one
  (`beta.chat.completions.parse` at :449) because `LLMChat` sets a json_object response format.
- **Paper2Code** — **the title was false.** `o4-mini` is not reachable from the Quick Start;
  `codes/4_debugging.py` is referenced by no script in `scripts/` and appears nowhere in the README.
- **sodaverse** — three off-by-one line citations (each one the maintainer would click), the word
  "unconditional" applied to a loop containing `continue` and `break`, and an unsupported
  assertion about how often the author's own dataset has an empty `y` field.

## Rejected, and why

| repo | killed by |
|---|---|
| allenai/molmo | archived ~21 months, **and issue #30 already reports this exact failure** |
| eth-sri/lmql | abandoned — last code commit ~28 months ago; nobody would read it |
| smol-ai/developer | abandoned — ~36 months since the tracked code changed; the finding itself was real |
| DeepInsight-AI/DeepBI | not a live call — token-accounting lookup table in a function with zero callers |

## The false positive worth remembering

Code search proposed `gpt-4-0613` in **microsoft/TinyTroupe** and **DeepInsight-AI/DeepBI**. In
both it is the verbatim OpenAI-cookbook token-counting table — a dict mapping model names to
per-message token overhead, computed locally via tiktoken, never sent anywhere. Mendr independently
classified all of TinyTroupe's hits as `code data reference / MONITOR` and never surfaced the
docstring occurrence at all.

That is the scanner being right where a grep would have been wrong, and it is the single best
argument for the Tier A/B/C split. It is also why "search for the string and email the owner" does
not work as an outreach strategy.

## Filed

- **going-doer/Paper2Code** — https://github.com/going-doer/Paper2Code/issues/31 (2026-09-16).
  Every citation re-verified at source before filing: `run.sh:28/41/47`, `1_planning.py:12/23/249`,
  `eval.py:243`, `4_debugging.py:109-114` and its `create` call at `:249`, all at HEAD `ba91699`.
  This is the repository that produced v0.5.1-alpha — its `argparse` default is what the scanner
  was calling documentation — so the disclosure line says the tool missed it and now does not.
- **danny-avila/LibreChat** — https://github.com/danny-avila/LibreChat/issues/16017 (2026-09-16).
- **evalstate/fast-agent** — https://github.com/evalstate/fast-agent/issues/959 (2026-09-16).

All four are now filed:

- **skywalker023/sodaverse** https://github.com/skywalker023/sodaverse/issues/11 (2026-09-17)
- **guardrails-ai/guardrails** https://github.com/guardrails-ai/guardrails/issues/1657 (2026-09-17)
- **microsoft/TinyTroupe** https://github.com/microsoft/TinyTroupe/issues/166 (2026-09-17)
- **going-doer/Paper2Code** https://github.com/going-doer/Paper2Code/issues/31 (2026-09-17)

Re-verified at the moment of filing, not trusted from the day before: every cited line still
existed at current HEAD, no duplicate had appeared overnight, and the hardcoded day counts were
recomputed. The drafts said "12 days from today (filing this 2026-09-16)" and "37 days"; filed a
day later those were both wrong by one, which is exactly the kind of small inaccuracy that makes a
maintainer stop trusting the rest. Now 11 and 36.
