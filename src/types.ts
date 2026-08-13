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

/** The class of LLM breakage a registry entry describes. */
export type LlmDeprecationKind = 'model_id' | 'param_rename';

/**
 * A single LLM API deprecation: a provider's `deprecated` token and the
 * `replacement` to migrate to. For `model_id`, these are model-id string
 * literals (`"gemini-2.0-flash"` -> `"gemini-flash-latest"`). For
 * `param_rename`, they are request-parameter names (`max_tokens` ->
 * `max_completion_tokens`).
 */
export interface LlmDeprecation {
  /** The LLM provider, e.g. `"google"` or `"openai"`. */
  provider: string;
  /** Whether this is a model-id swap or a request-param rename. */
  kind: LlmDeprecationKind;
  /** The retired/deprecated token (an exact value to match). */
  deprecated: string;
  /** The token to migrate to. */
  replacement: string;
  /** Optional human note explaining the deprecation. */
  note?: string;
}

/** The parsed `registries/llm-deprecations.json` registry. */
export type LlmRegistry = LlmDeprecation[];
