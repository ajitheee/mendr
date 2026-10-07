# Parameter rules: the provider's own sentence, and a swap that starts applying one

2026-10-05. Branch `registry/param-rules`. L4 of the change-intelligence plan (the deterministic
half), and the design of L5.

## Why

A parameter rule edits a customer's request: it renames `max_tokens`, or deletes `temperature`. The
four shipped rules carried a note and no source. Three of the notes read "VERIFY the exact model set
against Anthropic's live docs before production". Nothing ever checked them.

## What shipped

| commit | slice |
|---|---|
| `6f73ea9` | Rules quote their provider. The validator refuses an unquoted rule (`param_rule_unquoted`), and `mendr check-rules` re-reads every quoted page weekly in `registry-verify` |
| `7b4f6e6` | A swap that **starts** applying a parameter rule goes to review: Tier B `param_behaviour_change`. **Decision for Ajith**, droppable on its own |
| `f47a7ab` | L5, learning from outcomes: designed in `OUTCOMES-DESIGN.md`, deliberately not built (Gate 2 is unmet) |

## The four rules and the sentences behind them

Quoted from the live pages on 2026-10-05. `check-rules` confirmed 8 of 8 sentences on 2 pages.

| rule | `rule` quote | `behaviour` quote |
|---|---|---|
| OpenAI `max_tokens` → `max_completion_tokens` | API reference: `max_tokens` "is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models." | Its definition of `max_completion_tokens`, which counts "visible output tokens and reasoning tokens" |
| Anthropic `temperature`, `top_p`, `top_k` removed | Opus 5.5 migration guide: a non-default value "on Claude Opus 4.7 and later models ... returns a 400 error." | The same guide, on omitting them or leaving them at their defaults |

The stale "VERIFY" sentences are gone from the three Anthropic notes.

## The behaviour-change guard (`7b4f6e6`)

The coupled-parameter guard asked one question: is every model-dependent parameter this call passes
covered by a rule for the replacement? It never asked whether that rule **also** applied to the
model being replaced. A rule that starts applying only at the replacement changes what the call asks
for, and the quoted behaviour sentences say how:

- **OpenAI.** `max_tokens: 20` renamed onto a reasoning model is a valid request whose budget is now
  partly spent on reasoning, and can come back empty.
- **Anthropic.** Dropping `temperature: 0` changes how the model answers.

Tests that mock the API cannot see either change.

A five-call probe, main's build against this one:

| call | main | branch |
|---|---|---|
| `gpt-3.5-turbo` + `max_tokens: 20` | A, patch | **B, `param_behaviour_change`** |
| `gpt-4-turbo`, no parameters | A, patch | A, patch |
| `o1` + `max_tokens` (it already counts reasoning tokens) | A | A |
| `gpt-4` + `temperature` (no rule covers it) | B | B, same reason |
| `claude-3-opus` | B | B (see "Not changed here" below) |

The fix pass still writes the edit when a person approves. Only the automatic patch is withheld.

**Corrected 2026-10-06: two statements above were not true of every command.**

- **The "B" column is `audit`'s.** `fix-llm` did not list these calls at all: it reported "Nothing to
  fix" and passed `--fail-on tierB`, for every TypeScript call the scanner caps at review. That
  includes this probe's `gpt-3.5-turbo` row and every Anthropic call that passes `max_tokens`. It
  shipped that way in `v0.5.8-alpha`, and was fixed in
  [PR #47](https://github.com/ajitheee/mendr/pull/47) (`138181f`). A follow-up stopped the
  parameter pass from editing a held call's request, and gave calls held for their surface
  their own reason code, `surface_capped`, in place of `platform_blocked`.
- **No command writes the edit, approved or not.** `migrate --only gpt-3.5-turbo` on that call
  reports "No verified Tier-A migration was found. Nothing to apply and nothing to verify."
  Review means a person makes the change by hand.

## The corpus: no collateral change, and no case for the guard to act on

**Setup.** These were the same 12 repositories as the L1/L2 run, at the same commits. Each was
audited twice: main's build with main's registry, and this branch's build with this branch's
registry. Both runs were offline, with the clock pinned to `2026-10-05T00:00:00Z`. Both builds and
both registries were fingerprinted before and after. The first run was stopped at its time limit
inside litellm, after 5 repositories. The other 7 were run again under a gate that refused to start
unless the fingerprint matched the first run's. It did match, before and after.

**Results.**

- **Locations:** 13,535 across the 12 repositories. 0 were added, 0 removed, 0 changed.
- **Whole documents:** identical but for one field, `coverage.registry.version`. That field differs
  because the two registries are different files: the quotes were added, and the VERIFY notes
  removed.
- **Why nothing moved:** none of the 12 has a single Tier A location on main's build (0 Tier A,
  55 Tier B). The guard only ever acts on a Tier A swap. So the corpus shows that L4 changed nothing
  else, but it cannot show the guard's effect. The probe above is the only evidence of the guard
  firing.

So the decision on `7b4f6e6` is about one shape: a live model argument, a verified replacement, and
a parameter whose rule starts applying at the replacement. On these 12 repositories that shape never
reached Tier A.

## A correction to `7b4f6e6`'s own message

It says LibreChat's title call "is that shape ... so the edit would ship verified". The shape is
right: `api/server/services/Endpoints/assistants/title.js` calls `gpt-3.5-turbo` with
`temperature: 0.7` and `max_tokens: 20`. The consequence is wrong. Mendr already caps that call at
review on main's build, so no edit would ship. LibreChat has no Tier A location on either build.

## Not changed here

- **`max_tokens` on Anthropic still over-triggers.** `claude-3-opus` with `max_tokens` lands in
  review on both builds, because the guard treats `max_tokens` as model-dependent for Anthropic. That
  is pre-existing, and the probe shows it unchanged.
- **Found in passing, filed separately:** every capped call site without a parameter reason is
  reported as `platform_blocked`, whose sentence says the id "sits under a deployment key". In
  LibreChat that is 5 of 7 review findings (the title call, an edit-message mutation, three image
  calls), and none has a deployment key. Across the 12 repositories, `platform_blocked` is the reason
  on 23 of the 55 review findings. Only LibreChat's 5 were read.
