# Seeing the models where they actually live — integration shapes

Design sketch. The problem: mendr is a static git scanner, but the best-fit
customers (Vapi, Retell, Stack AI, hosted Dify/CrewAI) keep model ids in config,
databases, feature flags, or only in the runtime request — a git scanner returns
zero for them (we proved this on dify: every model id was in a config catalog,
no live call sites). Five integration shapes were designed to close that gap.

## The one structural insight: MEASURE vs LOCATE

Every shape is strong on exactly one of two jobs and weak on the other:

- **MEASURE** — is this deprecated model *actually live*, where, at what volume/cost?
- **LOCATE** — *which* file / flag / DB row / line do I change to fix it?

| Shape | MEASURE | LOCATE | Effort | Reaches the runtime segment? |
|---|---|---|---|---|
| 5. Provider usage/billing API | ★★★ (in dollars) | ✗ (no location) | **low** | yes (zero-touch) |
| 1. Static config / IaC scan | ★ (config-in-repo only) | ★★★ (file + key path) | medium | no (only config committed to git) |
| 2. Live config-store / flag readers | ★★ (per-tenant counts) | ★★ (DB row / flag) | high | **yes** |
| 4. Runtime SDK / OTel | ★★★ (resolved id + full request shape) | ✗ (needs a source locator) | high | **yes** |
| 3. LLM gateway / proxy | ★★★ (wire ground truth, closed loop) | ✗ (needs a locate bridge) | high | yes (if centralized egress) |

The complete product is always a **MEASURE shape + a LOCATE shape**, never one
alone. The runtime shapes (3, 4, 5) prove exposure brilliantly but can't tell you
what to edit; the config shapes (1, 2) know what to edit but only see what's
declared. Do not sell "we fix it" for the runtime buyers until a LOCATE half exists.

## Why none of these is a rewrite — one spine, five ingests

Every shape reuses mendr's existing core unchanged:
- the **deprecation registry** (`llm-deprecations.json` + the verified gate) — the moat, one source of truth for every shape;
- **`classifyOccurrenceTier`** — the A/B/C vocabulary, computed one way;
- the **evidence schema** and the **PR/alert renderer**.

So "seeing config models" is a set of **ingest adapters feeding the same engine**,
not a new product. That is the strongest technical argument for doing this at all.

## The five shapes

**5. Provider usage / billing API** *(low effort, zero-touch)* — read per-model
request counts and real spend straight from OpenAI/Anthropic/Google usage APIs
with a read-only key. Sees exactly which deprecated models are live, in dollars,
plus **cost regressions** (silent price hikes, accidental upgrades). Aggregate
metadata only — no prompts, no PII (strongest privacy story). Can't locate or
patch. Friction: needs an org-Admin-tier read key. Doesn't fit BYO-key or
self-hosted. *The zero-touch first-look that scopes every audit.*

**1. Static config / IaC scan** *(medium effort, cheapest LOCATE)* — extend the
scanner from code to yaml/json/toml/env/Helm/Terraform + in-code catalogs, telling
a live model *selector* from catalog *metadata* by key-name + container shape +
a **reader tie-back** (grep for the code that reads the env var/key). Same trust
boundary as today (static, in-CI, no egress). Converts the config-in-repo slice
(dify-type) and finally *measures* it instead of returning zero. Builds the
reader-tie-back primitive the harder shapes reuse. Still finds nothing for
DB/flag/runtime customers.

**2. Live config-store / flag readers** *(high effort, reaches the segment)* — a
read-only, column-scoped connector the customer points at the exact place model
ids live: a Postgres/Mongo/Dynamo column, a LaunchDarkly/Statsig flag, an SSM/Vault
param. Sees **per-tenant fan-out** ("1,240 tenants on gpt-3.5-turbo-0301, retires
<date>") — a number no other tool can produce. Forks output: config-as-code → PR;
live-only store → a read-only config-change proposal + deadline alert. Security
gate: prod-store access (mitigate with a read replica / CSV export). Gives the
reserved `dynamic_model_value` tier reason a real home.

**4. Runtime SDK / OTel instrumentation** *(high effort, unlocks the premium product)*
— an in-process shim or (preferred) a read-only OTel GenAI-semconv span consumer
that captures the **resolved** model id *and its full request shape* (tools,
vision, json, stream, reasoning, max_tokens, endpoint) at call time. This is the
**missing input to the recommend engine**: it's a third requirement source next
to the TS extractor and the all-unknown Python fallback, so a config-driven call
whose requirements are today all `unknown` becomes fully *decided* — flipping
`alternativesQualified` from false to true and turning a forced REVIEW into a
qualified, eval-gated recommendation. Facts, not payloads (open-source the shim so
content-capture code is physically absent). Still needs a source locator for the
PR half.

**3. LLM gateway / proxy** *(high effort, ground truth + closed loop)* — read only
the wire `model` field (drop the body) through the customer's existing gateway
(LiteLLM/Portkey/Cloudflare) out-of-band, or a fail-open sidecar. Ground truth of
what runs in prod, per env, per volume, including runtime-assembled ids — and it
**auto-confirms the old model decays to zero after a fix merges** (closed-loop
verification no static tool can do). Needs a locate bridge to produce PRs. Real
objection is critical-path/latency/SPOF, not PII. Crowded market — be the
deprecation-intelligence layer *on top* of a gateway, never the gateway.

## Recommended sequence (for the audit-first GTM)

1. **Provider usage API (#5) first.** Low effort, zero-touch, and the perfect
   audit opener: "give me a read-only key, I'll show your deprecated-model exposure
   in dollars by tomorrow." Answers "can you even measure my exposure?" with **yes**
   for the exact target customers, with no infra approval. It's the wedge, and it
   surfaces cost regressions they didn't know they had.
2. **Static config / IaC scan (#1) second.** Cheapest LOCATE, reuses everything,
   converts the config-in-repo slice, and builds the reader-tie-back locate
   primitive the harder shapes need.
3. **Then let the audits decide the target-segment pair.** The audit's first
   question — *where do your model ids actually live* — is go/no-go and picks the
   shape: if a **DB/flag**, build config-store readers (#2, the LOCATE for the
   segment); if they want the **eval-gated migration** (the premium product), build
   runtime/OTel (#4, the MEASURE that feeds recommend). #4 is the higher-ceiling
   bet — it's the only shape that makes the recommend/eval engine work for
   config-driven code.
4. **Gateway (#3) only if a design partner already runs one** — then it's a cheap
   callback plugin with a closed-loop verification bonus; otherwise the
   critical-path trust cost isn't worth it early.

## The honest caveat

The MEASURE shapes (3, 4, 5) will tempt an "and mendr fixes it automatically"
pitch. For the runtime/config-driven buyers, the fix is not automatic until a
LOCATE half (config scan or config-store reader) is deployed alongside. What
these shapes reliably deliver on day one is the **exposure measurement and the
recommendation/receipt** — which is already more than any of these customers can
get today, since their number is currently zero.
