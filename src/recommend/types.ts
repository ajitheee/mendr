// `mendr recommend` — M1 contracts.
//
// See RECOMMEND-M1-SPEC.md. recommend is the compatibility-shortlist rung: it
// answers "which live models can drop in here", never "which is best" (that is
// the eval-gated M4 rung). Everything in M1 is report-only and writes nothing.
//
// These types are recommend-owned. They deliberately do NOT reuse the
// deprecation registry's VerificationInfo / VerificationStatus: an active model
// asserts "this id is live with these capabilities", which is a different claim
// from "this id is dying and this is the safe swap". Trust here is provenance
// per field, not a four-field auto-apply gate.

import type { LiteralPosition } from '../usage/scanLiterals.js';
import type { TierBReason } from '../types.js';

// ── shared provenance wrapper ──────────────────────────────────────────────
/** Every catalog fact carries where it came from and when it was checked. */
export interface Provenanced<T> {
  value: T;
  /** URL or oracle id the fact was read from (non-empty). */
  source: string;
  /** ISO YYYY-MM-DD, string-comparable (matches the deprecation registry). */
  checkedAt: string;
}

/** The request shape a model is called through — determined by the SDK method. */
export type EndpointFamily =
  | 'chat_completions' // OpenAI classic
  | 'responses' // OpenAI responses API
  | 'messages' // Anthropic
  | 'gemini_generate'; // Google

// ── 1. ActiveModel ─────────────────────────────────────────────────────────
/** A live model in the catalog. NOT a clone of LlmModelIdDeprecation. */
export interface ActiveModel {
  /** DERIVED: `${provider}.${modelId}.active`, unique, re-derived by the validator. */
  entryId: string;
  provider: 'openai' | 'anthropic' | 'google';
  modelId: string;
  /** NOT named `status` — that word already means two other things in this repo. */
  lifecycle: 'active' | 'preview';
  capabilities: {
    tools: Provenanced<boolean>;
    jsonStrict: Provenanced<boolean>;
    streaming: Provenanced<boolean>;
    vision: Provenanced<boolean>;
    reasoning: Provenanced<boolean>;
    contextTokens: Provenanced<number>;
    maxOutputTokens: Provenanced<number>;
  };
  endpoint: Provenanced<EndpointFamily>;
  price: {
    inputPerMTok: Provenanced<number>;
    outputPerMTok: Provenanced<number>;
    currency: 'USD';
  };
  /** Carried as DATA in M1; the live availability probe is M2. Never asserts customer access. */
  availability: {
    regions: Provenanced<string[]> | { value: 'unknown' };
    requiresPreviewAccess: Provenanced<boolean>;
    minAccountTier: Provenanced<string | null>;
  };
}

// ── 2. ExtractedRequirement ────────────────────────────────────────────────
export type RequirementState = 'required' | 'not_observed' | 'unknown';

export type RequirementKey =
  | 'tools'
  | 'vision'
  | 'jsonStrict'
  | 'streaming'
  | 'reasoning'
  | 'minOutputTokens'
  | 'endpoint';

/** Every requirement mendr can derive from a call site is exactly these keys. */
export const REQUIREMENT_KEYS: readonly RequirementKey[] = [
  'tools',
  'vision',
  'jsonStrict',
  'streaming',
  'reasoning',
  'minOutputTokens',
  'endpoint',
];

export interface ExtractedRequirement {
  key: RequirementKey;
  state: RequirementState;
  /** "file:line — what was seen"; null when not_observed. */
  evidence: string | null;
  /** minOutputTokens only: the floor read from max_tokens/max_completion_tokens. */
  min?: number;
  /** endpoint only: the resolved family. */
  endpointFamily?: EndpointFamily;
}

// ── 3. CandidateDecision ───────────────────────────────────────────────────
export type CandidateOrigin = 'official_successor' | 'compatible_alternative';

export interface CapabilityCheck {
  key: RequirementKey;
  requirement: RequirementState;
  /** What the catalog declares; 'unknown' = the field has no provenance. */
  catalogValue: boolean | number | string | 'unknown';
  result: 'satisfied' | 'unsatisfied' | 'not_applicable' | 'indeterminate';
}

export interface CandidateDecision {
  modelId: string;
  origin: CandidateOrigin;
  kept: boolean;
  checks: CapabilityCheck[];
  /** The FIRST required capability it failed; null when kept. */
  eliminatedBy: RequirementKey | null;
  eliminationDetail: string | null;
  /** False for an official successor the registry names but the catalog does not yet cover. */
  inCatalog: boolean;
  /** For an official successor: the registry's verdict for the dead→replacement mapping; null for alternatives. */
  registryVerdict: string | null;
}

// ── 4. Authorization ───────────────────────────────────────────────────────
export type AuthorizationType =
  | 'official_successor'
  | 'compatibility_only'
  | 'customer_eval'
  | 'human_selected';

export interface Authorization {
  type: AuthorizationType;
  policy?: string; // customer_eval only (M4)
  evalRuns?: number; // customer_eval only (M4)
  passedCandidates?: number; // customer_eval only (M4)
}

// ── 5. VerificationScope ───────────────────────────────────────────────────
// Renamed from the sketched `VerificationStatus`: types.ts already exports
// VerificationStatus for the deprecation registry. Two value-spaces under one
// name is the collision to avoid.
//   passed        = measured this rung and met its bar.
//   failed        = measured this rung and did not.
//   not_evaluated = this rung does not measure this dimension at all.
//   unknown       = in scope this rung but the input was indeterminate.
export type VerificationOutcome = 'passed' | 'failed' | 'not_evaluated' | 'unknown';

export interface VerificationScope {
  providerStatus: VerificationOutcome;
  availability: VerificationOutcome;
  code: VerificationOutcome;
  capabilities: VerificationOutcome;
  toolBehavior: VerificationOutcome;
  outputSchema: VerificationOutcome;
  cost: VerificationOutcome;
  latency: VerificationOutcome;
  semanticQuality: VerificationOutcome;
}

// ── 6. RecommendationReceipt ───────────────────────────────────────────────
/** A separate view type. NOT an extension of ExposedModel. */
export interface RecommendationReceipt {
  deprecated: string;
  entryId: string;
  provider: string;
  candidateProvider: 'openai' | 'anthropic' | 'google';
  occurrences: number;
  requirements: ExtractedRequirement[];
  reviewFlag: boolean;
  authorization: Authorization;
  verification: VerificationScope;
  officialSuccessors: CandidateDecision[];
  compatibleAlternatives: CandidateDecision[];
  rejected: CandidateDecision[];
  /**
   * False when the endpoint (model class) could not be determined — compatible
   * alternatives are then NOT offered, because we cannot confirm they are even
   * the same model class (e.g. a chat model must not be offered for a dall-e call).
   */
  alternativesQualified: boolean;
  sortedBy: 'cost' | 'context' | null;
  /** The nearest shutdown deadline for the dead model, in days (null when undated). */
  deadlineDays: number | null;
}

/**
 * A deprecated id found in a position recommend cannot generate a shortlist for,
 * but which fix-llm/watch would flag for review (a usage-unverified assignment or
 * an azure deployment alias). Surfaced so recommend never hides a known finding.
 */
export interface ReviewFinding {
  deprecated: string;
  entryId: string;
  provider: string;
  file: string;
  line: number;
  /** The SAME Tier B reason watch/fix-llm assign (via classifyOccurrenceTier) — one canonical classification. */
  reason: TierBReason;
  detail: string;
}

/** A deprecated id found only in DATA positions (config/list/comparison), grouped by id. */
export interface InformationalGroup {
  deprecated: string;
  entryId: string;
  provider: string;
  occurrences: number;
}

/** The overall outcome of a recommend scan. */
export type RecommendStatus =
  | 'recommendations' // >= 1 live call produced a shortlist
  | 'no_shortlist' // live calls found, but no catalog model met their requirements
  | 'no_live_calls' // deprecated ids found, but none in a verified live call
  | 'clean'; // no deprecated model ids found at all

/**
 * The stable `recommend --json` envelope. It reports THREE buckets so it never
 * conceals what watch/fix-llm found: `recommendations` (live calls with a
 * shortlist), `reviewRequired` (found but usage unverifiable), and
 * `informational` (data positions). Empty scan => all three empty, status 'clean'.
 */
export interface RecommendJson {
  schema: 'mendr-recommend/v1';
  status: RecommendStatus;
  reason: string;
  registryVersion: string;
  catalogVersion: string;
  scannedCommit: string | null;
  /** The --provider filter (null if unset). A repo may use several providers, so this is a FILTER, not the repo's provider. */
  providerFilter: string | null;
  /** Distinct providers with any deprecated usage found in the repo. */
  providersFound: string[];
  sortedBy: 'cost' | 'context' | null;
  hasRecommendations: boolean;
  findings: {
    liveDeprecatedCalls: number; // model_arg occurrences that produced receipts
    usageUnverified: number; // usage-unverified review occurrences
    informational: number; // data-position occurrences
  };
  reviewFlagged: number;
  filesScanned: number;
  filesMatched: number;
  recommendations: RecommendationReceipt[];
  reviewRequired: ReviewFinding[];
  informational: InformationalGroup[];
}

/** A single dead-model occurrence recommend keys on (a live model argument). */
export interface RecommendOccurrence {
  file: string;
  line: number;
  column: number;
  /** Always 'model_arg' — recommend only considers live call sites. */
  position: LiteralPosition;
  /** The per-occurrence requirement profile (empty/unknown for Python in M1). */
  requirements: ExtractedRequirement[];
}
