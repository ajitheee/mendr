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
