# Asks

One row per ask, written **before** it is sent. The unit is an *ask* — a message that contains a
question someone can answer — not a *touch*. September's campaign made seven touches containing
zero asks, and the distinction is the whole reason Gate 1 failed while the work looked fine.

**A verdict** is an engineer who is not Ajith taking a recorded position on a Mendr-located
finding: a merged pull request, a written comment engaging with the finding on its merits, or a
close with a stated reason. *"Not worth fixing"* is a verdict and counts as a pass —
`BETA-GATES.md` says so explicitly. A silent close, a bot comment and an unread issue are not
verdicts, and must never be logged as one.

Scoreboard: **verdicts = 0** (as of 2026-09-22).

| date | target | channel | the exact question asked | reply | verdict | days |
|---|---|---|---|---|---|---|
| 2026-09-13 | `giselles-ai/giselle#2971` | public issue | *(not recorded — no draft exists)* | none | silent | 9+ |
| 2026-09-16 | `danny-avila/LibreChat#16017` | public issue | "worth a PR, or is that path on its way out anyway?" | **no** (closed `COMPLETED`, no words) | **no** — see below | 1 |
| 2026-09-16 | `evalstate/fast-agent#959` | public issue | "is DEFAULT_OPENAI_MODEL a deliberate pin, or do you bump it by hand?" | none | silent | 6+ |
| 2026-09-17 | `going-doer/Paper2Code#31` | public issue | *(report; no question)* | none | silent | 5+ |
| 2026-09-17 | `skywalker023/sodaverse#11` | public issue | "if you decide what you want it to be, I'll do the mechanical part" | none | silent | 5+ |
| 2026-09-17 | `guardrails-ai/guardrails#1657` | public issue | *(report; no question)* | none | silent | 5+ |
| 2026-09-17 | `microsoft/TinyTroupe#166` | public issue | "tell me which id and I'll send the PR" | none | silent | 5+ |

## Why LibreChat does not score

danny-avila closed it as `COMPLETED` within about twelve hours — the close-reason a maintainer
picks for a legitimate report, not for an invalid one — with **no comment, no label and no code
change**. `api/server/services/Endpoints/assistants/title.js:25` still reads `gpt-3.5-turbo` today,
and its last commit predates the issue by eight days.

So he read something and acted on it, and nothing he did says whether the *evidence* convinced him.
Logging that as a verdict would be counting a box tick as an answer, which is exactly the error
that let a zero-ask campaign look like a working one for five days. It stays a `no`.

### Closed for good, 2026-09-29: `reply=no / verdict=no`

Re-examined thirteen days on, when the Gate 2 plan proposed a follow-up pull request instead. The
decision is that **a silent `completed` closure is not an interpretable maintainer verdict, and the
beta gate will not be widened to count it.** Recorded so the question cannot be quietly reopened
later when the scoreboard is uncomfortable.

Four things were checked before dropping it, and each is a reason not to push:

1. **The line is genuinely still broken.** `title.js:25` reads `model: 'gpt-3.5-turbo'` on `main`
   **and** on `dev`, fetched 2026-09-29. The finding was and is correct.
2. **Their CONTRIBUTING forbids the follow-up.** *"A pull request that appears unannounced, with no
   issue, no assignment and no prior conversation, may be closed without review no matter how good
   the patch is."* The only exception is a *novel* P0/P1 defect; this is a dated future failure,
   already reported, which the policy itself names as disqualifying.
3. **The obvious patch is not a patch.** OpenAI maps `gpt-3.5-turbo` → `gpt-5.6-terra`, which
   rejects both parameters this call passes — `temperature` outright, `max_tokens` by rename. A
   one-token swap would have shipped a failing request to a 45,000-star repository.
4. **A substitute id is a decision we do not get to make.** `gpt-4o-mini` is parameter-compatible
   and not retiring, but it is **not** the provider-designated replacement, so choosing it is a
   product or maintainer judgement about cost, latency and output — not a mechanical migration.
   Mendr must not make that choice silently, and neither should we in someone else's repository.

Point 3 is the one worth keeping: it became the regression case
`recommended_replacement_requires_coupled_parameter_migration`, and it found a real defect in Mendr
— a verified replacement was being called a safe automatic patch while the request around it went
unchecked. **The most valuable thing this ask produced was a bug in our own product, not a verdict.**

## What the seven rows show

Five of the seven asks are not questions at all, and the two that are ask the maintainer to make a
decision *for* Mendr ("worth a PR?", "tell me which id"). None asks the Gate 1 question — *does
this evidence convince you, and what did you have to go and check yourself?*

Six of the seven trackers answer roughly nobody: sodaverse has had no tracker activity since 2023,
Paper2Code and TinyTroupe have been unpushed for months, and the giselle issue was the only open
issue in that repository. Zero replies is the base rate of those rooms, not a verdict on the
findings — every one of which was correct and remains correct.

## The rule this file exists to enforce

A day with zero asks and one or more commits is a **failed day**, and gets logged as one. The
September window has fourteen of them: outreach stopped on 09-16 and engineering did not.
