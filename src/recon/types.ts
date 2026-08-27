// Provider usage-API recon (integration shape #5) — the zero-touch audit opener.
//
// Reads per-model request counts and spend from a provider's own usage/billing
// API with a READ-ONLY key, then joins the observed model ids to mendr's existing
// deprecation registry. It answers "which deprecated models are you ACTUALLY
// running, and what does it cost" for customers whose model ids live in config /
// DBs / runtime — the exact exposure a git scanner returns zero for.
//
// It MEASURES; it does not LOCATE (no file/flag/row to patch). Aggregate metadata
// only — never prompts, completions, or PII.

export type Provider = 'openai' | 'anthropic' | 'google';

/** One provider usage record for a single model over a period (already aggregated). */
export interface UsageRow {
  provider: Provider;
  /** The model string exactly as the provider reported it (may be a fine-tune or alias). */
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD spend for this model over the period; 0 when the cost API was unavailable. */
  costUsd: number;
}

/** One observed model, joined against the deprecation registry. */
export interface ExposureFinding {
  provider: string;
  /** Normalized model id (fine-tune prefix stripped). */
  model: string;
  /** The raw observed string, when it differed from the normalized id. */
  observed: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when this model matches a registry deprecation entry. */
  deprecated: boolean;
  entryId: string | null;
  replacement: string | null;
  /** The registry's verdict for the dead->replacement mapping. */
  replacementVerdict: string | null;
  status: string | null;
  shutdownDate: string | null;
  /** Days until shutdown (negative = overdue, null = undated/not deprecated). */
  daysUntil: number | null;
  sourceUrl: string | null;
}

/** The full audit: what a customer is running, what is deprecated, and the cost. */
export interface UsageAudit {
  periodStart: string | null;
  periodEnd: string | null;
  providers: string[];
  totalRequests: number;
  totalCostUsd: number;
  /** Every observed model, deprecated-first then by cost. */
  models: ExposureFinding[];
  /** The deprecated subset (the exposure). */
  exposed: ExposureFinding[];
  exposedRequests: number;
  exposedCostUsd: number;
  /** Nearest upcoming shutdown across the exposure, in days (null when none upcoming). */
  nearestDeadlineDays: number | null;
  /** Most-overdue shutdown across the exposure, in days (null when none overdue). */
  mostOverdueDays: number | null;
}

/** A cost regression between two audits (spend spike, or a newly-appeared model). */
export interface CostRegression {
  provider: string;
  model: string;
  kind: 'spend_increase' | 'new_model';
  priorCostUsd: number;
  currentCostUsd: number;
  deltaUsd: number;
}
