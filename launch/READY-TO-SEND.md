# ready to send — verified 2026-09-16 against the shipped v0.5.0-alpha

Every other target in `dms.md` and `dms-wave2.md` was disqualified. See VERIFICATION below.
These two are the only messages where every clause was checked and holds.

Both channels are a PUBLIC comment on the person's own repo, under Ajith's GitHub name.
Neither person publishes an email. There is no private channel to either of them.

---

## 1. danny-avila / LibreChat  (44,001 stars)  — **SENT 2026-09-16**

Filed as https://github.com/danny-avila/LibreChat/issues/16017 (open, authored by ajitheee).
Reworked into the repo's Bug Report shape, with the call chain proven before filing:
`chatV2.js:41` → `addTitle` → `generateTitle` (title.js:64) → the hardcoded id at line 25.

**Hook:** `api/server/services/Endpoints/assistants/title.js:25` passes `model: 'gpt-3.5-turbo'`
to `openai.chat.completions.create`. Registry entry `openai.gpt-3.5-turbo.retirement-2026-10-23`,
verification `verified`, source https://developers.openai.com/api/docs/deprecations. 37 days out.
Verified by hand: it is the ONLY live hardcoded pin of a retiring id in `api/` and `packages/`.

**Passes the "worth filing if Mendr did not exist" test:** yes — this is a real bug that fires
on a known date.

> `api/server/services/Endpoints/assistants/title.js:25` still passes `model: 'gpt-3.5-turbo'` to `openai.chat.completions.create`. openai's deprecations page lists that id with a 2026-10-23 shutdown — 37 days out — so assistant conversation titles stop generating on that date.
>
> i found it with a scanner i'm building, pointed at a fresh clone today. it's the only live hardcoded pin of a retiring id in api/ and packages/ — the other gemini-2.0 matches are test fixtures and commented-out .env.example lines, which it classified as data and left alone.
>
> it deliberately won't auto-patch this one: `openai` is a destructured parameter, so it can't prove from that file which client it is, and i'd rather it do nothing than guess.
>
> worth a PR, or is that path on its way out anyway?

---

## 2. evalstate / Shaun Smith — fast-agent  (3,919 stars)  — **SENT 2026-09-16**

Filed as https://github.com/evalstate/fast-agent/issues/959 (open, authored by ajitheee).
Reworked from a DM into a plain bug report before sending: `DEFAULT_OPENAI_MODEL` was confirmed
reachable at four fallback sites (llm_openai.py:386, :1187, :1542, :1589) and `DEFAULT_RESPONSES_MODEL`
at four more, so both are live defaults rather than dead constants. The repo already receives
promotional issues (#922 and #955 are duplicates of the same pitch), so the scanner is mentioned
only once, at the end, as disclosure of method.

**Hook:** `src/fast_agent/llm/provider/openai/llm_openai.py:86` hardcodes
`DEFAULT_OPENAI_MODEL = "gpt-5-mini"`. Registry `openai.gpt-5-mini.retirement-2026-12-11`,
verification `verified`. 86 days out. Scan: 1625 discovered, 848 analyzed, 0 parse failures,
0 patch-eligible, 2 review-required.

**Do NOT cite issue #461** — it is a `max_tokens`/`max_completion_tokens` parameter bug, stale by
10 months, and Mendr does not handle parameter renames as a registry class. Citing it invites a
public correction.

> is DEFAULT_OPENAI_MODEL = "gpt-5-mini" (src/fast_agent/llm/provider/openai/llm_openai.py:86) a deliberate pin, or do you bump it by hand when a model goes away?
>
> i ran mendr — a scanner i'm building — over fast-agent today: 1625 files discovered, 848 analyzed (843 python, 5 js), zero parse failures. two lines came back needing human review, nothing it would auto-patch: that default, and DEFAULT_RESPONSES_MODEL = "gpt-5.2" (responses.py:87). openai's deprecations page lists gpt-5-mini with a 2026-12-11 shutdown, 86 days out. gpt-5.2 is flagged deprecated with no date attached, so no countdown to quote.
>
> it won't patch either, because it can't trace a module-level default to a live request, and i'd rather it do nothing than guess. the other 28 hits are catalog and test data — model_database.py and the test fixtures — not live selectors.
>
> honest ceiling: even when it does open a PR, the gates prove a change builds and your tests pass, not that a new model behaves the same.
>
> want the report pasted here? nothing to install.

---

# VERIFICATION — why the other 12 were pulled

Ran on 2026-09-16: every repo cloned and scanned with the shipped build, every cited issue
fetched, every contact checked against the published-address rule.

| target | killed by |
|---|---|
| Vysp3r / airi | Vysp3r has no commits or PRs on airi — wrong person. #2249 closed + fixed 2026-08-25. |
| azanux / embabel | Kotlin+Java, Mendr reads 2 of 1741 files. #1759 closed 72 days ago by his own PR. |
| valentinfrlch / ha-llmvision | #617 closed 6 months. Repo already moved off maverick. No Groq coverage in registry. |
| decolua / 9router | #1054 is a PR by a third party, stale + conflicting; the fix is already in master in 20 places. |
| llm-exe | #231 closed; PR #700 already added the deprecation with the exact date. Filed by a bot, not a maintainer. |
| danny-avila #12444 | closed 6 months, filed by SEWADE not danny. (Replaced with the title.js hook above.) |
| yohkuri / cz-git | doesn't own cz-git (Zhengqbbb does). #261 closed, fixed by his own merged PR. Scan clean. |
| archer-eric / simonw/llm | bug reporter, not owner. Scan clean. The param rename is TS-only — no Python path. |
| stevechoi0222 / DeepTutor | handle 404s (real: stevejchoi). #54 closed 8 months, files deleted in a refactor. |
| bootrecords / opencrabs | Rust. INCONCLUSIVE scan. #1059 closed. |
| evilpan / gptcli | the claim is false — gemini-2.0-flash appears only in a README sample block. Repo dormant 17 months. |
| Mark Lilien / Vida | VIDA-Global/mod_openai_s2s is a 404; the repo belongs to TeleFlow Ltd. 100% C++. |

## The finding that matters more than any of these

**Zero Tier A findings across all 14 repositories.** Not one produced an auto-fixable patch.
With the 12-repo validation corpus that is 1 Tier A in 26 real repositories.

The cause is visible in the LibreChat hook: Tier A requires the SDK client to be resolvable in
the same file, and production code injects its client (`async ({ openai, ... })`) or wraps it in
a factory. The gate is working exactly as designed — and it almost never fires on real code.

Two consequences:
1. "let me run it and send you the diff" is an offer we cannot keep on a real repository. It was
   the core hook of both DM waves. It has to go.
2. Most cited issues were `max_tokens` -> `max_completion_tokens` parameter renames. That is not
   a model retirement, and the registry does not cover it. The outreach was built on a pain
   Mendr does not solve.
