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

/** Confidence tier for an auto-generated fix. */
export type Tier = 'A' | 'C';

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

/** Trust verdict for a model-id replacement. */
export type VerificationStatus = 'verified' | 'unverified' | 'unverifiable';

/** The stamped outcome of verifying a model-id replacement. */
export interface VerificationInfo {
  /** `verified` = auto-apply (Tier A); anything else is locate-only (Tier C). */
  status: VerificationStatus;
  /** ISO date (YYYY-MM-DD) the check ran, for staleness of the verdict itself. */
  checkedAt?: string;
  /** Which oracles corroborated the check (e.g. `["openrouter","models.dev"]`). */
  sources?: string[];
  /** Human-readable reasons behind the verdict (audit trail). */
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
   * auto-applies (Tier A) ONLY when `verification.status === 'verified'`;
   * missing or non-`verified` entries are surfaced Tier C locate-only.
   */
  verification?: VerificationInfo;
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
