# Partner beta outreach

Goal: 3–5 teams, each with at least one private repository, onboarded before 20 September 2026.
One external private repository onboarded is the last launch criterion still open.

## Who to ask (in this order)

1. **People who already replied to the read-only audit offer** (GitHub issues titled "Read-only audit request"). Warmest list; they asked for the scan.
2. **Founders and CTOs you know personally** whose product has an AI feature in production (a chat assistant, summarisation, classification). Any team that has ever hard-coded a model id.
3. **Small teams that shipped on GPT-4-era models**: look for public repos or changelogs that mention `gpt-4-0613`, `gpt-4-32k`, `claude-2`, `text-davinci-003`, `gemini-1.0-pro`. If it is in their public code, it is in their private code too.
4. **Agencies and consultancies** that maintain several client apps: one partner, many repos.

Do not ask: teams without a GitHub repo, teams whose only AI use is a hosted no-code tool, anyone who would need a security review longer than the beta.

## The message (LinkedIn DM or email; 90 seconds to read)

Subject: a 5-minute scan for retiring AI models in your repo

Hi <name>,

Quick one. Providers retire models on a schedule, and code that is pinned to one keeps working until the shutdown date, then returns 404 model_not_found. Most teams find out from a customer.

I built Mendr to catch that early. It runs inside your own GitHub Actions, reads nothing outside your CI, and sends only the findings to a dashboard: which model, which file and line, how many days until shutdown, and a verified replacement. If you approve, your CI opens a pull request; a person merges it. Mendr never merges.

I am onboarding 3–5 teams for a beta before the 20 September public release. It takes about five minutes: install the GitHub App on one repo, click "Set up the audit", merge the one-file workflow. Public or private repo, no API keys, MIT licence.

Would you try it on one repo this week? I will personally walk you through it and take every piece of feedback.

<your name>
mendr-mu.vercel.app

## Follow-up (three days later, if no reply)

<name>, one line: if you tell me the repo is private and which providers you call, I can tell you in a sentence whether Mendr would find anything there. No install needed for that answer.

## What we ask of a partner (put in the first call)

- One repository connected for the beta period (until 20 October), private preferred.
- One person who can click Approve and merge a pull request.
- Fifteen minutes of feedback after the first finding and after the first migration.
- Permission to count them (not name them) in launch material: "N teams, M private repos, K migrations".

## What we promise

- Only findings leave their CI; the App holds `checks: write` and `metadata: read` (plus optional `actions: write` so an approval starts instantly). Full statement in TRUST.md.
- Nothing is applied to their code without an approval; nothing is merged by Mendr, ever.
- Uninstalling the App deletes everything stored about the repository.
- Direct line to the founder for the whole beta.

## The nine metrics we record per partner (from BETA-ONBOARDING.md)

time to first green scan · findings on first scan · false positives reported · time from finding to approval · migrations opened · migrations merged · migrations rejected and why · support questions · would they pay (yes / maybe / no, and for what).
