# mendr — the next-level architecture and route

Committed design, researched 2026-08-22, the night the first 3 users start. main is FROZEN at the CLI they run; everything here is built on branches and each phase earns its merge on a real user's repo.

## thesis

Retention is the product. The graph is the moat behind it, not the headline.

A CLI is a one-shot tool: someone runs it, gets a diff, and leaves. Three people running it once is not three users, it is three trials. The whole architecture is aimed at one thing first, turning a run into a resident object that keeps delivering value between retirement events, without us running a server and without touching what tonight's users run.

The clever detection engine comes second, because a churned user makes recall worthless.

## the layers

| layer | role | already built | to build |
| --- | --- | --- | --- |
| **CLI** | stateless one-shot scan, the funnel | full scan, tiers, atomic write, evidence, validate-registry | its only new job: end by offering `mendr watch --install` |
| **Standing Watch** | the resident object that retains | **BUILT on branch `watch`:** `mendr watch` exposure scan + churn-free `.mendr/exposure.json` + self-updating "Mendr Watch" issue (via scaffolded Action) + optional badge | Phase 2 thresholds (below) |
| **Detection engine** | recall behind the gate | string + shallow-AST match (direct literals) | two-graph seam (below), proposer-only |
| **Registry + trust** | what may auto-apply | 4-field gate, quarantine, evidence, discovery→candidate→promote, CI validator | unchanged; it stays the sole authorizer |
| **Hosted watch** | the paid tier | — | sound graph in the customer's CI + minimal Postgres, only after a payer exists |

## the retention loop (phase 1, the important one)

Steal the Renovate Dependency Dashboard mechanic wholesale. After the first run, the Action posts ONE issue, found by a hidden marker and edited in place forever, never re-spammed, listing every model id found in the repo mapped to its registry retirement date, sorted by nearest deadline, with a live countdown. It re-surfaces itself with no re-invocation, and because it is a persistent object in the repo it survives GitHub silently dropping a cron run. Backed by a committed `.mendr/exposure.json` and a README badge (`mendr: 3 models watched · next retirement 62d`) for ambient reassurance.

No server. Scheduled + PR-triggered Action, the dated bundled registry, running on the customer's own CI. Private-repo-first, which is exactly the paying ICP, so GitHub's 60-day scheduled-workflow auto-disable (public-repo-only) never touches them.

Honest scope: day-granularity countdown (cron drifts 5-30+ min), no "nothing changed" weekly digest, one issue per (model, threshold) edited on rerun forever. The first duplicate is the start of Dependabot-style churn.

## the engine seam (committed)

**Shipped today (the honest current state):** BOTH entry points — CLI and GitHub Action — run the SAME analyzer, `scanLiterals.ts`: literal detection → shallow-AST context → in-file usage classification. Neither performs TypeScript type-checker resolution for LLM usage. The Action runs in CI and executes the project's gates against installed deps, which makes its *validation environment* stronger — NOT its *detection*. "Type-aware" / "type-resolved" describes the analyzer's depth, and the analyzer is not type-aware yet. That phrase may NOT appear in a shipped/solid lane of any diagram or doc until the resolver below actually exists. (This is the exact plan-tense-wearing-a-shipped-label overclaim we have corrected repeatedly; it is written here so it cannot drift back.)

The seam below is the COMMITTED target, both backends unbuilt. One detector logic, two resolver backends behind the same 4-field gate.

- **CLI backend (planned)** = tree-sitter syntactic N-hop resolver. No deps, ~2s, proposer-only. Indirect hits are hard-capped at Tier B / Tier C and can never auto-apply. Direct literal matches keep auto-applying exactly as today, never touching the graph.
- **Action / hosted backend (planned)** = ts-morph type-resolved resolver, run inside the customer's own CI where deps already exist, so symbol resolution is sound. The only place an indirect hit could ever be promoted toward Tier A, and it must timebox and fall back to the syntactic backend loudly, never silently downgrade.

Until those ship, the only true CLI-vs-Action difference is the gate environment: local shell vs CI against real installed deps.

Recall, grounded (projection, not measured): today catches direct literals only, ~50-70%. Syntactic N-hop recovers same-file chains + cross-file-by-import-name + one-hop factories → ~80-90%, delivered as Tier B, ~1.5-3 eng-weeks. Typed ts-morph recovers shadowing / path aliases / re-exports / right-client disambiguation → ~95%+, ~3-5 eng-weeks.

Backend choice, decided: **ts-morph** for the sound path. **CodeQL is killed on licensing** — its CLI blocks automated analysis of private repos without GitHub Advanced Security, and the payers run private repos. **SCIP** is deferred to a later polyglot/caching need.

Skills = deterministic modules: `detector + classifier + fix + tests + registryData`, one deprecation class each, no red/green fixtures → can't register. No LLM anywhere in the fix/gate path.

## safety invariants (must hold at every phase)

1. The 4-field gate is the ONLY authorizer of Tier A. New recall lands entirely as Tier B / Tier C.
2. detector→classifier→fix→gate is 100% deterministic. An LLM may run only in a fenced Tier-C advisory lane, never sets a gate field or picks a replacement, enforced by a CI test that fails if any module reachable from the fix/gate path imports the LLM client.
3. Provenance is a property of WHERE analysis ran, unforgeable from the CLI (no node_modules → no sound resolution). Incomplete resolution downgrades to syntactic (ceiling B), never optimistically stamps sound. The graph changes recall, never tier.
4. Every graph edge that leads to auto-apply must be re-derivable by the leaf matcher: a matchable literal at the concrete edit site against a gated registry entry. No literal at the destination → Tier C, never a write.
5. No auto-merge, ever. Hosted "auto-apply" means author a verified PR; nothing merges or pushes to a deploy branch.
6. Customer code and tests NEVER run on Mendr infrastructure, only in the customer's CI; Mendr consumes only the Checks-API pass/fail. PR-authoring identity, registry signing key, and any runner are three separate trust domains.
7. Registry stays git-committed, signed, append-only, version-hash pinned into every PR; the candidate queue has zero write path to the active registry and the engine never reads it. The air gap is physical, not a runtime check.
8. Before the hosted watcher touches a non-canary repo: canary rings (≥72h AND ≥5 PRs merged-not-reverted in 14 days AND zero "this is wrong" flags), an independent circuit breaker freezing an entry fleet-wide past ~5% revert/fail/reject, one-command fleet recall by entry_id.
9. The CLI keeps zero runtime state: pure function of (repo bytes, bundled registry, flags). No cache, telemetry, or tokens on disk.
10. Every phase merges to frozen main only after the full test suite + validate-registry pass and it earns it on a real user's repo. Users opt into a phase via `npx github:ajitheee/mendr#<branch>` without changing what the frozen default resolves to for the others.

## the route

**Phase 1 — Standing Watch (retention, this week). — BUILT on branch `watch` (2026-08-22).** Turns the CLI from a tool you run once into a resident object. Shipped: `mendr watch [path]` (exposure scan over TS + Python, reusing the fix path's analyzer — no new detection), churn-free `.mendr/exposure.json` (durable facts only; countdown derived at render time so an unchanged repo produces byte-identical output), `mendr watch --install` scaffolding `.github/workflows/mendr-watch.yml` (runs in the customer's own CI; `issues:write`+`contents:read` only; opens no PRs, runs no tests, pushes no commits), one marker-identified self-updating issue upserted via `github-script`, an optional snapshot README badge. Urgency (badge colour, "overdue" framing) is driven by LIVE (`model_arg`) occurrences only — a data-only reference to a retired id is listed but never alarmed. 27 unit tests + a full end-to-end run verified. User feels: a persistent issue appears listing their exposure by deadline and updates itself; they never asked it to come back. Start signal: true today, the 3 users have each run the CLI once. Kill: ≥10 days pass and none install the Watch, or all who install close it within a day → the pain is too rare to stay resident; treat mendr as a one-shot utility instead. **Must merge before ~Oct 1 so the Watch fires on the real Oct 23 OpenAI wave, the most persuasive retention event of the year.**

**Phase 2 — Between-events early warning.** Give the resident Watch a reason to ping before a retirement, filling the ~8 dead weeks before Oct 23. User feels: "mendr told me OpenAI was killing gpt-4 before OpenAI's own email did," a dated warning when a countdown crosses 90/30/7/1 days for a model in their code, with the registry's evidence inline. Ships: threshold logic (one issue per model+threshold), "what changed since last run," opt-in draft PR pre-staged behind the gate. Start signal: ≥1 Phase-1 user leaves the Watch open past a week or merges a Watch-driven PR. Kill: pings get muted → pull back to passive-and-silent, push no more.

**Phase 3 — Recall: syntactic N-hop proposer.** Raise recall on indirect/cross-file flows (~50-70% → ~80-90%), delivered as Tier B, precision protected by refusal. Ships on branch `graph`: the tree-sitter syntactic resolver, proposer-only, off by default (`--graph`). Start signal: a retained user reports an ACTUAL false negative, a model reference mendr missed. Until then the gain is unproven and we don't build it. Kill: <2 genuinely new true hits across the 3 repos and it mostly adds review noise → park behind the flag.

**Phase 4 — Paid hosted sound watch.** Sell what the free Action structurally cannot: sound type-resolved recall (~95%+), reliable timing, private multi-repo monitoring. Ships on branch `hosted`: ~6-table Postgres, typed graph in the customer's CI (never Mendr infra), SCIP index to object storage; no-auto-merge + canary rings + circuit breaker + isolation, all tested. Start signal: a retained user hits a wall the free Action can't clear (asks for private continuous monitoring, complains a cron run was late near a deadline, wants >1 repo). That request is the buy signal. Kill: they hit the wall but won't put a card down → the ICP or price is wrong; re-interview the segment.

**Phase 5 — Referral loop.** Make the paying user pull the next one in. The verified PR and Watch issue are already public artifacts; a teammate seeing "verified against provider source X, hash Y" arms their own repo with one `mendr watch --install`. Start signal: first paying customer. Kill: paying but not referring after ~30 days → accept growth must be bought via the retirement calendar.

## honest risks

- Retention itself is the untested bet. Three users have run the CLI once; none have installed a standing watch. If the pain is too rare to justify a resident object, no graph cleverness fixes it. That is why retention is sequenced first.
- The serverless path goes dark on dormant PUBLIC repos (GitHub disables scheduled workflows after 60 days with no commits). The private-repo ICP is safe by construction; do not claim the no-server path covers dormant public repos. Closing that gap needs an opt-in email backstop, the smallest possible server, built only once users say the alerts are worth an email address.
- Timing is day-granularity only. GitHub cron drifts and drops runs under load. "Fires exactly at 9am" is a lie we won't tell.
- The syntactic recall gain is a projection, unproven until a retained user hands us a concrete false negative. Build it on a real report, park it if it doesn't earn its place.
- Canary rings only catch wrongness that reproduces in canary configs. The honest claim is "blast radius bounded to a small K," not "prevented."
- This project has shipped 12 overclaims. Everything through Phase 2 is retention with no new inference and no server. The hosted product, the SCIP graph, and any dashboard are explicitly NOT built until a payer exists.
