# Gate 2 asks — drafted 2026-09-26, 27 days out

Three drafts. Ajith sends; nothing here has been sent by anyone else.

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

| claim | checked |
|---|---|
| Cold install + scan = **98 s** | Timed today: empty `npm_config_cache`, 2-file TS repo, `npx --yes github:ajitheee/mendr#v0.5.6-alpha audit .` → 98 s, `EXPOSURE DETECTED`. Not a guess and not a warm run. |
| **Twelve** verified ids retire 2026-10-23 | `registries/llm-deprecations.json`: 13 rows carry that date, 12 are `verification.status: verified`, `gpt-image-1` is `unverifiable`. The five commonly named — `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini`, `o4-mini` — are all in the verified twelve. **Say twelve, not thirteen.** |
| `audit` writes nothing | `git status --porcelain` byte-identical before and after. No write site is reachable from a bare `audit .`. |
| LibreChat line unchanged | `title.js:25` still `model: 'gpt-3.5-turbo'` on `main`, fetched today. |
| **The issue URL moved** | `github.com/danny-avila/LibreChat/issues/16017` → **404**. `github.com/LibreChat-AI/LibreChat/issues/16017` → **200**. Post at the second. The old path is dead. |
| Registry goes stale 2026-10-08 | Stamp `2026-09-24`, max age 14 days. After that a zero-finding run reads `inconclusive`, deliberately. **Ask 1 has a shelf life.** |

---

## Ask 1 — one command, one reply  *(the primary)*

**To:** one person in the warm ring. **Channel:** a DM or address you already have. Not a new
address, not a public issue, not a send-to-all.

> hey [NAME] — one command, one reply, and i'd rather have the honest answer than a kind one.
>
> pick a repo you own that calls an llm and run:
>
>     npx github:ajitheee/mendr#v0.5.6-alpha audit .
>
> it reads your ts/js/python and config for model ids a provider is about to switch off. twelve
> verified openai ids shut down on 2026-10-23 — gpt-4, gpt-4-turbo, gpt-3.5-turbo, o3-mini,
> o4-mini among them. 27 days.
>
> the honest cost: it isn't on npm yet, so npx clones and compiles it first. i timed it cold on
> an empty cache this morning — 98 seconds start to finish, needs node 22+. no api key. it
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

**Send before 2026-10-08.** After that the bundled registry grades itself stale and a clean run
reports `inconclusive`, which muddies exactly the case this ask is aimed at.

---

## Ask 2 — read one thing, answer one question  *(no command)*

**To:** the person in the ring who will not run a stranger's npx from a friend. That's a real
category and pretending otherwise wastes an ask.

> hey [NAME] — no install, just a link and one question.
>
> github.com/ajitheee/mendr-demo is a small service that calls `gpt-4-0613`. openai switches
> that id off on 2026-10-23. the audit runs in that repo's own ci on every push; today's run
> found it and posted the evidence as a check.
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

## Ask 3 — LibreChat #16017, the one live public room

**Post at:** `https://github.com/LibreChat-AI/LibreChat/issues/16017` — **the `danny-avila` path
404s**, the repo moved. Verified today.

**Why this is legitimate and not a pitch:** the line is still there, the shutdown is 27 days
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
