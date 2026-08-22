// Core shared interfaces used across Mendr modules.

/** A single detected breaking change in a Stripe API spec. */
export interface ApiChange {
  kind: 'field_rename' | 'field_removed' | 'type_change' | 'enum_value_change';
  path: string;
  from?: string;
  to?: string;
}

/** A collection of API changes between two spec snapshots. */
export type ChangeSet = ApiChange[];

/** A location in a source file where an API surface is used. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Maps a Stripe API path/field to the source locations that use it. */
export type UsageMap = Record<string, SourceLocation[]>;

/** A change intersected with the concrete source locations it affects. */
export interface AffectedSite {
  change: ApiChange;
  locations: SourceLocation[];
}

/**
 * Confidence tier for a finding.
 *
 * THREE classes, not two. `A` and `C` used to carry everything, which flattened
 * two very different things into one bucket: a KNOWN-deprecated id with a KNOWN
 * replacement whose usage context is uncertain (a human should look at it) read
 * the same as a model id sitting in a pricing table (nothing to do). `B` is
 * that middle class — actionable, but never auto-applied and never written.
 *   A = safe automatic patch (gated, applied by --write)
 *   B = potential migration requiring review (no patch is ever generated)
 *   C = informational data occurrence (no action)
 */
export type Tier = 'A' | 'B' | 'C';

/**
 * WHY a finding is Tier B rather than A or C — a machine-readable code, so a
 * consumer can route (or suppress) one class of review without regex-matching
 * English. Each code names the SPECIFIC missing proof, never a vague "unsure":
 *
 *   `usage_unverified`       a model-like assignment with no traced sink — the
 *                            value is a known dead id, but nothing proves it is
 *                            ever passed to a model call (Python sink rule).
 *   `replacement_unverified` a LIVE model argument whose registry replacement
 *                            did not clear the verification gate.
 *   `platform_blocked`       the position is a platform alias (an Azure
 *                            deployment name), so the fix is provisioning.
 *   `dynamic_model_value`    the model is assembled at runtime; no single
 *                            literal can carry the swap. RESERVED — no detector
 *                            emits this today.
 *   `insufficient_dataflow`  the value could not be traced to a definite use.
 *                            RESERVED — no detector emits this today.
 *   `type_cast_masked`       an `as` cast hides the repo's own model-id union,
 *                            so a raw string swap would bypass its type gate.
 *
 * CONSTRAINT: the two RESERVED codes exist in the union for future detectors
 * and must NOT be emitted until a real surface maps onto them — a fabricated
 * finding is worse than a missing one.
 */
export type TierBReason =
  | 'usage_unverified'
  | 'replacement_unverified'
  | 'platform_blocked'
  | 'dynamic_model_value'
  | 'insufficient_dataflow'
  | 'type_cast_masked';

// --- LLM-mode (Phase: fix-llm) --------------------------------------------
// Mendr's LLM mode targets a different failure surface than the Stripe mode:
// LLM breakages live in STRING LITERALS (`model: "gemini-2.0-flash"`) and call
// params, not typed object properties. A small hand-maintained registry drives
// detection instead of a spec diff.

// Mendr's LLM registry carries THREE distinct classes of breakage, and they do
// not share one flat shape. `model_id` is a value-driven string swap (no model
// coupling — the literal IS the model). The two param kinds are the opposite:
// they are MODEL-COUPLED — a `temperature`/`max_tokens` key is only wrong on a
// SPECIFIC set of models, so each param entry names the `on_models` it applies
// to and the fix resolves the model AT THE CALL SITE before touching anything.
// A discriminated union keeps each kind's fields honest at compile time.

/** The class of LLM breakage a registry entry describes. */
export type LlmDeprecationKind = 'model_id' | 'param_rename' | 'param_removal';

// --- Registry verification ------------------------------------------------
// A `model_id` replacement is only trustworthy enough to AUTO-APPLY once it has
// been checked against public model catalogs + the provider's recommendation
// table (see src/registry/). The verdict is stamped back onto the entry so the
// engine gate can auto-apply ONLY `verified` swaps.

/**
 * Trust verdict for a model-id replacement.
 *
 * `quarantined` is a REAL state in the data, not a runtime opinion about it.
 * Twelve entries used to ship stamped `verified` while their own recorded
 * reasoning said "do not auto-apply"; the engine held them back by regex, so
 * the FILE still lied to anyone who read it (or consumed it) without running
 * mendr. Quarantine moves that judgement into the registry itself, where a
 * reviewer, a diff, and a CI job can all see it.
 */
export type VerificationStatus = 'verified' | 'quarantined' | 'unverified' | 'unverifiable';

// --- Evidence -------------------------------------------------------------
// `sourceUrl` + `verification.reasons` is a CLAIM, not proof: nothing ties the
// claim to what the page actually said, and nothing survives the page being
// silently edited. An EvidenceRef closes that gap — it pins the document the
// claim was read from, when it was read, and the sentence that supports it, so
// a reviewer can judge an entry WITHOUT refetching (and can detect drift when
// they do refetch: an EDITED document yields a different hash, while a page
// that merely re-served itself with a fresh CSP nonce does not).

/** Longest excerpt an EvidenceRef may carry. A quote, not a copy of the page. */
export const EVIDENCE_EXCERPT_MAX_CHARS = 240;

/** One audited fetch: the document a registry claim was read from. */
export interface EvidenceRef {
  /** The exact URL fetched. */
  sourceUrl: string;
  /**
   * `sha256:<64 hex>` of the whole fetched document, NORMALIZED first
   * (src/registry/evidence.ts#normalizeForHash strips CSP nonces, script
   * bodies, SRI hashes and whitespace runs — the per-response noise that made
   * every refetch of an unchanged page look like drift). Always the whole
   * document, even when the stored snapshot was capped. Any comparison against
   * this value must normalize the same way.
   */
  contentHash: string;
  /** ISO timestamp of the fetch (from an injected clock, so runs are testable). */
  retrievedAt: string;
  /**
   * The short quoted sentence/row from the source that supports the claim, at
   * most {@link EVIDENCE_EXCERPT_MAX_CHARS} chars. This is what a reviewer
   * reads to answer "why do you believe this?" without leaving the terminal.
   */
  excerpt?: string;
}

/**
 * The stamped outcome of verifying a model-id replacement.
 *
 * THE SAFETY PATH READS FIELDS, NOT SENTENCES. This block used to carry one
 * `status` plus a free-text `reasons` array, and the engine decided
 * auto-applicability by regex-matching English inside `reasons` for phrases
 * like "do not auto-apply" / "status unknown". That made SAFETY BEHAVIOUR A
 * FUNCTION OF WORDING: rephrasing a caveat, or translating it, silently turned
 * a held-back entry into an auto-applied one. The four booleans below replace
 * that entirely — each names one thing that was (or was not) established, and
 * {@link VerificationInfo.autoApplyAllowed} is the single switch the engine
 * reads. See isVerified() in usage/llmRegistry.ts for the exact conjunction.
 */
export interface VerificationInfo {
  /** The stamped verdict. Only `verified` is even a candidate for Tier A. */
  status: VerificationStatus;
  /**
   * The PROVIDER'S OWN documentation confirms this deprecation — the entry
   * names a provider docs page AND records a lifecycle (`status`) or a
   * `shutdownDate` read from it. Conservative by construction: a mapping
   * sourced from a blog post, a changelog rumour, or nothing at all is false.
   */
  officialSourceConfirmed: boolean;
  /**
   * The replacement id is live and uncontradicted in the public catalogs — the
   * verdict classifyEntry() reached on its last run (see registry/verify.ts).
   * False for anything stale, chained, missing, or out-of-class.
   */
  replacementConfirmed: boolean;
  /**
   * THE SINGLE SWITCH THE ENGINE READS. False for every non-`verified` entry
   * and for anything whose other two proofs are not both true. A human may
   * also set it false on a `verified` entry to withhold auto-apply; nothing may
   * set it true on an entry that is not `verified` (the CI validator rejects
   * that combination outright).
   */
  autoApplyAllowed: boolean;
  /**
   * WHY this entry is quarantined, in one sentence — required (non-null) when
   * `status` is `quarantined`, and null otherwise. This is data the report and
   * `mendr evidence` print verbatim; it is NOT parsed, and no behaviour keys
   * off its wording.
   */
  quarantineReason: string | null;
  /** ISO date (YYYY-MM-DD) the check ran, for staleness of the verdict itself. */
  checkedAt?: string;
  /** Which oracles corroborated the check (e.g. `["openrouter","models.dev"]`). */
  sources?: string[];
  /**
   * Human-readable reasons behind the verdict — DOCUMENTATION ONLY.
   *
   * CONSTRAINT: this array is NEVER read by the safety path. The engine gate
   * looks at the four booleans above and nothing else. `reasons` exists so a
   * reviewer can read the working that produced those booleans, and so the CI
   * validator can LINT it (a caveat here over `autoApplyAllowed: true` is a
   * migration bug worth failing the build on) — but a reworded, deleted, or
   * translated reason can no longer change what mendr will auto-apply.
   */
  reasons?: string[];
}

/**
 * Lifecycle of the SOURCE model id, from the provider's own deprecation pages.
 * `retired` = calls fail today (fix now). `deprecated` = still live but the
 * provider has announced a shutdown (early-warning fix, see `shutdownDate`).
 */
export type ModelLifecycle = 'retired' | 'deprecated';

/**
 * A retired MODEL ID: a bare string literal to swap wholesale
 * (`"gemini-2.0-flash"` -> `"gemini-flash-latest"`). Not model-coupled — the
 * matched literal is itself the model.
 */
export interface LlmModelIdDeprecation {
  /**
   * Stable, human-typeable id for this registry record:
   * `<provider>.<deprecated>.retirement-<shutdownDate|undated>` (see
   * registry/entryId.ts). Findings print it and tell the reader to run
   * `mendr evidence <entryId>` — before it existed, every finding named a
   * command whose argument appeared nowhere on screen.
   *
   * Optional on the TYPE because a hand-authored or freshly-discovered entry
   * has not been stamped yet; the CI validator requires it (and requires it to
   * match the deterministic formula, and to be unique) on the shipped
   * registry. Derive it with entryIdFor() rather than reading this field when
   * you need an id unconditionally.
   */
  entryId?: string;
  /** The LLM provider, e.g. `"google"`, `"openai"`, `"anthropic"`. */
  provider: string;
  kind: 'model_id';
  /** The retired model-id token (an exact value to match). */
  deprecated: string;
  /** The model id to migrate to. */
  replacement: string;
  /**
   * Source-id lifecycle per the provider's deprecation docs. Absent = status
   * unknown (never claimed dead) — recall audits fill this in over time.
   */
  status?: ModelLifecycle;
  /** ISO date (YYYY-MM-DD) calls stop(ped) working, when the provider published one. */
  shutdownDate?: string;
  /** The provider documentation page this verdict was read from. */
  sourceUrl?: string;
  /** Optional human note explaining the deprecation. */
  note?: string;
  /**
   * The registry-verification verdict for `replacement`. The engine gate
   * auto-applies (Tier A) ONLY on the full four-field conjunction in
   * isVerified(); a missing block, any non-`verified` status, or any of the
   * three switches being false leaves the entry review-only.
   */
  verification?: VerificationInfo;
  /**
   * Audited provenance for this entry: the documents the claim was read from.
   * Absent means hand-seeded (a claim with no proof attached) — legal, and
   * exactly what `mendr evidence <id>` reports so the gap is visible rather
   * than assumed away. Never empty when present (the loader rejects `[]`).
   */
  evidence?: EvidenceRef[];
}

// --- Candidate entries (the human gate) -----------------------------------
// Research — an LLM run, a scheduled discovery job, a human reading a docs page
// — produces CANDIDATES. A candidate lives in `registries/candidates.json`,
// which the fix engine NEVER reads. Only `mendr candidates promote <id...>`,
// run by a person naming explicit ids, moves one into the active registry.
// Nothing automated may write a `verified` entry into the active registry.

/** Who proposed a candidate. Provenance for the reviewer, not a trust level. */
export type CandidateProposer = 'llm-research' | 'human' | 'discovery';

/**
 * A proposed registry entry awaiting human promotion.
 *
 * CONSTRAINT: candidates are `model_id` entries only. The promote gate is
 * classifyEntry(), which classifies a deprecated -> replacement model mapping
 * against public catalogs; the model-COUPLED param kinds have no such oracle,
 * so there is nothing a machine could gate them on and they stay hand-authored
 * directly in the active registry.
 */
export interface CandidateEntry extends LlmModelIdDeprecation {
  /** Stable id a human names on the promote command line (`provider:model`). */
  candidateId: string;
  proposedBy: CandidateProposer;
  /** ISO timestamp the candidate was proposed. */
  proposedAt: string;
}

/**
 * A MODEL-COUPLED request-parameter RENAME: on the models named in `on_models`,
 * the `param` key must be renamed to `replacement` (e.g. OpenAI reasoning models
 * require `max_tokens` -> `max_completion_tokens`). The SDK still types the old
 * key, so only a runtime registry + call-site model resolution catches it.
 */
export interface LlmParamRenameDeprecation {
  provider: string;
  kind: 'param_rename';
  /** The request-options key to rename (e.g. `"max_tokens"`). */
  param: string;
  /** The key to rename it to (e.g. `"max_completion_tokens"`). */
  replacement: string;
  /** Models this rename applies to; matched by {@link LlmRegistry} prefix rule. */
  on_models: string[];
  note?: string;
}

/**
 * A MODEL-COUPLED request-parameter REMOVAL: on the models named in `on_models`,
 * the `param` key must be DELETED from the request-options object (e.g. Anthropic
 * Opus 4.7+ returns HTTP 400 for `temperature`/`top_p`/`top_k`). The SDK types
 * still accept the key, so the compiler never warns — this is the flagship
 * "AST beats regex" case.
 */
export interface LlmParamRemovalDeprecation {
  provider: string;
  kind: 'param_removal';
  /** The request-options key to remove (e.g. `"temperature"`). */
  param: string;
  /** Models this removal applies to; matched by {@link LlmRegistry} prefix rule. */
  on_models: string[];
  note?: string;
}

/** Any param-transform entry (the two model-coupled kinds). */
export type LlmParamDeprecation = LlmParamRenameDeprecation | LlmParamRemovalDeprecation;

/** A single LLM API deprecation of any kind. */
export type LlmDeprecation =
  | LlmModelIdDeprecation
  | LlmParamRenameDeprecation
  | LlmParamRemovalDeprecation;

/** The parsed `registries/llm-deprecations.json` registry. */
export type LlmRegistry = LlmDeprecation[];
