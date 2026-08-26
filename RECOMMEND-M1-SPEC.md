# `mendr recommend` — M1 technical specification

Status: locked for implementation. Scope: M1 (compatibility shortlist) for
OpenAI, Anthropic and Google Gemini only. Branch: `recommend-engine`. Target
release: `v0.2.0`. This spec is written against the real Mendr codebase, not an
idealized one — every "reuse" below names an existing symbol, and every
non-regression rule names a contract that must not move.

## 0. The ladder this rung sits in

- `fix-llm` — official one-to-one successor, deterministic code gates, Tier A, verified.
- `recommend` — **this spec.** Compatibility shortlist, no implicit ranking, report-only, writes nothing.
- `recommend --draft-pr` — policy-selected migration proposal, no semantic eval, marked REVIEW REQUIRED. (M2)
- `recommend --evaluate` — full migrations, isolated execution, repeated assertion-based eval, scoped verification. (M4)

PR always inspectable. Merge always human. No LLM judgement authorizes a change.
Verification claims only the dimensions actually measured.

## 1. Module layout

New (all under the `recommend-engine` branch):

| Path | Role |
|---|---|
| `registries/llm-active-models.json` | The active-model catalog data asset. Bare JSON array, camelCase, its own entry shape. |
| `src/recommend/catalog.ts` | Catalog loader + integrity validator. Mirrors the `registry/candidates.ts` second-registry pattern; reuses `resolveRegistryAsset`. |
| `src/recommend/activeEntryId.ts` | `activeEntryIdFor()` — the derived, unique id formula for a catalog entry. |
| `src/recommend/requirements.ts` | The tri-state requirement extractor (TS + Python). Its own object-literal walk. |
| `src/recommend/filter.ts` | Candidate generation + the tri-state compatibility filter. Pure. |
| `src/recommend/receipt.ts` | Assembles `RecommendationReceipt` objects. Pure. |
| `src/report/recommend.ts` | Human renderer (`string[]`) + the `--json` projector. |

Reused verbatim (imported, never forked):

- Scan scope: `buildRegistryPrefilter`, `loadPrefilteredProject`, `collectTsSourceFiles`, `countAnalyzableSourceFiles`, `isTestPath` (`src/usage/scanRepo.ts`, `src/usage/scanLiterals.ts`). Directory exclusion (`SCAN_EXCLUDED_DIRS`) is module-private in `scanRepo.ts` and already applied inside `collectTsSourceFiles`/`loadPrefilteredProject`; recommend inherits it and does not import it.
- Occurrence discovery: `findModelIdLiterals` (TS, exported from `src/usage/scanLiterals.ts`), `findPyModelIdLiterals` (Python, exported from `src/python/scanPy.ts`), and the `scanForExposure` pipeline (`src/watch/exposure.ts`, which itself imports the two finders).
- Tier vocabulary: `Tier` and `TIER_PRECEDENCE` from `src/report/tiers.js`. The one parallel `Tier` declaration to avoid is in `types.ts` (`export type Tier = 'A'|'B'|'C'`); import from `tiers.js` and add no third declaration. (`report/tier.ts` is a dead `classifyTier` stub that *imports* `Tier` — not a third declaration, safe to ignore.)
- The one classifier: `classifyOccurrenceTier` (`src/report/classifyOccurrence.ts`).
- The one gate: `isVerified`, plus `effectiveVerificationState`, `displayEntryId`, `entryIdFor`, `loadLlmRegistry`, `resolveRegistryAsset` (`src/usage/llmRegistry.ts`, `src/registry/entryId.ts`).

Extracted, then reused (a real, behavior-preserving refactor — not "reused verbatim"):

- The repo-target helpers `isRemoteRepoUrl`, `cloneRemoteOrExit`, `resolveRepoOrExit`, `assertAnalyzable` are currently **module-private** in `src/cli.ts` (`cli.ts` has zero top-level exports; nothing imports from it). M1 hoists them into an exported module (`src/cli/repoTarget.ts`) and re-points fix-llm/watch at it — a diff to `cli.ts`, pinned byte-identical by the non-regression golden test (§8 #10).
- `say()` and `rel()` are **per-action closures** inside the fix-llm action body (they capture that action's `json` / `resolved` locals), so they cannot be imported. Recommend re-declares its own `say()` / `rel()` in its own action — deliberate re-declaration, not sharing.

All intra-`src` imports use explicit `.js` specifiers (NodeNext, `"type":"module"`, node >= 22). Recommend exits via `process.exitCode` (never `process.exit` after output), matching fix-llm/watch.

## 2. The six contracts

```ts
// ── shared provenance wrapper ──────────────────────────────────────────────
/** Every catalog fact carries where it came from and when it was checked. */
export interface Provenanced<T> {
  value: T;
  source: string;      // URL or oracle id the fact was read from (non-empty)
  checkedAt: string;   // ISO YYYY-MM-DD, string-comparable (matches registry dates)
}

export type EndpointFamily =
  | 'chat_completions'   // OpenAI classic
  | 'responses'          // OpenAI responses API
  | 'messages'           // Anthropic
  | 'gemini_generate';   // Google

// ── 1. ActiveModel ─────────────────────────────────────────────────────────
// A live model in the catalog. NOT a clone of LlmModelIdDeprecation: no
// `deprecated`, no `replacement`, no auto-apply switch. Its trust is provenance
// per field, not a four-field safety gate.
export interface ActiveModel {
  entryId: string;                                  // DERIVED: `${provider}.${modelId}.active`, unique, re-derived by the validator
  provider: 'openai' | 'anthropic' | 'google';      // M1 scope
  modelId: string;                                  // the live id, exact
  lifecycle: 'active' | 'preview';                  // NOT named `status` (collides with two other status spaces)
  capabilities: {
    tools:          Provenanced<boolean>;
    jsonStrict:     Provenanced<boolean>;
    streaming:      Provenanced<boolean>;
    vision:         Provenanced<boolean>;
    reasoning:      Provenanced<boolean>;
    contextTokens:  Provenanced<number>;
    maxOutputTokens:Provenanced<number>;
  };
  endpoint: Provenanced<EndpointFamily>;
  price: {
    inputPerMTok:  Provenanced<number>;
    outputPerMTok: Provenanced<number>;
    currency: 'USD';
  };
  // Carried as DATA in M1; the live probe is M2. Never asserts customer availability.
  availability: {
    regions:               Provenanced<string[]> | { value: 'unknown' };
    requiresPreviewAccess: Provenanced<boolean>;
    minAccountTier:        Provenanced<string | null>;
  };
}

// ── 2. ExtractedRequirement ────────────────────────────────────────────────
export type RequirementState = 'required' | 'not_observed' | 'unknown';

export type RequirementKey =
  | 'tools' | 'vision' | 'jsonStrict' | 'streaming'
  | 'reasoning' | 'minOutputTokens' | 'endpoint';

export interface ExtractedRequirement {
  key: RequirementKey;
  state: RequirementState;
  evidence: string | null;          // "file:line — what was seen"; null when not_observed
  min?: number;                     // minOutputTokens only: the floor read from max_tokens/max_completion_tokens
  endpointFamily?: EndpointFamily;  // endpoint only: the family read from baseURL/SDK
}

// ── 3. CandidateDecision ───────────────────────────────────────────────────
export type CandidateOrigin = 'official_successor' | 'compatible_alternative';

export interface CapabilityCheck {
  key: RequirementKey;
  requirement: RequirementState;                     // what the code proved
  catalogValue: boolean | number | string | 'unknown'; // what the catalog declares (`unknown` = no provenance)
  result: 'satisfied' | 'unsatisfied' | 'not_applicable' | 'indeterminate';
}

export interface CandidateDecision {
  modelId: string;
  origin: CandidateOrigin;
  kept: boolean;
  checks: CapabilityCheck[];             // one per requirement considered
  eliminatedBy: RequirementKey | null;   // the FIRST required capability it failed; null when kept
  eliminationDetail: string | null;      // machine+human, e.g. "vision required; catalog gpt-x vision=false (src, 2026-08-20)"
  inCatalog: boolean;                    // false for a registry successor the catalog does not yet cover
  registryVerdict: string | null;        // official successor only: the registry verdict for the dead→replacement mapping
}

// ── 4. Authorization ───────────────────────────────────────────────────────
export type AuthorizationType =
  | 'official_successor'   // provider's documented 1:1 mapping
  | 'compatibility_only'   // M1
  | 'customer_eval'        // M4
  | 'human_selected';      // a human chose from the shortlist

export interface Authorization {
  type: AuthorizationType;
  policy?: string;            // customer_eval only (M4)
  evalRuns?: number;          // customer_eval only (M4)
  passedCandidates?: number;  // customer_eval only (M4)
}

// ── 5. VerificationScope ───────────────────────────────────────────────────
// Renamed from the sketched `VerificationStatus`: types.ts already exports
// VerificationStatus = 'verified'|'quarantined'|'unverified'|'unverifiable'.
// Two value-spaces under one imported name is the collision to avoid.
//
// The four values are NORMATIVE, not decorative:
//   passed         = the dimension was measured this rung and met its bar.
//   failed         = the dimension was measured this rung and did not.
//   not_evaluated  = this rung does not measure this dimension AT ALL (out of scope).
//   unknown        = the dimension IS in scope this rung but the input was
//                    indeterminate (e.g. a required capability whose catalog
//                    field has no provenance).
// `not_evaluated` and `unknown` are not interchangeable: one means "we never
// look here yet", the other means "we looked and could not tell".
export type VerificationOutcome = 'passed' | 'failed' | 'not_evaluated' | 'unknown';

export interface VerificationScope {
  providerStatus:  VerificationOutcome;  // model is active in the catalog (cross-checked not-deprecated)
  availability:    VerificationOutcome;  // available to THIS customer's credentials — M2 probe
  code:            VerificationOutcome;  // patched code compiles + tests pass — M2/M4
  capabilities:    VerificationOutcome;  // catalog DECLARES the required capabilities
  toolBehavior:    VerificationOutcome;  // model actually emits the required tool call — M4
  outputSchema:    VerificationOutcome;  // output valid against schema — M4
  cost:            VerificationOutcome;  // measured cost under ceiling — M4
  latency:         VerificationOutcome;  // measured latency under budget — M4
  semanticQuality: VerificationOutcome;  // customer assertion-based eval — M4
}

// M1 population rule (NORMATIVE — receipt.ts MUST follow it, §8 test #11 enforces it):
//   providerStatus : 'passed' when a CATALOG-backed kept candidate is recommended;
//                    'unknown' when the only kept candidate is a registry successor
//                    the catalog does not yet cover; 'failed' when the kept set is empty.
//   capabilities   : 'failed'  iff the kept set is empty, OR a surfaced official
//                              successor provably lacks a `required` capability.
//                    'unknown' iff a requirement was `unknown` (nothing proven — e.g.
//                              a Python call), OR a `required` check hit missing catalog
//                              provenance. (An unknown requirement can NOT read 'passed'.)
//                    'passed'  iff there is >= 1 kept candidate, every `required` check is
//                              'satisfied', and NO requirement is `unknown`.
//   availability, code, toolBehavior, outputSchema, cost, latency, semanticQuality
//                  : MUST be 'not_evaluated' in every M1 receipt. M1 measures none
//                    of them, so none of them may ever read 'passed' this rung.

// ── 6. RecommendationReceipt ───────────────────────────────────────────────
// A separate view type. NOT an extension of ExposedModel (that would rewrite
// every repo's committed .mendr/exposure.json and force a schema bump).
export interface RecommendationReceipt {
  deprecated: string;                        // the dead model id found in the repo
  entryId: string;                           // displayEntryId of the matched deprecation entry (shared identity)
  provider: string;
  candidateProvider: 'openai' | 'anthropic' | 'google'; // where candidates were drawn from (--provider or same-as-dead)
  occurrences: number;                       // physical call sites, deduped by node
  requirements: ExtractedRequirement[];      // the tri-state profile
  reviewFlag: boolean;                       // true if any requirement is `unknown` OR any kept check is indeterminate
  authorization: Authorization;              // M1: { type: 'compatibility_only' }
  verification: VerificationScope;           // dimension-scoped, honest ceiling
  officialSuccessors: CandidateDecision[];   // kept, origin === 'official_successor'
  compatibleAlternatives: CandidateDecision[]; // kept, origin === 'compatible_alternative'
  rejected: CandidateDecision[];             // kept === false, both origins
  sortedBy: 'cost' | 'context' | null;       // null = no ordering applied (the default)
  deadlineDays: number | null;               // the dead model's nearest shutdown deadline in days (null undated); also the receipt sort key
}
```

## 3. The active-model catalog

### 3.1 Data file
`registries/llm-active-models.json` — a top-level JSON array of `ActiveModel`,
matching the deprecation registry's on-disk conventions: bare array (no wrapper,
no `$schema`), camelCase keys, ISO `YYYY-MM-DD` dates, 2-space indent + trailing
newline. M1 seeds the current active OpenAI, Anthropic and Gemini models.

### 3.2 Loader + validator (its own pair, not `loadLlmRegistry`)
`assertDeprecation` hard-codes `VALID_KINDS = {model_id, param_rename, param_removal}`,
so the catalog cannot route through the deprecation loader. `src/recommend/catalog.ts`
mirrors the `registry/candidates.ts` pattern instead:
- `loadActiveModels(explicitPath?)` → `resolveRegistryAsset('registries/llm-active-models.json')` (the same walk-up resolver, works under `src/` via tsx and `dist/` via built js), `JSON.parse`, assert array, per-entry shape guard.
- Fail-closed, hard-error posture copied from `parseVerification`/`parseSwitch`: a present-but-malformed entry throws at load; it is never half-read as trusted.

`validateActiveModels(catalog)` is the integrity validator (the `validateRegistry`
role, pure, offline, returns all violations). Invariants → machine codes:

| Code | Rule |
|---|---|
| `missing_field_source` | any **provenanced** capability / endpoint / price / availability field lacks a non-empty `source`. The `availability.regions` `{ value: 'unknown' }` sentinel is exempt — it is the sanctioned no-provenance escape hatch, mirroring `catalogValue: 'unknown'`; the other availability fields (`requiresPreviewAccess`, `minAccountTier`) are always provenanced and checked |
| `missing_field_checked_at` | any such provenanced field lacks a valid ISO `checkedAt` (same `regions: { value: 'unknown' }` exemption) |
| `invalid_lifecycle` | `lifecycle` not in `{active, preview}` |
| `missing_entry_id` / `entry_id_mismatch` / `duplicate_entry_id` | id absent / ≠ `activeEntryIdFor()` / not unique |
| `active_id_is_deprecated` | `modelId` appears as a `deprecated` id in `llm-deprecations.json` (cross-registry check — the catalog may never recommend a model the deprecation registry says is dying) |

`activeEntryIdFor(entry)` = `` `${entry.provider}.${entry.modelId}.active` ``.

### 3.3 CI
The deprecation registry is validated only weekly (`registry-verify.yml`, cron).
The active-model catalog is load-bearing for every `recommend` run, so its
integrity check runs on **push/PR**, not weekly: add a `node scripts/validate-active-models.mjs`
step (built from `dist/`, same shape as `scripts/validate-registry.mjs`) to a
push-triggered workflow. Freshness (staleness of `checkedAt`) is a separate,
later online audit.

## 4. Requirement extraction rules (tri-state)

Greenfield within the analyzer. Extraction runs on its own object-literal walk
(the `findParamSites` walk at `paramFix.ts` is registry-gated and skips
unresolved models, so it cannot be reused unchanged).

**Python in M1 (as built):** TypeScript occurrences get full extraction over the
live ts-morph node. Python `model_arg` occurrences are surfaced with **all
requirements `unknown`** — honest ("we found the call but do not yet analyze its
options"), so a Python usage flags for review rather than being mis-analyzed.
This is spec-conformant (`unknown` is the safe default) and defers the tree-sitter
requirement walk (during `findPyModelIdLiterals`, while the tree is alive, like
`collectPySinkNames`) to a follow-up within M1.

For a call site whose `model` resolves to a matched dead id:

| Signal → `RequirementKey` | Promotes to `required` when | Else |
|---|---|---|
| `tools` | a `tools`/`tools=[...]` array is passed on the options object | `not_observed` |
| `vision` | an image content block is constructed (`image_url` / `type:'image'` / provider image part) | `not_observed` |
| `jsonStrict` | `response_format`/`responseSchema`/strict-JSON mode is set | `not_observed` |
| `streaming` | `stream: true` is set | `not_observed` |
| `reasoning` | a `reasoning_effort`/`reasoning` param is passed | `not_observed` |
| `minOutputTokens` | `max_tokens`/`max_completion_tokens` is set (`min` = the literal number when statically resolvable) | `not_observed` |
| `endpoint` | the endpoint **family** resolves from the call — the SDK method/namespace (`responses.create` vs `chat.completions.create` vs `messages.create` vs the Gemini call), NOT the host in a `baseURL` — with `endpointFamily` = that resolved family | `not_observed` |

**The `unknown` rule (accuracy over recall):** a requirement is `unknown`, not
`not_observed`, whenever the call cannot be fully resolved — the `model` does not
resolve to a compile-time string, the options object is a spread (`{...opts}`),
the value is assembled dynamically (env var, concatenation), a
`max_tokens`/`max_completion_tokens` number is present but not statically
resolvable, or an endpoint is visible but does not resolve to one of the four
`EndpointFamily` values. `unknown` is the default on uncertainty; an optimistic
`required`/`not_observed` on a partially-visible call is a spec violation. A
requirement is `required` with a concrete `min`/`endpointFamily` only when that
value is actually resolved.

The requirement tri-state is a **recommend-only axis, orthogonal to A/B/C
tiering.** It does not pass through `classifyOccurrenceTier` and does not emit
the reserved `insufficient_dataflow`/`dynamic_model_value` `TierBReason` codes.
Recommend still reads the existing tier/exposure to report whether a dead model
is already auto-fixable, but its requirement axis never mutates the shared
classifier.

## 5. Candidate generation + filter rules

**Candidate source.** `--provider <p>` selects which provider's catalog to draw
from; with no flag, candidates come from the dead model's own provider
(same-provider-first).
- The official successor is the deprecation entry's `replacement` (the same target
  fix-llm/watch use), and exists **only** when the candidate provider equals the
  dead model's provider. It is read from the registry, never inferred from the
  catalog, and is **always surfaced — never capability-eliminated** — even when the
  active-model catalog does not yet cover it. When the catalog lacks it, its
  `CapabilityCheck`s are all `indeterminate`, `inCatalog` is `false`, and
  `registryVerdict` carries the mapping's verification state; this is what makes
  recommend AGREE with watch instead of silently dropping the verified successor.
  (Real-repo testing showed the old catalog-intersection behavior dropped every
  registry successor and recommended an older/wrong-tier model in its place.)
- Compatible alternatives are the other active `ActiveModel` entries for the
  candidate provider; unlike the official successor, they ARE eliminated when a
  `required` capability is unsatisfied.
- Cross-provider (`--provider` ≠ the dead model's provider) yields
  `officialSuccessors: []` and everything as `compatible_alternative` — there is
  no provider-documented cross-provider 1:1, and the receipt says so.

**The filter — only `required` ever eliminates.** For each requirement, per candidate:

| Requirement state | Catalog declares capability | `CapabilityCheck.result` | Eliminates? |
|---|---|---|---|
| `required` | yes (truthy / ≥ min / family matches) | `satisfied` | no |
| `required` | no | `unsatisfied` | **yes** — first one sets `eliminatedBy` |
| `required` | field has no provenance (`catalogValue: 'unknown'`) | `indeterminate` | no — sets `reviewFlag` if the candidate is kept (see the reviewFlag rule below) |
| `not_observed` | — | `not_applicable` | **never** (permissive) |
| `unknown` | — | `indeterminate` | **never** — sets `reviewFlag` |

`minOutputTokens` required with `min = N`: `satisfied` iff the catalog carries a
**provenanced** `maxOutputTokens ≥ N`; `unsatisfied` iff a provenanced value is
`< N`; `indeterminate` (never eliminates, sets `reviewFlag`) iff the catalog
`maxOutputTokens` has no provenance (`catalogValue: 'unknown'`). `endpoint`
required with `endpointFamily = F`: `satisfied` iff the catalog carries a
provenanced `endpoint === F`; `unsatisfied` iff a provenanced family differs (an
endpoint change is a migration M1 does not author, so a genuine mismatch
eliminates); `indeterminate` iff the catalog endpoint has no provenance. Neither
rule may eliminate a candidate when its catalog operand is unprovenanced — a bare
numeric/enum comparison never decides elimination against missing data.

**`reviewFlag` (one definition, receipt-level, authoritative).** `reviewFlag` is
`true` iff (any `ExtractedRequirement.state === 'unknown'`) OR (any
`CapabilityCheck` on a **kept** candidate has `result: 'indeterminate'`). It is
scoped to kept candidates deliberately: elimination requires a solid
`unsatisfied` (a `required` capability with a provenanced failing value), and
`indeterminate` never eliminates, so every `rejected` candidate already has a
sound, fully-provenanced reason regardless of any indeterminate check it also
carries — those do not raise review. This is the single authority; §2, §6.1 and
§8 point at it and never restate it differently.

**Ordering.** No preference by default. Kept candidates are presented in a
neutral canonical order — ascending `modelId`, computed at render time and
independent of the catalog file's line order, so a maintainer cannot smuggle a
recommendation by authoring the JSON best-first; `sortedBy` is `null` (a
canonical id sort carries no quality signal). `--sort cost|context` is the only
preference-bearing reordering, an explicit user act, recorded in `sortedBy`. The
`officialSuccessors` / `compatibleAlternatives` split is a **provenance**
grouping (provider-documented successor vs merely-compatible), not a quality
order, and the same ascending-`modelId` order applies within each group.
Ordering the **receipts** (dead models) by nearest deadline is allowed — that is
an exposure property, reused from watch's risk-first sort, not a candidate
preference.

**Empty kept set** is a first-class result: `officialSuccessors` and
`compatibleAlternatives` both `[]`, every candidate in `rejected` with its
`eliminatedBy`. The renderer says "no in-provider model meets your required
capabilities" and lists what each was missing.

## 6. Output

### 6.1 Human (`recommend`)
Renderer returns `string[]` (like `formatFoundLines`), fed through `say()`.
Per receipt: the dead id + occurrence count; the requirement profile (only
`required` and `unknown` lines shown, `not_observed` suppressed); a REVIEW
warning line when `reviewFlag`; official successors and compatible alternatives
as separate labeled groups; rejected candidates with one-line reasons. When
`reviewFlag` is set the warning names both sources present: the `unknown`
requirements, and the `required` capabilities of kept candidates whose catalog
value is indeterminate (no provenance). When the flag is set purely by the
latter — zero `unknown` requirements — the warning still fires and names those
capabilities.

After the receipts, the renderer prints a **Review required** section (each
`usage_unverified` / `azure_deployment` finding with its file:line and why no
requirements could be extracted) and an **Informational** section (a count of
deprecated ids in data positions, grouped by id). When there are no live calls
it opens with "No live deprecated-model calls found." and closes with "No
compatibility shortlist was generated." — so a repo with deprecated ids in
non-live positions never reads as clean.

### 6.2 `recommend --json` (one stable shape)
stdout is reserved exclusively for the document (`console.log(JSON.stringify(obj, null, 2))`);
all warnings/progress go to `console.error`; exit via `process.exitCode`.
Nullable scalars are always present as `value ?? null`. There is **one** shape —
an empty scan yields empty buckets, not a reduced variant (fix-llm's two-shape
split is a known footgun this contract avoids). Recommend reports THREE buckets
so it never hides what watch/fix-llm found: `recommendations` (live calls with a
shortlist), `reviewRequired` (found but usage unverifiable — a Python
usage-unverified assignment or an azure deployment alias), and `informational`
(deprecated ids in data positions). `status` + `reason` explain WHY a result is
empty rather than reading as a clean repo.

```ts
export interface RecommendJson {
  schema: 'mendr-recommend/v1';
  status: 'recommendations' | 'no_shortlist' | 'no_live_calls' | 'clean';
  reason: string;             // one-line human explanation of the status
  registryVersion: string;    // content hash of llm-deprecations.json (reuse fix-llm/watch convention)
  catalogVersion: string;     // content hash of llm-active-models.json
  scannedCommit: string | null;
  providerFilter: string | null;  // the --provider filter (a repo may use many providers, so this is a FILTER)
  providersFound: string[];       // distinct providers with any deprecated usage found
  sortedBy: 'cost' | 'context' | null;
  hasRecommendations: boolean;
  findings: {
    liveDeprecatedCalls: number;  // model_arg occurrences that produced receipts
    usageUnverified: number;      // usage-unverified review occurrences
    informational: number;        // data-position occurrences
  };
  reviewFlagged: number;      // receipts with reviewFlag === true
  filesScanned: number;
  filesMatched: number;
  recommendations: RecommendationReceipt[];  // ordered by nearest deadline, never by candidate quality
  reviewRequired: ReviewFinding[];           // deprecated ids found but not a verified live call
  informational: InformationalGroup[];       // deprecated ids in data positions, grouped by id
}
```

`recommend` reuses the SAME classified occurrences as watch/fix-llm: every
`model_arg` becomes a `recommendations` receipt, every `usage_unverified` /
`azure_deployment` becomes a `reviewRequired` finding, and every `data` position
becomes an `informational` entry. It never says "nothing to recommend" while a
finding exists.

`recommend` writes nothing to the working tree and creates no `.mendr` file in
M1 (locate/classify-only, like the scan path of fix-llm and watch). If a later
rung persists a recommend artifact, it uses a distinct schema tag and the
churn-free serializer discipline (2-space JSON, trailing newline, no timestamp).

## 7. Non-regression invariants (what recommend must not touch)

1. Do not extend `classifyLiteral` / `LiteralPosition` / `MODEL_FACTORIES` / `isModelLikeName` / `isAzureDeploymentName` to "match more" — these decide what fix-llm swaps and what watch classifies; widening or narrowing regresses both paths at once. Recommend consumes their output; it never loosens their matching.
2. Do not edit `isVerified` or `parseSwitch`. Any "already auto-fixable" claim recommend makes calls `isVerified` (the full four-field conjunction), reads structured fields only, never prose.
3. Do not add a field to `ExposedModel` or change `EXPOSURE_SCHEMA` / `serializeExposure`. Recommend emits `RecommendationReceipt`, a separate type.
4. Do not modify `classifyOccurrenceTier`, `tierBJson`, `TIER_PRECEDENCE`, `displayEntryId` / `entryIdFor`, or `scanRepo` scope. Import `Tier` from `report/tiers.js`; add no third `Tier` declaration.
5. Compose `scanForExposure` / `findModelIdLiterals` / `findPyModelIdLiterals`; do not re-walk the repo with a private scanner (that reintroduces the exact classifier drift the codebase eliminated).
6. `recommend` never writes from the scan/classify path.

## 8. Acceptance tests (one per M1 completion criterion)

Each maps to a line in the locked M1 completion checklist. Fixtures are hand-built,
pure-function tests in the style of `verifyGate.test.ts`.

| # | Criterion | Test |
|---|---|---|
| 1 | Every catalog field has a source and date | `validateActiveModels` emits `missing_field_source` / `missing_field_checked_at` for an entry whose capability lacks either; a well-formed entry — including one using the `availability.regions: { value: 'unknown' }` sentinel — yields zero violations. |
| 2 | Successors vs alternatives stay separate | A dead id whose registry `replacement` is an active same-provider model puts that model in `officialSuccessors`; a different compatible active model lands in `compatibleAlternatives`; the two arrays never share a `modelId`. |
| 3 | Requirements are tri-state | A call passing `tools` → `tools: required`; a fully-visible call without tools → `tools: not_observed`; a call whose model id is read from an env var → every requirement `unknown`. |
| 4 | Only `required` eliminates | A `not_observed` capability removes no candidate; an `unknown` requirement removes no candidate; only a `required`-and-`unsatisfied` capability sets `kept: false`. |
| 5 | Important `unknown` warns | A receipt with any `unknown` requirement has `reviewFlag: true` and the human warning names the unknown keys. A second fixture with **zero** `unknown` requirements but a kept candidate whose `required` capability is `indeterminate` (unprovenanced catalog value) also has `reviewFlag: true`, and the warning names that capability. `--json` `reviewFlagged` counts both. |
| 6 | No ranking without policy/`--sort` | Default candidate order equals stable catalog order and `sortedBy: null`; `--sort cost` reorders and sets `sortedBy: 'cost'`. |
| 7 | Every eliminated candidate has a machine reason | Each `rejected` entry has a non-null `eliminatedBy` (`RequirementKey`) and a non-null `eliminationDetail`. |
| 8 | `recommend` writes nothing | After a run over a fixture, `git status` is clean and no `.mendr/` file was created; no fs write occurs on the scan path. |
| 9 | Stable `--json` contract | Snapshot of the envelope keys; an empty scan and a non-empty scan share the identical top-level shape (`models: []` on empty). |
| 10 | fix-llm and Watch unchanged | Golden test importing `isVerified`, `classifyOccurrenceTier`, `tierBJson`, `ExposedModel`, `serializeExposure`: their outputs are byte-identical on fixtures with recommend present; a structural assertion that `ExposedModel` gained no field and `EXPOSURE_SCHEMA` is still `mendr-exposure/v2`; and that hoisting the repo-target helpers into `src/cli/repoTarget.ts` leaves fix-llm/watch output unchanged. |
| 11 | VerificationScope is honest | Over a fixture, every M1 receipt's `verification` has `availability`, `code`, `toolBehavior`, `outputSchema`, `cost`, `latency`, `semanticQuality` all `'not_evaluated'`; `providerStatus` in `{passed, failed}`; `capabilities` is `'passed'` only when every required check on kept candidates is `satisfied`, `'unknown'` when any is `indeterminate`, `'failed'` when the kept set is empty. No dimension M1 does not measure ever reads `'passed'`. |
| 12 | Cross-registry + identity validator codes | `validateActiveModels` emits `active_id_is_deprecated` for a catalog `modelId` that also appears as a `deprecated` id in `llm-deprecations.json`; `entry_id_mismatch` / `duplicate_entry_id` for a wrong or repeated id; `invalid_lifecycle` for a `lifecycle` outside `{active, preview}`. |
| 13 | Cross-provider sourcing | `recommend . --provider anthropic` on a dead OpenAI id yields `officialSuccessors: []` and every kept candidate `origin === 'compatible_alternative'`. |
| 14 | Empty kept set is first-class | A fixture where every candidate fails a required capability yields `officialSuccessors: []` and `compatibleAlternatives: []`, every candidate in `rejected` with a non-null `eliminatedBy`, and a clean exit that renders the "no in-provider model meets your required capabilities" line. |

Plus a structural guard: recommend adds no second `Tier` declaration and imports
`Tier`/`TIER_PRECEDENCE` from `report/tiers.js`.

## 9. Workstreams, branches, releases

Two branches, never mixed — so a false positive is attributable to the selection
engine or to new provider evidence, never ambiguously both:
- `recommend-engine` — M1 → M4 (this spec is M1).
- `provider-expansion` — Mistral, Cohere, Groq, xAI, Together AI (Watch/registry coverage; not this branch).

Release sequence:
1. `v0.2.0` — M1 compatibility shortlist, OpenAI/Anthropic/Gemini (this spec).
2. `v0.3.0` — five-provider Watch coverage (`provider-expansion`).
3. `v0.4.0` — policy + review-required draft PRs (M2).
4. Later — eval scaffolding + verified selection (M3/M4).

## 10. Open input (owner: you, not the spec)

The active-model catalog is a maintained data asset and `recommend` is only as
correct as its freshness. Before building M1, decide who refreshes it and how
often — the same cadence question the deprecation registry already answers. The
push/PR integrity check in §3.3 guards structure, not staleness; staleness is a
later online audit and a human commitment.

Catalog coverage note: the official successor is always surfaced from the
registry, but until the catalog covers the replacement id its capabilities can't
be verified — it shows with `inCatalog: false`, its `registryVerdict`, and a
"capability data unavailable" note, and `providerStatus` reads `unknown`. Keeping
the catalog's coverage in step with the deprecation registry's replacements (so
successors are capability-checked, not just named) is part of the same
maintenance commitment above. Real-repo testing (12 public repos) showed this is
the single highest-value catalog investment: without it, every recommendation
leads with an unverifiable successor.
