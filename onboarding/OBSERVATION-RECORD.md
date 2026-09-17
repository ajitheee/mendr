# First-customer observation record

Fill this in **while the first runs happen**, not afterwards from memory. The purpose is not to
make Mendr look good; it is to find out whether it is worth anything to someone who is not us.

A blank field is a finding. "I could not tell" is a finding. Write what happened, not what was
supposed to happen.

---

## 0. The setup, recorded once

| | |
|---|---|
| Repository (owner/name, private?) | |
| Primary language(s), and % Mendr can read | |
| Providers called (openai / anthropic / google / other) | |
| Does it have a real type-check? (`tsc`, `mypy`) | |
| Does it have a test suite that passes today? | |
| Reviewer name and role | |
| Mendr pin (40-char SHA) | `ff86f14e18165a984d5e5297b68504190d09f93f` |
| Registry version at first run | |
| Date onboarded | |

**Why the language % matters:** Mendr reads TypeScript/TS191b202ec20618d1, JavaScript and Python and nothing
else. If 60% of the repo is Go, the denominator tells you what "no exposure" is actually worth.

---

## 1. Installation

| | |
|---|---|
| Wall-clock from "here is the link" to first green CI run | |
| Number of times the reviewer had to ask a question | |
| Anything they had to change in their repo to make it work | |
| Did they need the `Allow GitHub Actions to create and approve pull requests` setting? | |
| Did anything fail on the first attempt? What? | |

**The number that matters:** questions asked. Zero means the note was good. Three or more means
the note is wrong, and fixing it is worth more than any feature.

---

## 2. Coverage — what was looked at

Copy the denominator straight from the run output. Do not summarize it.

| | count |
|---|---|
| discovered | |
| analyzed (TS/TS191b202ec20618d1, JavaScript, Python) | |
| test files | |
| languages mendr does not read | |
| parse failures | |
| could not be opened | |
| config files scanned | |

| | |
|---|---|
| Do the categories add to `discovered`? | |
| Did the reviewer find the denominator convincing, or did they have to be talked through it? | |
| Was the conclusion `exposure_detected` / `no_exposure_in_completed_surfaces` / `inconclusive` / `audit_failed`? | |

**Watch for:** a reviewer who reads "no exposure in completed surfaces" as "clean". If they do,
the wording has failed, however technically correct it is.

---

## 3. Findings — were they real?

One row per finding. The reviewer answers "real?", not us.

| # | model id | file:line | tier | decision | Real live dependency? (reviewer) | If no, why |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

| | |
|---|---|
| True positives | |
| False positives | |
| Findings the reviewer already knew about | |
| Findings that surprised them | |
| **Anything Mendr MISSED that the reviewer knows about** | |

**That last row is the most valuable line in this document.** A false negative will not appear in
any output — it has to be asked for, out loud, by name: *"is there a retiring model id in here
that Mendr did not report?"* Ask it explicitly. One was found this way on 2026-09-16
(`going-doer/Paper2Code`, a CLI default classified as documentation) and it produced v0.5.1-alpha.

---

## 4. Suppressions and inconclusive results

| | |
|---|---|
| Suppressions created | |
| Reason given for each | |
| Did the reviewer expect a suppression to make the run read clean? | |
| Inconclusive scans, and the cause each time | |
| Did an inconclusive result read as a bug, or as honesty? | |

**Watch for:** a reviewer irritated by `inconclusive`. That reaction is the core product risk —
the honesty is the design, and if it reads as flakiness the positioning is wrong, not the code.

---

## 5. Time to a useful finding

| | |
|---|---|
| Install → first finding displayed | |
| First finding → reviewer says "that's worth fixing" | |
| **Did any finding reach "worth fixing"?** | |

If nothing reached "worth fixing", stop and record why. That is the whole hypothesis, and a no
here matters more than anything below it.

---

## 6. The pull request — the artifact they judge

| | |
|---|---|
| Time from Approve → PR opened | |
| Did the PR open at all? | |
| Gates that ran (type-check / build / tests / eval) and their outcomes | |
| Did the verification run clean on their CI? | |

Answered by the reviewer, in their words:

| question | answer |
|---|---|
| Did the PR body tell you *why* this change is needed? | |
| Did it tell you *how urgent* it is? | |
| Did you trust the replacement model it chose? | |
| Did you understand what was verified, and what wasn't? | |
| Did you notice the "behaviour was not verified" caveat? Did it bother you? | |
| **What did you have to go and check yourself, outside Mendr?** | |
| Would you have merged this without talking to us? | |

| | |
|---|---|
| Manual changes the reviewer requested before merging | |
| Merged? Date? | |
| If rejected — the actual reason, in their words | |

---

## 7. The question to ask at the end

Ask it plainly, and write the answer down verbatim even if it stings:

> *"If this disappeared tomorrow, what would you do instead?"*

Answer:

> *"Would you pay for this? For what, exactly — the finding, the PR, or the evidence?"*

Answer:

---

## Rolling scoreboard (the beta milestone)

| criterion | target | actual |
|---|---|---|
| External private repositories onboarded | 1 | |
| Mendr PRs merged | 2 | |
| Incorrect verified edits | 0 | |
| Secret exposure incidents | 0 | |
| Every skipped surface reported honestly | yes | |

| supporting metric | value |
|---|---|
| Installation time | |
| Findings reviewed | |
| True positives / false positives | |
| Suppressions created | |
| Inconclusive scans | |
| PR acceptance rate | |
| Time to merge | |
| Manual changes requested | |
