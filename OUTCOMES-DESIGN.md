# Learning from outcomes (L5) — design, not built

2026-10-05. The fifth layer of the change-intelligence plan, and slice 7 of the locked build order
("persisted resolution"). **Designed now, built after Gate 2**, by the rule in `BETA-GATES.md`:
*"the shape of a resolution record depends on what a team actually does with a finding across more
than one cycle, and one merge does not show that."* Gate 2 is two merged Mendr pull requests on one
external repository, which needs the 2026-10-23 retirement event. Today the count is zero.

`PLAN-30-DAYS.md` P2-A and P2-B already set the scope. This document turns them into a record, the
questions it answers, and what it will never do.

## What the layers below cannot know

L1 to L4 make Mendr's *claims* true: the date is on the provider's page, the parameter rule quotes the
provider, a swap that changes the request goes to a person. None of them can say whether the
**migration worked** for the team that took it. Today resolution is inferred by absence: a model that
was actionable is missing from the next completed scan on a fresh registry. That is honest, and it is
not a record. Nothing survives to say what was done, by whom, and whether it held.

## The record

One row per finding that reached a decision, assembled from evidence Mendr **already receives**. No
new collection, no production telemetry, no code.

| field | source today |
|---|---|
| finding: `entryId`, file, line, tier, reason code | the audit report the App ingests |
| decision: approved / acknowledged / left open, who, when | the App's `approvals` and `acknowledgements` tables |
| verification: each gate's status (`passed / failed / skipped / not_run / inconclusive`) | the migration report from `mendr-action` |
| the pull request: opened, merged, closed unmerged, reverted, with timestamps | reported by `mendr-action` from the customer's own CI on the pull request's close event, OIDC-proven like today's migration report |
| **what the human changed** before merging: which keys of Mendr's proposed edit differ in the merged commit (`max_completion_tokens` value raised; replacement id swapped for another) — key names and counts only, never the values or the code | computed by `mendr-action` in the customer's CI, which already holds the proposal and can read the merged head |

**The App gains no permission.** It keeps `checks:write` and `metadata:read` (+ the optional
`actions:write`). It cannot read pull requests or code, so every fact about a pull request's fate is
reported from the customer's CI, the same path the migration report already takes.
| resolved: the first completed scan on a fresh registry where the finding is absent | the next audit |
| held: no revert and no reappearance within 14 days | later audits |

## The questions it answers, each one a decision a person takes

Learning here is counting, not a model. Each tally goes to a person, who changes a rule or the
registry through a pull request. Nothing relaxes itself.

1. **Was the L4 reversal right?** For `param_behaviour_change` findings: in how many merges did the
   human change the carried-over value? Often: keep review. Almost never, over enough merges: that is
   the evidence to make a class automatic again, and the only evidence that should.
2. **Do teams take the provider's replacement?** How often the merged id differs from the designated
   one is a registry signal, and the answer to "should the replacement be a choice?"
3. **Is "verified" true?** A verified pull request reverted, or a finding that reappears, is a
   measured incorrect verified edit: the invariant in `BETA-GATES.md` stops being asserted and starts
   being counted.
4. **Which findings are noise?** Acknowledged and never acted on, per rule and tier, is the precision
   number the corpus cannot give, because the corpus has no owners.
5. **When may an AI draft exist?** The locked rule: an AI repair agent waits until customers produce
   migrations deterministic rules cannot handle. Findings that stay open because no rule fits, counted
   here, are that evidence. Until they exist, the agent is not built.

## Never

- No production telemetry: *maintains itself on CI and repository evidence*, not *observes your
  production*. The plan's top Plane 4 node stays open and unclaimed.
- No code, prompts, or parameter values stored. Key names and counts only.
- No automatic relaxation of a rule. A tally informs a person; a pull request changes the rule.
- No training on customer data.
- No auto-merge, which stays off by the 2026-09-09 decision.

## When it is built

After Gate 2, as one slice: an `outcomes` table derived from the events above, a weekly tally per
rule and reason code, and an acceptance test on the first two merged external pull requests showing
the full lifecycle, from finding through approval, merge and resolution to held. Built before then it
would be shaped by guesses about behaviour nobody has observed.
