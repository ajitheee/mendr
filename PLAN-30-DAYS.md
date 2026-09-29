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
| **2026-10-12** | 14 | The bundled registry grades itself stale. A zero-finding run then reads `inconclusive`. **Inside Part 1.** |
| **2026-10-23** | 25 | OpenAI stops serving `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini`, `o4-mini`. Gate 2. **Inside Part 2.** |

> **Corrected 2026-09-29: the first date was 10-09 and is now 10-12.** It is not a calendar fact.
> It is `BUNDLED_PUBLISHED_AT` in whichever **tag** a stranger installs, plus 14 days. 10-09 came
> from `v0.5.6-alpha` (stamped 2026-09-24); `v0.5.7-alpha`, cut 2026-09-28, moves it to 10-12. So
> this row moves every time a tag is cut with a re-stamped registry — and an ask that names an
> **old** tag inherits the old, earlier cliff. `launch/GATE2-ASKS.md` pinned 0.5.6 and has been
> repointed.

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

> ### P1-A stays OPEN. Status, set 2026-09-29:
>
> > **Failure no longer reproduces; root cause unknown; historical telemetry unavailable.**
>
> Approval #8 fired on 2026-09-28 and the loop closed (P1-B), so the "nothing downstream is worth
> doing" line above is overtaken by events — but nothing was *diagnosed*. The button went from dead
> for 170 runs to working, for reasons nobody established, and the logs that would have said why no
> longer exist. A defect that stopped reproducing on its own is not a fixed defect; it is an
> unexplained one, and the next click may be a stranger's.
>
> **Containment required before any external reviewer depends on the button.** Five items, none of
> which need the original failure to recur:
>
> | # | item | what it has to do |
> |---|---|---|
> | 1 | **Sanitized request-level instrumentation** | One record per approval attempt, from first byte to outcome, carrying no secrets and no customer source — it must survive the redaction rules the sanitizer already enforces. This is what was missing; capture it permanently rather than waiting to catch the next failure live. |
> | 2 | **Deployment identification** | Every record names the build and instance that served it. Without this, "it works now" cannot be distinguished from "it works on the instance that happens to be warm". |
> | 3 | **Failure classification** | Each attempt ends in a named class — client-side never-sent, auth, dispatch, provider timeout, unhandled throw — not a bare success flag. A class is what makes the next occurrence diagnosable on the first look instead of the tenth. |
> | 4 | **Post-deployment smoke test** | An approval path exercised automatically after each deploy, so the button is proven on the build that is live rather than on the build it was last tested on. |
> | 5 | **Manual fallback path** | A documented route by which a reviewer completes the approval **without** the button. |
>
> **The gate, stated so it cannot be fudged:** if item 5 exists and the external workflow can be
> completed manually end to end, **outreach proceeds while root-cause work continues** — the
> unknown cause stops blocking P1-F. If the button is the **only** path to completing the workflow,
> **P1-A remains a blocker** and no ask that depends on approval should be sent.
>
> Ajith's one click and one Render log line is still the cheapest possible diagnosis and still
> worth doing, but it is no longer the only route forward, and it is no longer something to wait on.

## P1-B · Close the loop once, end to end  —  **DONE 2026-09-28**

**It closed.** Approval #8 fired at 06:11 on 2026-09-28 after 170 runs of `skipped`;
`Run Mendr and open a PR` executed, the sandbox verify reported `✓ type-check passed`, and
[`mendr-demo#5`](https://github.com/ajitheee/mendr-demo/pull/5) opened and **merged at
06:12:12Z** — `gpt-4-0613` → `gpt-5.6-sol`, one line. All eight links ran for real, including
the one that mattered: **the report sanitizer has now run on a customer path**, so the S1
security deliverable is no longer test-only.

Twenty-three minutes later, `698ed178` deliberately restored the id — *"demo: call gpt-4-0613
again, so the repository demonstrates something"* — the same reset as 09-26 and 09-12. That is
fixture maintenance, not a regression, and `mendr-demo` is a fixture. It does mean the repo's
history shows a fix being undone, which `launch/GATE2-ASKS.md` now tells Ask 2 to disclose
rather than let a reader discover.

**What this does NOT close:** P1-A's root cause, and Part 1's actual goal. The loop closed on
`mendr-demo`, which is Ajith's own repository. The goal is a repository that is not
`mendr-demo`, owned by someone who is not Ajith. That still needs P1-F, and P1-F needs a send.

The original text follows, since it records what was true for 170 runs:

The migrate path had **never executed**: 169 runs on `mendr-demo`, every one
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

`launch/GATE2-ASKS.md` is written and unsent. Ask 1 must go **before 10-12** (was 10-09; the date
moved with the tag — see the correction under "The two dates") or its central claim goes stale.

**Re-verified 2026-09-29, and all three asks needed changes:** Ask 1 pinned the superseded
`v0.5.6-alpha` and quoted a 98 s install that is now 54 s; Ask 2's check-run URL below is stale;
**Ask 3's issue is closed with zero replies**, so its "one live public room" premise is void and a
one-token PR is the only form that can now produce a verdict. All three are corrected in place.

Ask 2's blocker is cleared — `mendr-demo` is public and a logged-out stranger can see the
finding — but the URL here is **stale**. The current check run is
`https://github.com/ajitheee/mendr-demo/runs/109424680822`, titled
**`gpt-4-0613 stops serving in 24 days · 1 patch eligible`**. Scheduled runs replace it, so
re-check it the hour it is sent rather than trusting this line.

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

**P1-G0 · Verify two facts before building on them.**  —  **DONE 2026-09-28.** Both checked
against primary sources, and one corrected a claim made earlier the same day.

**`llmstatus.ai` does NOT verify the swap — the differentiator survives.** Their own docs:
`mm fix` rewrites ids (boundary-safe, style-preserving, chain-aware) with a red/green dry-run
preview. Nothing runs a type-check, build or test suite on a throwaway copy; it is a generated
diff a human confirms. Their pricing page (Free / $5-yr / $29 lifetime) lists no PR automation
at all — the GitHub App and "open fix PR" appear on marketing but are not corroborated there.
And where their App does run, it runs **on their servers**, so Mendr's customer-CI-only
guarantee is a real difference rather than a slogan.

**CORRECTION — "no competitor has a deadline primitive" was WRONG.** Renovate has none.
`llmstatus.ai` has them: Pro includes custom lead times at 90 / 30 / 7 / 1 day, and
`ci . --fail-on retiring` fails the build — which is the arXiv paper's own recommendation,
already shipped. They are also broader on detection: **16 providers / 599 models / 6-hour
refresh** against Mendr's 3 providers / 161 entries, scanning `env`, `aws-secrets`, `k8s`,
`helm` and `sql`, with a **chain-aware** fix that follows the replacement chain when the
replacement is itself dying. Mendr does not do that.

**OpenAI has NOT shipped a deprecation API, and formally declined to.** The request "Expose
Model Deprecation Dates Through the API" was opened 2023-11-09 and **closed by OpenAI staff on
2026-06-18**: *"We can't promise implementation or timing."* Best news in the research for the
registry. Honest caveat: 7 replies over 2.5 years is a thin demand signal — it says they will
not build it, not that anyone wants it. They notify **by email**, to whoever owns the API key
rather than the team that owns the repo, which is the documented failure mode in every incident
writeup the research found.

**THE FINDING THAT CHANGES THE PRODUCT: the aliases are not redirected.** OpenAI's own table
shows the rolling aliases themselves — `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, `o1-pro`,
`o3-mini`, `o4-mini` — shutting down on 2026-10-23. So **a gateway alias pointing at `gpt-4`
breaks exactly as hard as a hard-coded string.** The gateway layer does not dissolve this wave
at all. That makes P1-G2 more valuable, not less: a LiteLLM `model_group_alias` pointing at a
retiring id is a live bomb that nothing currently checks.

**P1-G1 · The deadline becomes the headline.** The check run says
`1 patch eligible · 0 review required · 0 informational`. It should say
**`gpt-4-0613 stops serving in 25 days`**, with the provider quote and snapshot link inline.

*Rationale corrected by P1-G0.* "No competitor has a deadline primitive" is false —
`llmstatus.ai` ships lead-time alerts and a `--fail-on` CI flag. The narrower claim that
survives is the one worth building on: **nobody puts the deadline on the commit, inside the
check the reviewer is already reading, with the provider's own sentence and a stored snapshot
beside it.** llmstatus alerts by email and Slack, away from the code; Renovate has no date
concept at all. Mendr can put the countdown where the decision is actually made, and back it
with evidence neither of them holds.

Still first because it is small and lands on a path already walked twice today
(`app/src/ingest/checkRun.ts`).
*Clickable:* the check run on `mendr-demo`, on a real finding.

**P1-G2 · Scan gateway configs.** LiteLLM `config.yaml` (`model_list`,
`litellm_params.model`, `model_group_alias`, `fallbacks`), Portkey Config JSON, OpenRouter
Presets. Teams that adopt a gateway are currently **invisible** to Mendr, and they are the
sophisticated teams worth selling to. Cheapest change with the biggest strategic payoff.

**P1-G3 · Call-site-aware detection.** A model id in a changelog or an old test currently
fires like a live call. A free Semgrep rule that requires the id to sit in the `model` field
beats Mendr on precision until this is fixed.

> **Rescoped 2026-09-29. `MEASUREMENT-2026-09-28.md` already said "do not build P1-G3 as
> scoped" — precision was never the problem, recall was. The remaining precision work is
> narrower than the heading, and it is a CLASSIFICATION job, not a suppression job:**
>
> - **Classify, do not hide.** A test double or a fixture that references a retiring id is a real
>   reference and stays **reported**, in its own labelled class — a reader must still be able to
>   find it, because a fixture pinned to a dead id breaks their build on 10-23 exactly like
>   production does. Silently dropping it would be the false clean this product must never give.
>   The scanner already has the right shape for this: report it, tier it low, and say why.
> - **Automatic migration is limited to supported production call sites.** A fixture, a test
>   double, an example or an unresolved wrapper may be reported and may be reviewed, but must
>   never be `patch`-eligible and must never be rewritten unattended. This is the invariant that
>   keeps the blast radius honest, and it is already how Tier A is gated — this makes it explicit
>   for the test and fixture classes rather than leaving it to follow from path rules.
> - The immediate instance is librechat's `api/app/clients/specs/FakeClient.js:33`. It sits in
>   `specs/`, which the directory list does not carry (`tests?` is there, `specs?` is not), so a
>   jest double is currently classed as live code. Fixing the list is the cheap half; giving test
>   and fixture references their own reported class is the half that generalises to a customer's
>   own repository.

**P1-G4 · The honest competitive page.** Name `llmstatus.ai` and `modeldeprecations.dev` in
Mendr's own docs, concede the registry and CI architecture are similar, show the verified-swap
and evidence difference. A prospect will find them; better they find this first.

> **Gated 2026-09-29: written when ready, published only on evidence.** The page's whole value is
> that it is *honest*, and its central claim — that Mendr's verified-swap and evidence
> architecture is worth more than a free tool's breadth — is currently **unevidenced**: zero
> external repositories have run it and zero verdicts exist. Publishing a comparison whose
> differentiator rests on nothing but our own measurement would be the same error as the invented
> model ids in the film: a confident claim assembled without the facts under it.
>
> **Do not publish P1-G4 until the external runs provide evidence for its claims.** Drafting it
> early is fine and probably useful — it forces us to name what we would need to prove. Shipping
> it before a stranger has produced a finding is not.

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
