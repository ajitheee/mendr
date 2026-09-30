# Gate 2 asks — drafted 2026-09-26, re-verified 2026-09-29, 24 days out

Three drafts. Ajith sends; nothing here has been sent by anyone else.

> ### Re-verified 2026-09-29 — what three days changed
>
> Every claim below was re-checked against the tag and the pages as they are today, because this
> file's own rule is *"do not describe a page you haven't loaded."* Four things moved:
>
> 1. **The tag.** `v0.5.7-alpha` was cut 2026-09-28. Ask 1 pinned `v0.5.6-alpha`, which is the
>    build where a no-op run writes **nothing** to the step summary — it "keeps reporting green
>    while doing nothing". Sending 0.5.6 now ships a known-worse build.
> 2. **The shelf life moved out, not in.** The deadline is not a calendar fact, it is the
>    bundled registry stamp **in whichever tag the ask names**:
>    `v0.5.6-alpha` → stamped `2026-09-24` → stale **2026-10-08**;
>    `v0.5.7-alpha` → stamped `2026-09-28` → stale **2026-10-12**.
>    Repointing the ask buys four days. Confirmed from the shipped tag, which prints
>    `Registry: … bundled 2026-09-28 (fresh, 1 d)`.
> 3. **It got faster.** 98 s → **54 s** cold. Re-timed on the new tag, method below.
> 4. **The report now leads with the deadline.** P1-G1 shipped, so the check title is a
>    countdown rather than a label. This is the strongest line in the product and no draft
>    mentions it.
>
> Two asks need a decision before they can be sent, both recorded at their own headings:
> **Ask 2's check-run URL is stale**, and **Ask 3's issue is closed with zero replies**.

**What changed from September.** `ASKS.md` diagnosed the last campaign: five of seven touches
were not questions, the two that were asked the maintainer to decide *for* Mendr, and six of
seven trackers answer roughly nobody. So this wave is small, the rooms are ones where someone
actually replies, and **every draft ends on the Gate 1 question** — *what did you have to go and
check yourself?* — which the ledger says was never once asked.

**What a verdict is** (`BETA-GATES.md`, quoted in `ASKS.md`): a recorded position on a
**Mendr-located finding**. "Not worth fixing" scores. A box tick does not. That rule decides the
scoring notes below, and one of them says a likely reply does **not** score.

---

## Verified before writing, with the method

All re-checked **2026-09-29** against `v0.5.7-alpha` and the live pages.

| claim | checked |
|---|---|
| Cold install + scan = **54 s** | Re-timed 2026-09-29 on the new tag: `npm_config_cache` pointed at an empty directory (**0 entries before, 4 after** — `_cacache`, `_npx`, `_logs`, so npx genuinely built from scratch), 2-file TS repo, `npx --yes github:ajitheee/mendr#v0.5.7-alpha audit .` → **54 s**, `EXPOSURE DETECTED`, exit 0. Not a guess and not a warm run. A second, warm run took **9 s**. |
| The report **leads with a countdown** | The shipped tag prints `Retirement: deprecated - 24d left (2026-10-23)`, and the public check title on `mendr-demo` today reads **`gpt-4-0613 stops serving in 24 days · 1 patch eligible`**. Computed at write time, so it is correct whenever it is read. |
| **Twelve** verified ids retire 2026-10-23 | `registries/llm-deprecations.json`: 13 rows carry that date, 12 are `verification.status: verified`, `gpt-image-1` is `unverifiable`. The five commonly named — `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini`, `o4-mini` — are all in the verified twelve. **Say twelve, not thirteen.** |
| `audit` writes nothing | Re-verified on `v0.5.7-alpha`: `git status --porcelain` captured before and after, **byte-identical**. No write site is reachable from a bare `audit .`. |
| `--offline` works | Re-verified on `v0.5.7-alpha`: exit 0, `EXPOSURE DETECTED`, registry line `bundled 2026-09-28 (fresh, 1 d)`. |
| LibreChat line unchanged | `title.js:25` still `model: 'gpt-3.5-turbo'`, fetched from `LibreChat-AI/LibreChat` **2026-09-29**. Exact line 25, confirmed by line number and not by eye. |
| ~~The issue URL moved~~ **The issue is CLOSED** | Corrected 2026-09-29. Both paths now resolve (`danny-avila` no longer 404s via the API), but `issues/16017` is **closed, `state_reason: completed`, closed 2026-09-17, 0 comments**, filed by `ajitheee`. It is not a live room and never had an audience. **See Ask 3 — its premise is void.** |
| Registry goes stale **2026-10-12** | Corrected: `BUNDLED_PUBLISHED_AT = 2026-09-28T04:39:57Z` in `v0.5.7-alpha`, max age 14 days. The old `2026-10-08` was `v0.5.6-alpha`'s stamp. **Ask 1 still has a shelf life — four days longer, and only if it names 0.5.7.** |

---

## Ask 1 — one command, one reply  *(the primary)*

**To:** one person in the warm ring. **Channel:** a DM or address you already have. Not a new
address, not a public issue, not a send-to-all.

> hey [NAME] — one command, one reply, and i'd rather have the honest answer than a kind one.
>
> pick a repo you own that calls an llm and run:
>
>     npx github:ajitheee/mendr#v0.5.7-alpha audit .
>
> it reads your ts/js/python and config for model ids a provider is about to switch off. twelve
> verified openai ids shut down on 2026-10-23 — gpt-4, gpt-4-turbo, gpt-3.5-turbo, o3-mini,
> o4-mini among them. 24 days.
>
> every line it prints carries the countdown, not just a label — "deprecated, 24d left
> (2026-10-23)". that's the part i actually want judged.
>
> the honest cost: it isn't on npm yet, so npx clones and compiles it first. i timed it cold on
> an empty cache today — 54 seconds start to finish, needs node 22+. no api key. it
> writes nothing: no edit, no commit, no pr, report goes to stdout. `--offline` enforces the
> no-network part rather than promising it.
>
> what i want back isn't a fix and isn't a review of the tool. i want to know whether the
> report convinces someone who didn't build it.
>
> if it finds nothing it won't say "clean" — it says NO EXPOSURE IN COMPLETED SURFACES and
> prints what it did not read. that's the case i'm least sure of.
>
> "it didn't convince me, because X" is the most useful thing you can send and i won't argue
> with it.
>
> what did you have to go and check yourself before you believed it?

**Scores if:** they name something they went and opened — a file, a call path, a language they
checked the coverage list against. **Does not score if:** "looks cool", "will try", or silence.
Log those as `reply=yes / verdict=no`, the way `ASKS.md` logs LibreChat.

**A caution the ledger earns.** A clean scan produces no finding, so a reply about coverage is a
position on a *claim*, not on a *finding*. Under the current definition that is **not** a verdict.
Either log it as `reply=yes / verdict=no`, or amend `BETA-GATES.md` first — deliberately, in
writing. Do not quietly widen the definition to make the scoreboard move.

**Send before 2026-10-12** (corrected 2026-09-29 from 10-08, which was `v0.5.6-alpha`'s stamp).
After that the registry bundled in `v0.5.7-alpha` grades itself stale and a clean run reports
`inconclusive`, which muddies exactly the case this ask is aimed at. The date moves with the tag,
so **cutting a new tag before sending buys more runway** — but do not delay the send to get it.
The last gate was lost with time still on the clock.

---

## Ask 2 — read one thing, answer one question  *(no command)*

**To:** the person in the ring who will not run a stranger's npx from a friend. That's a real
category and pretending otherwise wastes an ask.

> **Re-verified 2026-09-29 — the link, and one thing to decide.**
>
> - **`mendr-demo` is public** (`private=false`) and `src/ai.ts:12` does call `gpt-4-0613` today.
> - **The check-run URL in `PLAN-30-DAYS.md` is stale.** `runs/108618583430` is an older run. The
>   current one a logged-out visitor should be sent to is
>   **`https://github.com/ajitheee/mendr-demo/runs/109424680822`** — `Mendr audit`,
>   `action_required`, title **`gpt-4-0613 stops serving in 24 days · 1 patch eligible`**. Re-check
>   it the hour you send; scheduled runs replace it.
> - **The draft undersells it.** It describes what the report refuses to claim — which is good and
>   true — but never mentions that the check *title itself* is a countdown. That is the line most
>   likely to make someone look.
> - **A decision, because it is a credibility risk.** `git log src/ai.ts` shows the id was
>   migrated by Mendr at `06:12:12Z` on 2026-09-28 and **deliberately re-added 23 minutes later**
>   at `06:35:49Z` — *"demo: call gpt-4-0613 again, so the repository demonstrates something"* —
>   and the same reset happened on 09-26 and 09-12. That is legitimate fixture maintenance, but a
>   careful reader who opens the history will find it on their own and it will read as staging.
>   **Disclose it in the ask** — one clause, e.g. *"it's a fixture: the id gets put back after
>   each proof so there's always something to find"* — rather than letting them discover it.
>   Volunteering it costs one sentence; being caught by it costs the verdict.

> hey [NAME] — no install, just a link and one question.
>
> github.com/ajitheee/mendr-demo is a small service that calls `gpt-4-0613`. openai switches
> that id off on 2026-10-23 — 24 days. the audit runs in that repo's own ci; the current run
> found it and posted the evidence as a check, titled "gpt-4-0613 stops serving in 24 days ·
> 1 patch eligible".
>
> one thing up front, before you go looking and find it yourself: this repository is a
> repeatable integration fixture: after each successful Mendr migration, we intentionally
> restore the retired model identifier so the complete workflow can be exercised again; the
> restoration is test maintenance, not a rejected migration.
>
> the thing i'd like you to look at is what it refuses to claim. it never says "clean", it
> prints which surfaces it could not complete, and where it found a verified replacement it
> still didn't apply it — it says PATCH ELIGIBLE and NO CHANGE APPLIED and leaves it to a human.
>
> one question: reading that report cold, would you have merged the change on the strength of
> what it shows you — and if not, what's missing that would have made it a yes?
>
> "no, i wouldn't have" is the answer i most want, if it's the true one. it's more useful to me
> than a yes and i won't try to talk you out of it.

**Scores if:** they take a position on the evidence, either way. A "no, because X" is a full
verdict and the most valuable reply available.

**Check before sending:** open `github.com/ajitheee/mendr-demo` yourself and confirm the finding
is visible to a logged-out visitor. The audit result is posted as a GitHub **check run**; if a
stranger can't see it without signing in, link the specific check-run URL instead of the repo
root. Do not describe a page you haven't loaded — that is the exact failure that made 13 of 14
September drafts unsendable.

---

## Ask 3 — LibreChat #16017 — ~~the one live public room~~ **the premise is void**

> **Re-verified 2026-09-29. The PR was authorised and then NOT opened. Four blocking facts, all
> found before touching the repository.**
>
> **1. The project lead already ruled on this finding.** `issues/16017` is **closed —
> `state_reason: completed`, closed 2026-09-17T03:47:23Z by `danny-avila`, with 0 comments.** Not
> closed by Ajith, and not closed by a fix: the line is still there. A maintainer looked at it and
> closed it as completed without a word, twelve days ago. Any PR now re-litigates that decision.
>
> **2. Their CONTRIBUTING forbids exactly this PR**, in writing:
> *"A pull request that appears unannounced, with no issue, no assignment and no prior
> conversation, **may be closed without review** no matter how good the patch is."* And:
> *"A pull request produced by pointing an agent at our issue tracker will be rejected unless the
> issue it addresses was assigned to you."* The single exception is *"a novel P0/P1 defect: data
> loss, a broken release, a crash, or a regression with no workaround, that nobody has yet
> reported"* — and this qualifies on none of those counts. Nothing is broken today; the failure is
> dated 2026-10-23; and it was **already reported**, which the policy names as disqualifying. There
> is no open issue to be assigned: a search returns one open issue mentioning the id and it is
> unrelated. `#10737`, the reasoning-parameter bug, is also closed with 0 comments.
>
> **3. It is not a one-token change.** The draft's central claim — *"`title.js:25` is a one-token
> change"* — is wrong for OpenAI's own recommended replacement. The call is:
>
> ```js
> const completion = await openai.chat.completions.create({
>   model: 'gpt-3.5-turbo',
>   messages: [{ role: 'user', content: titlePrompt }],
>   temperature: 0.7,
>   max_tokens: 20,
> });
> ```
>
> OpenAI maps `gpt-3.5-turbo` → **`gpt-5.6-terra`** (confirmed on the deprecations page today).
> `gpt-5.6-terra` is a reasoning model, and reasoning models reject **both** remaining parameters:
> `max_tokens` must become `max_completion_tokens`, and `temperature: 0.7` returns
> *"Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) is
> supported."* So the official mapping is a **three-line behavioural change** that also makes a
> 20-token title call slower and dearer. A swap of the id alone would have shipped a **broken
> call** to a 45,000-star repository under Ajith's name.
>
> **4. It would have targeted the wrong branch.** *"All contributions target `dev`; `main` only
> moves at release time."* Verified: `dev` still carries all three lines, so the finding is live
> there too.
>
> **What is still true.** `title.js:25` reads `model: 'gpt-3.5-turbo'` on `main` **and** `dev`,
> fetched 2026-09-29. The id stops serving 2026-10-23, 24 days out, per
> `developers.openai.com/api/docs/deprecations`, announced 2026-04-22. The finding is real and
> unfixed. Only the *route to a verdict* is blocked.
>
> **DECIDED 2026-09-29: dropped. The pull request will not be opened and the issue will not be
> reopened.** Logged in `launch/ASKS.md` as `reply=no / verdict=no`, with the reasoning, and the
> beta gate is **not** widened to count a silent `completed` closure as a maintainer verdict.
>
> **And `gpt-4o-mini` is explicitly NOT the answer.** An earlier draft of this note recommended it
> as "the low-risk patch" because it is parameter-compatible and not retiring. That recommendation
> is withdrawn: `gpt-4o-mini` is **not the provider-designated replacement**, so selecting it is a
> product or maintainer judgement about cost, latency and output quality — not a mechanical
> migration. Substituting it automatically is precisely the overreach Mendr exists to refuse, and
> proposing it in a stranger's repository would be making their decision for them. If a
> non-designated id is ever the right answer, a human picks it, on the record.
>
> **What this ask actually produced.** Not a verdict — a defect in our own product. The parameter
> trap in point 3 is now the regression case
> `recommended_replacement_requires_coupled_parameter_migration`
> (`src/usage/coupledParams.test.ts`): Mendr was calling a verified model-id replacement a "safe
> automatic patch" while never checking whether the request around the id survived the swap. It now
> requires review whenever no authoritative rule covers a parameter the replacement's family
> constrains. That is worth more than the reply would have been.
>
> **A scoring question this raises, not to be answered quietly.** A maintainer closing a
> Mendr-located finding as `completed`, without comment, while the code stays unchanged, arguably
> *is* "a recorded position on a Mendr-located finding" — the `BETA-GATES.md` definition of a
> verdict, under which *"not worth fixing" scores*. But a wordless close does not say **which**
> position, so reading it as verdict #1 would be exactly the quiet widening this file warns
> against. Log it as `reply=no / verdict=no` and raise the definition deliberately, in writing, or
> not at all.

**Post at (superseded):** `https://github.com/LibreChat-AI/LibreChat/issues/16017`

**Why this is legitimate and not a pitch:** the line is still there, the shutdown is 24 days
out, and the fix is one token. It passes the standing rule — worth filing if Mendr did not
exist — so it leads with the code and the date, and corrects my own overstatement first.

> a correction to what i filed, and one thing i got wrong.
>
> i said titles "stop generating". they don't. the create call is inside the try in
> `generateTitle`, and the catch at `title.js:86` falls back to the submitted text, then
> attachment names, then the response, truncated at 37 chars — `title.test.js:75` already
> exercises that path. so on 10-24 this degrades to a first-message title plus one
> `[addTitle] Error generating title:` per new assistants conversation, not an outage. smaller
> than i made it sound.
>
> what's still true is the line: `title.js:25` passes `model: 'gpt-3.5-turbo'`, and openai's
> deprecations page lists that id shutting down 2026-10-23 with `gpt-5.6-terra` as the
> substitute for the alias.
>
> one other thing i noticed while checking: `packages/data-schemas/src/app/assistants.ts`
> returns `titleModel` in the assistants config, and `title.js` never reads it — it hardcodes
> the id at :25. the agents path does read it. so that key is parsed and dropped for this
> endpoint, which is a bug with or without the october date.
>
> which of those two lines did you have to open yourself before you believed me?

**Scores if:** he replies engaging the `gpt-3.5-turbo` finding on its merits, or states a
position — including "we're removing that path" or "the fallback is fine, we'll live with it".
Any of those is a verdict.

**Does NOT score if** he replies only about `titleModel`. **Mendr did not find that** — it was
found by hand while checking. Mendr detects retiring model ids, not dropped config keys. Logging
that as verdict #1 would be the LibreChat error repeated: counting engagement as an answer to the
evidence question.

**Consider a PR instead, or as well.** `title.js:25` is a one-token change. A merged PR *is* a
verdict, and it costs a maintainer with 800 open issues less than a reply does. The comment asks
for words; a PR asks for a click. If the comment goes unanswered for a few days, open the PR.

---

## After sending

Add one row per ask to `ASKS.md` **before** the reply arrives, with the exact question quoted —
that is what the file is for. Then update the scoreboard honestly, including the cautions above.
A day with zero asks and one or more commits is still a failed day.
