# mendr go-to-market and monetization plan

this is the committed plan, not a set of options. the decision on money is made and not reopened. the whole thing is built to keep you talking to people instead of disappearing into the editor.

## the north star

verified fixes merged into repos you do not own, counted every week. not stars, not installs, not likes. a fix someone accepted into code you do not control is the only real proof the tool delivers value, and it is the same thing a company might later pay to automate. everything below ladders up to that one number.

## the decision: what people pay for

you charge for the watching, not the fixing. the fix is what earns trust and spreads. the money comes from someone paying so a surprise model retirement is a green pull request waiting for them instead of a production outage. it is insurance for an intermittent 4am problem, so it is priced flat per organization and billed annually, the same reason people keep paying for a smoke alarm between fires.

per-seat pricing is rejected. the risk scales with how much LLM code you have, not how many engineers, and per-seat would punish a team for hiring. per-fix pricing is rejected. nobody keeps paying rent on a fire extinguisher.

the published ladder (this is also the public anchor):

- **free, $0 forever.** the full CLI, unlimited, run locally as often as you want. the public deprecation registry. the GitHub Action watching one private repo and opening verified PRs. this is a deliberate loss leader, the same posture as dependabot being free inside github. it is the funnel, never counted as revenue.
- **team, $49/mo or $490/yr.** continuous watch on up to 10 private repos across openai, anthropic and google. the private early-warning registry that carries a retirement date before it becomes an outage. verified auto-PRs, slack and email alerts, a 48-hour SLA to open a PR once a deprecation is public.
- **business, $199/mo or $1,990/yr.** unlimited repos, a 24-hour SLA, SSO and audit log, and the insurance clause: if a deprecation already in our registry breaks your prod and we failed to open a PR, we credit you. that clause is what turns an occasional pain into a standing subscription.
- **enterprise / on-prem, custom from ~$1,500/mo.** self-hosted action and registry inside their VPC, bring-your-own-LLM for the verify step, SAML and a DPA. this is also the home for python once it ships.

first ten customers are signed as design partners at a flat $500 for a 3-month concierge pilot, or free, in exchange for a logo and a dated testimonial. the $49 and $199 numbers stay the published price so those early deals read as a discount, not a ceiling. the price is a reasoned guess, not a validated number. let real willingness to pay reveal itself before touching it.

## what the free cli is for

it has three jobs and none of them is revenue.

1. get installed and run by the right devs during a real retirement wave, producing merged fixes in repos you do not own.
2. be the vehicle for the wow. a real verified PR opened on someone's own public repo is the only thing amplifiers and maintainers actually pass along.
3. be the permanent answer to "why not just use dependabot." a model id like `gpt-4o` is a string in your application code, not a package version, so dependabot and renovate structurally never fire on it. that is the whole reason this tool has to exist.

## track one: visibility (free users and amplifiers)

the audience is the javascript and typescript ecosystem, not "ai devs" in general. every post states the typescript-only scope up front. most agent and LLM repos are python and you cannot touch them yet, and getting caught overclaiming costs more trust than the extra reach is worth.

the unit of amplification is a verified diff on the target's own public repo, handed over. never a cold ask. the hard rule is real diff or no diff. zero wrong edits across 26 repos is your only moat against copilot autofix, and one bogus PR burns it permanently.

- **keystone: land a Show HN first**, on a tuesday or wednesday around 9-10am ET. plain title, three real diffs from recognizable projects in the first comment, and pre-empt the dependabot and intermittent-pain objections in the post itself. the newsletters and the big accounts mostly react to what already landed on HN.
- **primary channels for a founder with no audience:** cooperpress (javascript weekly, ~400k, and node weekly), console.dev, and bytes.dev, all submission-based and exactly your audience. plus X through matt pocock with a verified PR on one of his own repos.
- **wow-play PR targets:** matt pocock, syntax.fm (syntaxfm/website), theo / t3.gg, and librechat.
- **secondary:** latent space discord (share the registry as a resource, be upfront that python is unsupported), and r/typescript, r/ChatGPTCoding, r/LLMDevs, r/SideProject, posting the outcome not the tool.
- **skip:** product hunt, fireship, paid TLDR sponsorship.
- **cadence, two tracks.** an evergreen proof once a week: run mendr on one recognizable public TS repo and publish the verified diff. plus an event-pegged loud push whenever a provider actually deprecates something, fired across HN, cooperpress, console, bytes and X at once. the concrete trigger is gemini 2.5 retiring on oct 16 2026. do not manufacture urgency in the quiet weeks.

honest caveat: this track produces installs, stars and waitlist signups, not revenue. amplifiers and payers are different people. star counts are never treated as traction.

## track two: paying customers

**who they are.** seed to series B software companies, roughly 5 to 40 engineers, whose core paid feature calls an LLM directly through the openai, anthropic or google api (not bedrock or azure, which pin versions and defuse the pain), on a typescript codebase, with the call in the hot path of what customers pay for so a dead model id pages someone. the buyer is whoever owns the on-call rotation: a founding engineer, an eng lead, or a CTO. the sharpest cut is live-voice and real-time agent products, where a dead model id breaks a customer conversation in progress.

**named targets.** alcemy (robert meyer, technical co-founder, on linkedin; reference the feb 2026 gpt-4o and june 2026 claude 4 retirements), hyperbound, pitchmonster, grydl (confirm the stack is typescript first), factor (confirm typescript and direct provider api first), reps.ai (confirm it exists and is TS before spending time). librechat / danny-avila is the highest-leverage design partner and amplifier, named honestly as not a payer.

**the pitch.** when openai, anthropic or google retires a model, your live calls start returning errors and your product is down until someone hand-edits every call site. dependabot will not catch it, because a model id is a string in your code, not a package version. mendr watches your repos against a maintained list of retirement dates and opens a pull request that swaps the dead id and any changed params before the date hits, only after the change type-checks and your own tests pass. you get a heads-up and a green PR instead of an outage. it costs less than one bad on-call night.

**the first pilot.** a 3-month paid pilot on one design partner's main product repo, the action running in their own CI, opening a verified PR ahead of the gemini 2.5 retirement while it is live. flat $500 invoiced once, small enough that the eng lead approves it without procurement. it buys the logo and a dated case study, not margin, and converts to a standing subscription in the $49 to $199 band.

## the product you would build to charge (and how far along you are)

to charge the pilot price, nothing new needs to be built. the pilot runs on what already ships.

to charge the standing hosted subscription, six things get built, in this order, and only once a team has agreed to pay:

1. a hosted dated deprecation feed with real retirement dates and auto-ingestion from provider deprecation pages (2-4 weeks). this is the actual product and the moat. without dates there is no "before it breaks" pitch, only the after-the-fact fix the CLI already does.
2. a github app plus backend (queue, worker, postgres) to store installs, tokens, repos and scan results and scan on a schedule (3-5 weeks).
3. slack and email alerting on new exposure and PR-open (about 1 week).
4. stripe billing gated on a flat per-org plan (1-2 weeks).
5. a dashboard with org and team accounts and a one-screen exposure view (3-5 weeks, where scope balloons, gated behind real paying demand).
6. python support, a second detection engine with its own verify gate (4-8 weeks). do not attempt this before a paying typescript customer exists.

**already built and real:** call-site-aware model-id and param fixes for openai/anthropic/google plus stripe renames (342 tests; 0 wrong edits across the 26 repos measured in the aug-2026 recall audit), the verify-before-apply gate, a dated registry carrying a per-entry verdict from a live-oracle check (94 of 106 stamped `verified` today, the rest blocked from auto-apply; a handful carry a recheck date with a note that the id was not researched on that pass), and the end-to-end github action. **not built:** any server, app, accounts, dashboard, billing, alerting, dated data, or python. realistically 3 to 5 months of focused build for the hosted product, and that is not the risky part. the risky part is proof that anyone pays.

## the 90-day plan

### phase 1, days 1-25: real usage and hardening on repos you don't own
goal: prove mendr runs clean and useful on code you do not control, and learn the real workflow from live users. no visibility push, no paid build. the only code you write is bug fixes a real user surfaced, plus registry updates.
- scan the named targets and 40-60 more public typescript LLM repos for model ids that are already dead today, so you get live hits without waiting for a retirement.
- for every real hit, open one verified PR or an issue showing the diff, following each project's contribution rules.
- message 20-25 maintainers and the named companies and push for an actual reply thread. ask what they do today when a model id dies.
- watch at least 3 people run mendr on their own repo and write down every hesitation.
- gate to pass: 5 non-founder people run it on a repo they own, at least 3 verified fixes merged into repos you don't own, and 8 real back-and-forth conversations. kill: if fewer than 3 people will run it once despite 20+ direct asks, stop and question the wedge.

### phase 2, days 26-50: reliability at scale and money discovery
goal: get it running unattended in someone else's CI, keep the registry current and dated, and find out from real teams what a paid product actually is. concierge pilots are allowed here because they need no new product.
- get the action running unattended in at least 2 external CIs.
- add real retirement dates to the registry, starting with gemini 2.5 on oct 16 2026.
- in every team conversation ask the money question plainly: who feels the cost, how many hours did the last retirement take, would you pay to have it handled.
- offer 3-5 ICP teams the flat $500 3-month concierge pilot.
- gate to pass: 10 cumulative merged fixes, the action in 2+ outside CIs, and 5 money conversations with 3+ saying yes to a specific offer (a signed $500 pilot counts double). kill: if no team with real retirement cost can name a reason to pay after you ask directly, do not build a paid product.

### phase 3, days 51-75: visibility, pegged to gemini 2.5
goal: now the tool works unattended and you know the paid shape. reach developers with proof, timed to the oct 16 retirement, and route any team that shows up into the paid conversation.
- bulletproof the repo and readme (TS-only scope, real diffs, verify step front and center) before posting.
- land the Show HN on or right before oct 16, then fire the coordinated push the day the retirement is announced.
- hand verified PRs to matt pocock, syntax and theo on their own public repos. do not force it if their repos are clean.
- gate to pass: new non-founder repos run it traceable to your posts, at least 1 named amplifier runs it, and 3+ new team conversations start from visibility. kill: if posts produce only stars and zero new merged fixes and zero team conversations, stop posting and go back to direct outreach.

### phase 4, days 76-90: convert to paid, build only what a payer bought
goal: first real money, and build the hosted product only as far as paying demand justifies.
- put the published price in front of the teams that said they'd pay.
- ask for a signed pilot or written commitment from the named companies and any visibility-sourced team.
- build the hosted watch in dependency order (dated feed, then app and backend and scan worker, then alerting, then billing) only for customers who already agreed to pay. dashboard and python stay unbuilt until a paying customer demands them.
- gate to pass: at least 1 team paying real money, or 3 signed pilots. first dollar counts more than any number of users. kill: if after 90 days no team will pay anything despite a working product and a clear offer, keep mendr as a free open-source tool and a maintained registry, and sink no more build time into a paid product until a team asks with money.

## this week

1. run mendr on repos you do not own and open verified PRs. scan librechat first, then the named targets and 40-60 public typescript LLM repos, for model ids that are already dead today. open one verified PR or issue on every real hit. real diff or no diff.
2. open direct conversations. message 20-25 maintainers and the named companies and push for an actual reply thread asking what they do today when a model id dies.
3. add the dated gemini 2.5 oct 16 2026 retirement entry to the registry so the pitch and the visibility push can ride a real dated event.
4. make the repo survive a skeptical live read now, not in october. the readme states the TS-only scope, shows real before-and-after diffs, and puts the verify step and the 0-wrong-edits-across-26-repos number front and center.

## the honest bottom line

the tool is real and the hard part is done. accurate detection, a working verify-before-apply gate, and 0 wrong edits across 26 repos, which is a genuine moat against copilot autofix. what you do not have is a single user, a single dollar, or any evidence that a company pays a monthly fee against a pain that fires every few months instead of daily.

the whole plan exists to stop you from doing the thing you default to, which is building when you should be talking to people. through day 50 you write no product code beyond bug fixes real users surface and registry updates. you measure yourself on verified fixes merged into repos you do not own. you do not let a pile of stars feel like traction, because the devs who amplify mendr are almost never the teams who pay for it.

the money decision is settled. flat per-org insurance, the CLI free forever, $49 and $199 published, first ten partners at $500 pilots for logos. but the price is a guess and the typescript-only scope caps the buyable market hard until python ships, which you must not build until a paying TS customer exists. if by day 90 no team will pay anything despite a working product and a clear offer, the honest outcome is a free open-source tool and a maintained registry, and you take that answer rather than sink two more months into a product nobody bought.
