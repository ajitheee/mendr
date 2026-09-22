# Beta gates

Reset 2026-09-17. The previous milestone — *one external private repository, two merged Mendr PRs,
zero incorrect verified edits, zero secret exposure* — was a single target with a single date, and
it could not be met on that date for a structural reason rather than a lack of work.

**Why it could not.** Mendr force-pushes one stable branch and keeps a single pull request current
rather than stacking new ones. That is deliberate: a tool that opens a fresh PR on every run gets
muted. But it means **two merged Mendr PRs on one repository requires two separate retirement
events** — merge the first, then wait for the next retirement that touches that same code. On top
of that, Tier A fires on roughly one repository in twenty-six. Two merges was never a three-day
target; it was a multi-week one wearing a three-day date.

So the milestone is split. The invariants below hold at **both** gates and are not negotiable.

---

## Gate 1 — by 2026-09-20

**One external repository onboarded, and one finding reviewed by an engineer who is not Ajith.**

This is the gate that tests the thing actually in doubt: whether the evidence convinces somebody
who did not build it. It does not require a merge, a Tier A finding, or even agreement — a
reviewer who reads the evidence and says "this is not worth fixing" has answered the question.

Fill in `onboarding/OBSERVATION-RECORD.md` while it happens, not afterwards.

- [ ] One external repository connected, private preferred
- [ ] One audit run completed, its conclusion recorded
- [ ] One finding read by a reviewer who is not Ajith, and their verdict written down verbatim
- [ ] The two rows that matter most answered out loud: *did Mendr miss anything you know about?*
      and *what did you have to go and check yourself?*

### RESULT: MISSED — recorded 2026-09-22

Both boxes unticked. **Zero external repositories onboarded, zero findings reviewed by anyone who
is not Ajith.** `onboarding/OBSERVATION-RECORD.md` is blank in every cell it was built to hold.

**What was actually sent.** Seven verified findings, filed as issues on strangers' repositories
between 2026-09-13 and 2026-09-17. Each was traced to a live call site, re-checked at HEAD at the
moment of filing, and passed the *worth filing if Mendr did not exist* test.

| where | filed | state 2026-09-22 |
|---|---|---|
| `giselles-ai/giselle#2971` | 09-13 | open, 0 comments |
| `danny-avila/LibreChat#16017` | 09-16 | **closed COMPLETED**, 0 comments, no code change |
| `evalstate/fast-agent#959` | 09-16 | open, 0 comments |
| `going-doer/Paper2Code#31` | 09-16 | open, 0 comments |
| `skywalker023/sodaverse#11` | 09-17 | open, 0 comments |
| `guardrails-ai/guardrails#1657` | 09-17 | open, 0 comments |
| `microsoft/TinyTroupe#166` | 09-17 | open, 0 comments |

**What was never sent.** The Show HN (blocked since 2026-08-18 on an npm publish that is still
undone — `launch/show-hn.md` states the precondition in its own third line), both Reddit posts, all
three X posts, and both DM waves: 34 named targets, 32 disqualified on verification, 0 messages
sent. The entire outward-facing history of this product is the seven rows above.

**The number that matters, and it is not zero replies.** *None of the seven touches contained the
question this gate measures.* They ask "worth a PR?", "tell me which id and I'll send the PR",
"want the report pasted here?". Seven for seven at 100% success yields up to seven merged PRs on
public repositories — and still zero onboarded repositories and zero recorded non-Ajith verdicts.
A perfectly executed campaign and a wholly ignored one score the same here. The campaign was not
underperforming; it was aimed at a different target than the gate.

**Attention, measured 2026-09-22.** 27 views from 7 unique visitors over 14 days. 1 star, which is
Ajith's own; 0 forks, 0 watchers, 0 issues ever opened by anyone. Peak was 9 views on 2026-09-17,
the day four issues were filed. On 2026-09-19 and on gate day 2026-09-20: **0 views, 0 visitors.**

**When it stopped.** The last `launch/` commit is 2026-09-16. Since then, 14 engineering commits
and no outreach of any kind — including the night of 2026-09-17, when this file was written saying
*"Not building. The engineering is frozen"* and four `feat(registry)` slices landed within hours.
The gate was not lost at the deadline; it was left three days early and the work returned to what
was comfortable.

**What this is not evidence of.** Not that the product is unready: every finding was correct, the
LibreChat line still reads `gpt-3.5-turbo` today, and the maintainer who acted chose `COMPLETED` —
the close reserved for a legitimate report. Not that onboarding friction killed it: two of the
seven touches carried the zero-install offer in writing and were ignored exactly like the other
five, and nobody has ever reached step one. Not that the deadline is unreal: teams shipped
retirement fixes for this same date on 2026-09-21 alone.

**What it is evidence of.** An unsolicited correct bug report is not a conversation, and nobody has
ever been asked the thing this gate scores. The ask-to-verdict rate is not low; it is undefined,
because the denominator is zero.

**What changes, before any new plan.** The unit of work stops being *a touch* and becomes *an ask
that contains this gate's question*, logged one row per ask in `launch/ASKS.md` — date, person,
channel, the exact question, the reply, the verdict — created before the next one is sent. A day
with zero asks and one or more commits is a failed day and gets logged as one.

## Gate 2 — after 2026-10-23

**Two merged Mendr PRs on that repository.**

2026-10-23 is when OpenAI stops serving `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini` and
`o4-mini`. That is the retirement event that makes a second finding likely rather than hoped for,
which is why this gate sits after it rather than before.

**Gate 2 is what unlocks slice 7 (persisted resolution).** Not gate 1. The shape of a resolution
record depends on what a team actually does with a finding across more than one cycle, and one
merge does not show that.

---

## Invariants — true at both gates

- Zero incorrect verified edits
- Zero secret exposure
- Every skipped surface reported honestly

---

## What the 36 days between the gates are for

Not building. The engineering is frozen: only security defects, incorrect classifications and
onboarding blockers may interrupt it.

They are for **being installed before the wave**, because 2026-10-23 is the day teams find out they
have this problem, and a tool discovered on the day of an outage is a tool nobody has time to
evaluate. The registry already knows the date. Almost nobody else does.
