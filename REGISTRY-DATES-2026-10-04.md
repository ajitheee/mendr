# Registry dates — the 2026-10-23 gap, and the check that closes the class

2026-10-04. Branch `registry/literal-rows`. L1 and L2 of the change-intelligence plan, plus the
data they surfaced.

## The defect, reproduced before anything was changed

On the shipped `v0.5.7-alpha` build, offline, clock pinned to `2026-10-04T12:00:00Z`, a repository
whose only model call is

```ts
client.chat.completions.create({ model: "o1", messages: [...] })
```

audited **NO EXPOSURE IN COMPLETED SURFACES**, with the registry graded fresh. OpenAI switches `o1`
off on **2026-10-23**, 19 days later. Coverage honesty could not catch it: the source surface really
did complete. The gap was in the data.

An eight-call probe found five 2026-10-23 ids with no finding at all (`o1`, `o1-pro`,
`o3-mini-2025-01-31`, `o4-mini-2025-04-16`, `gpt-4.1-nano-2025-04-14`) and one false deadline
(`gpt-5`: Tier A patch, "68 days", a date OpenAI never set).

## Four causes, each confirmed rather than inferred

1. **A cell listing a snapshot and its aliases was skipped as ambiguous.** OpenAI writes
   `o1-pro-2025-03-19 | o1-pro` in one model cell. `discover` refused every such row. It is not
   ambiguous: the row's date and replacement apply to every id it lists.
2. **`o1` could not be seen at all.** A model id had to contain `-` or `.` (to reject bare words like
   "ada"). `o1`, `o3`, `o4` have neither, so the parser read the o1 row as `o1-2024-12-17` alone.
3. **The refusals never reached a person.** The CLI printed 12 skips and "+N more"; the review PR
   said "see the job log". On 2026-10-01 that hid 46 of 58 refused rows. Confirmed by running the
   parser directly over the live page: the 2026-10-23 rows are among them, each reading
   "deprecated cell names N model ids -- ambiguous, needs a human".
4. **An inference shipped as a provider statement.** `gpt-5`, `gpt-5-mini`, `gpt-5-nano`,
   `gpt-5-pro` carried 2026-12-11, labelled "Provider-named", verified, auto-appliable. OpenAI
   retires only the dated snapshots that day ("older GPT-5 and o3 model snapshots"); its own
   `gpt-5` page lists the alias pointing at `gpt-5-2025-08-07` with no deprecation. These came from
   the August research pass, not from `discover`.

Found along the way, same family: **`gpt-5-pro-2025-10-06` and `o3-pro-2025-06-10` shipped as
auto-appliable swaps to plain `gpt-5.6-sol`**, while OpenAI's row names
`gpt-5.6-sol (reasoning.mode: pro)`. An unattended swap would turn pro mode off silently.

## What shipped

| commit | slice |
|---|---|
| `f7f8855` | L1a — a pure list of ids becomes one candidate per id; `o`+digit ids are seen; catalog listings (no date, no replacement) are not review items |
| `0bc07d4` | L1b — every refused row printed, lifted into the PR body and one standing issue |
| `72a881b` | L2 — `mendr check-dates`, wired into `registry-verify` |
| `5af25b4` | data — the four `gpt-5` alias deadlines removed |
| `9c20665` | data — 21 past alias retirements labelled `inferredFrom` their snapshot |
| `493ed2b` | data — 8 ids retiring 2026-10-23 promoted through the unchanged gate |
| `6dbda93` | data — 4 `reasoning.mode: pro` replacements quarantined (detect-only) |
| `a743592` | tests — the registry's new shape acknowledged |

### What `check-dates` means by a date being supported

| verdict | rule | fails the job |
|---|---|---|
| confirmed | the provider page names this id with this date | no |
| was-stated | a **past** date the provider has since pruned, quoted from that page by the entry's stored evidence | no |
| inferred | a **past** date for an id the provider never names, inferred from a snapshot the page states with that date (`inferredFrom`) | no |
| inferred-future | a **future** date that is inferred, not stated | **yes** |
| date-differs / date-unstated / absent | the page does not support the date | **yes** |
| unchecked | no date claimed, or a source page the check does not read | no (counted) |

The page is read by `readModelRows`, the parser `discover` uses, so the two cannot disagree about
what a provider wrote. "Past" uses the audit's clock (`MENDR_EVALUATED_AT` honoured). An unreadable
page exits 2.

### `check-dates` against the live pages

| | before (main) | after (this branch) |
|---|---|---|
| confirmed | 99 | **109** |
| was stated, row since removed | — | 1 (`gemini-omni-flash-preview`) |
| inferred, past only | — | 21 |
| **failing** | **26** | **0** |
| not judged | 32 | 32 (14 claim no date; 18 cite Google's changelog, which the check does not read) |

## The benchmark that found it

Answer key: every id in a 2026-10-23 or 2026-12-11 row of OpenAI's deprecations page, read raw on
2026-10-04 (29 ids). Frozen before scoring.

| | dated correctly | false deadlines | provider's replacement |
|---|---|---|---|
| Mendr, main | 19/29 | 4 | 18 of 19 |
| **Mendr, this branch** | **29/29** | **0** | 28 of 29 |
| LiteLLM model map | 25/29 | 0 | not carried |
| Portkey model catalog | 0/29 | 0 | not carried |

The one replacement Mendr gets wrong is `gpt-image-1`: the registry says `gpt-image-2`, OpenAI
offers `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare`. The entry is `unverifiable` (never
auto-applied). Choosing between the two is a person's call; left open.

## Corpus: registry-only before/after

The scanner code is unchanged by this branch, so the comparison runs **one build twice** per
repository: once with main's registry file, once with this branch's (`MENDR_REGISTRY_FILE`), clock
pinned to `2026-10-05T00:00:00Z`, each run into its own directory. The build and both registry files
were fingerprinted before and after (`7f8e1a7d02c994b7`, `ef8b34791033cc46`, unchanged), so any
difference is the data's.

**September's clones are gone, and its document records commits for 2 of 12 repositories**, so that
run cannot be re-derived. This one records all twelve:

| repository | commit |
|---|---|
| chroma-core/chroma | `e5c22977da46f9410c2e8f2aea54c45d84d29299` |
| evalstate/fast-agent | `e8fd010d8b53ea02b23b8b44b7d24abbc56536f5` |
| guardrails-ai/guardrails | `06d0ff2c5f9bcb493d976b76f885e37e41ce845d` |
| langchain-ai/langgraph | `9a0394d88b2211f299dcd69df92db3480c69ee61` |
| danny-avila/LibreChat | `f10b1d91f1eee3a2c82d5247bf620351486b7c1b` |
| BerriAI/litellm | `be4481779ee8a73579af82a3b5394f62f4e4b057` |
| run-llama/llama_index | `962940ddc079cc21701d28d1237c84c82a7c5164` |
| openai/openai-cookbook | `0eac1447d4e24d06e47c459ca5e98f248b9413cf` ¹ |
| going-doer/Paper2Code | `ba9169978043d5799c8d4f4a0963e6b66a24c2e1` |
| promptfoo/promptfoo | `29a2e4fcdb17ebcc9d7e3270d7bf7fa822e38f44` |
| skywalker023/sodaverse | `80eafd3705102c12644b7243a80b1b483ddd97e8` |
| microsoft/TinyTroupe | `a6244b358a1fe1c71bf751f7ba0f8dfa368ec5a4` |

¹ exported with `git archive`, excluding `examples/data/hotel_invoices/` (125 invoice JSON files):
a directory name ending in a space cannot be created on Windows.

### Result

**12 of 12 conclusions unchanged. No Tier A location changed, and no actionable finding was
added.**

| change | locations | what they are |
|---|---|---|
| + added | 291 | all informational (catalog, capability check, test fixture) references to the 2026-10-23 ids: `o1` 162, `o1-pro` 44, `gpt-4.1-nano-2025-04-14` 33, `o4-mini-2025-04-16` 22, `o3-mini-2025-01-31` 17, `o1-pro-2025-03-19` 13 |
| − removed | 1,521 | informational references to the `gpt-5` aliases, each carrying the false 2026-12-11 deadline |
| − removed | **14** | **Tier B review findings on `gpt-5` aliases** — the only actionable changes in the corpus |
| ~ changed | 20 | informational `o3-pro-2025-06-10` / `gpt-5-pro-2025-10-06` references, now quarantined |
| unchanged | 13,224 | |

Every one of the 14 removed review findings was read in its source: each is a real, live use of a
`gpt-5` alias (`chroma`'s Next.js route `openai("gpt-5-nano")`, `fast-agent`'s
`DEFAULT_OPENAI_MODEL = "gpt-5-mini"`, `litellm`'s `proxy_server_config.yaml`, `tinytroupe`'s
`MODEL=gpt-5-mini`, four `openai-cookbook` defaults). Removing them is correct: OpenAI has set no
date for those aliases.

The short id `o1` was the precision risk. All 162 new `o1` locations are genuine references to the
`o1` model (`startsWith('o1')` capability checks, model lists, test providers built with `'o1'`), and
all are classed informational. None of these repositories calls `o1` at a live site.

## A public claim this was the source of

`evalstate/fast-agent#959`, filed 2026-09-16, says *"OpenAI's deprecations page lists `gpt-5-mini`
with a 2026-12-11 shutdown."* It does not: it lists `gpt-5-mini-2025-08-07`. That is this document's
defect, in public, in a stranger's repository. A contributor has since opened
`evalstate/fast-agent#974` changing the default to `gpt-4.1-mini`, a model OpenAI does not designate,
on the strength of it. The other six issues filed in September were checked against the corrected
registry: their dates are on the provider pages, or they make no provider-date claim.

## Open, deliberately not done here

- **The correction on `fast-agent#959` is Ajith's to post.** Nothing outward-facing was sent.
- **Bundled-registry users still miss `o1` until a new tag.** Refresh-enabled scans (every
  App-generated workflow) get the signed snapshot registry-publish makes on merge. A bare
  `npx github:ajitheee/mendr#v0.5.7-alpha audit .` — the command in Ask 1 — reads the registry
  bundled in that tag. Cut `v0.5.8-alpha`, or have the ask set `MENDR_REGISTRY_REFRESH=on`.
- **PR #37** (the bot's 2026-10-01 candidates PR) is superseded: this branch carries a fuller queue
  from the corrected parser. Close it; the next monthly run re-creates it.
- **`gpt-image-1`'s replacement** (above), and 5 other confirmed dates whose replacement differs
  from the page's, printed by `check-dates` as warnings. Most are deliberate retargets off
  replacements that have themselves died.
- **18 Google entries cite the changelog**, which `check-dates` does not read: their dates are
  unchecked, and say so.
- **Notes still say "Provider-named" on some inferred entries.** `inferredFrom` is now the
  machine-readable truth; the prose was not rewritten here.
- **15 newly discovered candidates wait in the queue**, among them `gpt-5.1`, `gpt-5.3-codex` and
  `gpt-5.4-nano` retiring 2027-04-01 and `claude-sonnet-4-5-20250929` retiring 2026-11-30.
