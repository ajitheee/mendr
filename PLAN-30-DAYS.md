# The 30 days to a self-maintaining API

Written 2026-09-28. Two parts of fifteen days. Part 1 ends **2026-10-13** and puts Mendr in
front of test users. Part 2 ends **2026-10-28** and closes the loop.

Cross-checked node by node against the four-plane diagram. Every item below is a box on that
diagram that is empty or broken today; everything already built is named in
`PLANE-1.md` and in the status section at the end.

---

## The two dates that decide the split

| date | day | what it is |
|---|---|---|
| **2026-10-09** | 11 | The bundled registry grades itself stale. A zero-finding run then reads `inconclusive`. **Inside Part 1.** |
| **2026-10-23** | 25 | OpenAI stops serving `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini`, `o4-mini`. Gate 2. **Inside Part 2.** |

Part 1 finishing on 10-13 leaves **ten days installed before the wave**. That is the whole
strategic point, in the words already committed to `BETA-GATES.md`: *"a tool discovered on the
day of an outage is a tool nobody has time to evaluate."*

Gate 2 is what unlocks slice 7 by the existing rule, and it lands mid-Part-2. That is not a
scheduling accident to work around — it is why Part 2 is shaped the way it is.

---

# PART 1 — days 1–15, to 2026-10-13
### Goal: the loop closes at least once, on a repository that is not `mendr-demo`

Planes 1 and 2 are built. Plane 3's approval node has never fired, so **nothing those two
planes produce has ever reached a human**. Part 1 is not about adding capability. It is about
making the capability that exists deliver something, to someone.

**Done means:** a person who is not Ajith installed Mendr, saw a finding, approved it, and a
verified pull request appeared on their repository.

## P1-A · The Approve button  — *blocks everything else*

Plane 3, "Human and policy approval". Built, instrumented, and it has never once fired. The
founder clicks it and **no network request leaves the browser**.

Eliminated so far: the route (302 anonymously, so it exists), the form (real POST, real
`type="submit"`, no orphaning nesting), the live-poll script (only activates for a
`queued`/`running` approval, which has never existed), failed dispatch, cold start, the
signed-out path, the in-flight guard, the GitHub timeout, and unhandled throws.

Next, in order, and the first is not an engineering task:
1. **One Render log line.** `PR #19` put `log('approve clicked', …)` as the first statement,
   before the session check. Present or absent decides client-side versus server-side in one
   look. Ajith has to click it.
2. If absent — capture the button's rendered HTML from the element inspector. An orphaned
   submit, a `disabled` attribute, or a JS error before handler attachment all produce exactly
   this signature.
3. If present — the log names the exit. Every path in that handler logs and returns.

**Nothing downstream of this is worth doing until it is fixed.**

## P1-B · Close the loop once, end to end

The migrate path has **never executed**: 169 runs on `mendr-demo`, every one
`nothing is approved`, `Run Mendr and open a PR → skipped`.

The consequence is not cosmetic. `run-mendr.sh` is where the report sanitizer is invoked, so
**the S1 security deliverable has never run on a customer path**. Every "rehearsed on
mendr-demo" line in `RC-2026-09-16.md` is an *audit* rehearsal only.

One successful approval on `mendr-demo` proves: the claim, the sandbox verify, the patch, the
force-push, the PR, the progress stream, the sanitizer, and resolution-by-absence — eight
links that have only ever run in tests.

## P1-C · Make Plane 1 run itself  —  **DONE 2026-09-28**

The collectors are built and **hand-cranked**:

- `discover.ts` is scheduled monthly and **has never completed a scheduled run**.
- `catalog.ts` and `sdkReleases.ts` run **only by hand**. Nothing refreshes their output.

A change-intelligence plane that a human has to crank is not intelligence, it is a chore. And
it collides with 10-09: if the registry is not re-stamped, every clean scan a test user runs
in Part 1 reports `inconclusive`, which is the worst possible first impression.

- Fix the scheduled discovery run so it completes unattended.
- Put `catalog.ts` and `sdkReleases.ts` on a schedule.
- Re-stamp the bundled registry before 10-09.

## P1-D · Verify the two feeds that are signed but not checked  —  **CLOSED 2026-09-28, as a doc fix**

The deprecation registry is signed **and verified on read**. The catalog and the SDK record are
signed and published **and not verified on read**.

That is a trust boundary with a hole in it, in the one plane whose entire job is facts you can
trust. Small change, and it belongs before strangers' code is scanned, not after.

## P1-E · Cut `v0.5.7-alpha`  —  **DONE 2026-09-28**

Delivery is a step, not a consequence. `check-pins` already says it:

> *1 commit(s) touch `mendr-action/` or `src/cli.ts` since v0.5.6-alpha. Those changes reach NO
> customer until a new tag is cut… This is how PR #12's sanitizer shipped to nobody.*

The tag carries the Approve fix, the migrate honesty fix (#21), and the registry re-stamp. Cut
it **after** P1-A and P1-B, so it ships a loop that has been proven to close, not a better log
message on a broken button.

## P1-F · Put it in front of people — *runs from day 1, in parallel*

Zero external repositories are onboarded. Zero findings have been reviewed by anyone who is not
Ajith. The ask-to-verdict rate is not low, it is **undefined — the denominator is zero**.

`launch/GATE2-ASKS.md` is written and unsent. Ask 1 must go **before 10-09** or its central
claim goes stale.

Ask 2's blocker is already cleared: a logged-out stranger can see the finding, and the exact
check-run URL to link is
`https://github.com/ajitheee/mendr-demo/runs/108618583430`.

**Only Ajith can send.** This is the one item on the whole plan that engineering cannot do, and
it is the item the last gate was lost on: *"the gate was not lost at the deadline; it was left
three days early and the work returned to what was comfortable."*

---

## P1-G · Reposition on what is actually defensible  —  *added 2026-09-28, from the competitive research*

Six areas of market research landed on 2026-09-28 and changed what is worth building. The
findings that move the plan, each sourced:

- **The pain is real and documented.** An arXiv study (2026-09) of 22,555 commits across
  17,703 repos: **~82% of migrations off a retired model were committed AFTER the shutdown
  date**, median **39 days late**; **94%** of migrating apps hard-coded model identifiers. The
  paper's own recommendation is Mendr's mechanism, almost verbatim.
- **The registry is NOT a moat.** `modeldeprecations.dev` (MIT, with provenance),
  `deprecations.info` (free RSS/JSON/API), LiteLLM's cost map (carrying `deprecation_date`
  since 2025-01, bot-updated weekly), and first-party retirement APIs from **Azure AI Foundry**
  and **AWS Bedrock**. Azure additionally **auto-upgrades** Standard deployments at retirement.
- **The price anchor collapsed.** `llmstatus.ai` sells scan + check run + fix-PR button for
  **$5/year or $29 once**. Not $16,000.
- **The positioning is taken.** "Dependabot for your AI models" is already published under that
  name, for a free tool.
- **What nobody does:** verify the swap on a throwaway copy before a human is asked to look;
  quote-backed evidence with stored snapshots and a signature; a **deadline as a first-class
  primitive** — Renovate has no concept of a date anywhere in its config surface.
- **No gateway warns you.** Portkey and Cloudflare fallbacks fire on *errors*, i.e. after you
  are broken. OpenRouter's own blog concedes rerouting "can't help once the model itself is
  gone."
- **The threat to lose sleep over:** Mend.io already ships **Mend AI**, which inventories the
  specific model ids in a repo, *and* owns Renovate's PR engine. Both halves, one company,
  not yet joined.

**The repositioning, in one sentence:** stop selling *"we find retiring model ids"* — that is
free in five places and a 20-line Semgrep rule does it better than a regex. Sell **"Mendr
proves the migration is safe before you are asked to approve it, and shows you the provider's
own words as evidence."** Give the registry away deliberately, to buy distribution into the
tools the buyer already runs; charge for the verified swap and the audit trail.

### The slices, in order

**P1-G0 · Verify two facts before building on them.** ~1 hour, and it gates the rest.
Does `llmstatus.ai` actually verify swaps or only open PRs? Has OpenAI shipped any deprecation
notification for API consumers? If the first is yes, the differentiator is gone and this plan
changes the same day. Not building a repositioning on two unverified facts.

**P1-G1 · The deadline becomes the headline.** The check run says
`1 patch eligible · 0 review required · 0 informational`. It should say
**`gpt-4-0613 stops serving in 25 days`**, with the provider quote and snapshot link inline.
First because no competitor has a deadline primitive — it leans on the one thing that is
structurally hard for the rest of the field to copy, and it is a small change in
`app/src/ingest/checkRun.ts`, a path already walked twice today.
*Clickable:* the check run on `mendr-demo`, on a real finding.

**P1-G2 · Scan gateway configs.** LiteLLM `config.yaml` (`model_list`,
`litellm_params.model`, `model_group_alias`, `fallbacks`), Portkey Config JSON, OpenRouter
Presets. Teams that adopt a gateway are currently **invisible** to Mendr, and they are the
sophisticated teams worth selling to. Cheapest change with the biggest strategic payoff.

**P1-G3 · Call-site-aware detection.** A model id in a changelog or an old test currently
fires like a live call. A free Semgrep rule that requires the id to sit in the `model` field
beats Mendr on precision until this is fixed.

**P1-G4 · The honest competitive page.** Name `llmstatus.ai` and `modeldeprecations.dev` in
Mendr's own docs, concede the registry and CI architecture are similar, show the verified-swap
and evidence difference. A prospect will find them; better they find this first.

### Ranked below the line, deliberately

Per-channel divergence (the same id retiring on different dates on OpenAI direct vs Azure vs
Bedrock) is the most defensible idea the research produced — it needs exactly the evidence
corpus and breadth-first free tools structurally cannot follow. It is **not** in Part 1 because
it is worth weeks, and Part 1 has 15 days and no users.

# PART 2 — days 16–30, to 2026-10-28
### Goal: findings resolve and record their own outcomes, without a human driving

Part 1 makes the loop close once, with a human at every joint. Part 2 removes the human from
the joints that do not need judgement, and gives the system a memory of what happened.

**Done means:** a retirement lands, Mendr finds it, proposes it, a human approves once, and
everything after that — verify, deliver, confirm resolution, record the outcome — happens
without anyone being asked again.

## P2-A · Slice 7 — persisted resolution  *(unlocks at Gate 2, day 25)*

Plane 4, "Close finding and record outcome". Today resolution is inferred by **absence**: a
model actionable in the previous run and missing from a completed scan on a fresh registry.
That is honest, and it is not a record — nothing survives to say *what was done, when, by whom,
and whether it held*.

Gated on Gate 2 by the existing rule, and the rule is right: *"the shape of a resolution record
depends on what a team actually does with a finding across more than one cycle, and one merge
does not show that."* So design it in the first half of Part 2, build it after 10-23.

## P2-B · The observation edge, scoped to what Mendr can actually see

Plane 4's top node is "Observe errors, latency, cost and quality". **That is not achievable in
30 days and should not be attempted.** It needs customers to connect telemetry, no customer has
connected anything, and "customers will connect telemetry" is explicitly a hypothesis to test
cheaply rather than build.

What *is* achievable is a real feedback edge built from evidence Mendr already has a right to:

- the CI gate outcomes it already receives (`passed | failed | skipped | not_run | inconclusive`),
- the pull request's own fate — merged, closed, reverted,
- the next completed audit's confirmation by absence.

That closes the loop honestly. **Say what it is:** *maintains itself on CI and repository
evidence.* Not *observes your production*. The diagram's top node stays open, deliberately, and
is not claimed.

## P2-C · Store source evidence, not just hashes

Plane 1, "Immutable source evidence". Deprecation pages are snapshotted. The catalog and SDK
record keep a sha256 **with no stored copy**, so the hash can prove *that* a source changed and
never *what it said*.

The evidence corpus is named as the next moat. A moat you cannot read is not one.

## P2-D · Classify an SDK release as breaking

Plane 1, "Normalizer and change classifier". Nothing does this — slice 2 deferred it to a human
reading changelogs, and that curation step does not exist. Until it does, the SDK-releases node
feeds the graph facts nobody grades.

## P2-E · Gate 2 itself — two merged pull requests

Not an engineering task. It needs the 10-23 retirement event plus a repository that already has
Mendr installed, which is what Part 1 is for.

---

## What we are deliberately NOT building, and why

Naming these is as much of the plan as the work items. Each is a box on the diagram that stays
empty on purpose.

| node | why not |
|---|---|
| Kubernetes, database, infrastructure contracts | On the do-not-build list. Second change type before the first has a customer. |
| OpenTelemetry, gateway, DB metadata | Requires customers to connect telemetry — a hypothesis to test, not build. |
| IaC | Same family; no evidence any lead needs it. |
| GraphQL, protobuf | Additional API change types. The freeze names them. |
| `typeChange.ts`, `enumValue.ts` | Named stubs on the do-not-build list. Still 8-line TODOs, correctly. |
| Grounded AI repair agent | Waits until customers produce migrations deterministic rules cannot handle — and even then emits an unverified draft, never a Tier A repair. Invariant 2 verified holding today: `llmFix.ts` calls no LLM API. |
| Rollback | Automatic rollback is a hypothesis to test. No fleet to roll back. |
| Learning and rule improvement | Needs outcome data that P2-A only starts producing. |
| Jenkins, GitLab | GitHub-only until a customer asks in writing. |
| Canary or feature-flag rollout | Invariant 8's machinery is for a hosted fleet. There is no fleet. |
| A second change type (Stripe / OpenAPI) | Asked 2026-09-28. `src/detect/diffSpec.ts` (2026-08-04) shows this was the ORIGINAL idea before the pivot. It fails on the one thing that makes Mendr work: Stripe pins your account to an API version and old versions keep working, so there is **no shutdown date** — and the deadline IS the product. Without it the check run becomes a nag with no deadline, which is the churn the architecture exists to avoid. The right generalisation is not "API changes" but **dated shutdowns** (RFC 8594 `Sunset`), and not before change type one has a customer. |
| Multi-repo dashboards, campaign views, burndown | Sourcegraph shipped Agentic Batch Changes GA 2026-09-14 with auto-repair of CI failures, priced per merged changeset, with Mercari and Canva shipping on it. Moderne has $30M and Walmart. This is their ground. |
| Routing, aliasing, gateway features | Consolidating and far better funded: OpenRouter reportedly acquired by Stripe, Portkey raised $15M, Cloudflare bundles it free. |
| Registry breadth (more providers, more languages) | A free MIT tool shipped 18+ languages and 6 providers to one GitHub star. Breadth is not what is scarce. |

---

## The risk, stated plainly

**Part 1 depends on a human saying yes, and engineering cannot manufacture that.**

Everything in Part 1 except P1-F is inside our control and is achievable in fifteen days.
P1-F is not: it needs someone outside to install a stranger's tool and answer a question. The
last gate was missed on exactly this, and missed while the engineering was ahead of schedule.

Which means the honest reading of this plan is: **Part 1 is 80% outreach risk and 20%
engineering risk**, and the engineering half is mostly one button.

If on 2026-10-13 the loop closes cleanly on `mendr-demo` and still nobody outside has run it,
Part 1 has failed even with every ticket closed — and Part 2 should not start, because slice 7
is designed around what a real team does with a finding, and there would be no real team.
