// The pure recon core: join observed provider usage to the deprecation registry.
// No network, no clock (now is passed in) — fully testable with fixture rows.

import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import { effectiveVerificationState, modelIdEntries } from '../usage/llmRegistry.js';
import { daysUntil } from '../watch/exposure.js';
import type { CostRegression, ExposureFinding, UsageAudit, UsageRow } from './types.js';

/**
 * Normalize a provider-reported model string to the id the registry keys on.
 * Fine-tunes report as `ft:<base>:<org>::<id>` — the deprecation applies to the
 * base model, so we strip to the base. (Rolling aliases like `-latest` are left
 * as-is: they are a separate, deliberate concern.)
 */
export function normalizeModelId(raw: string): string {
  const ft = /^ft:([^:]+):/.exec(raw);
  return ft ? ft[1] : raw;
}

/** Pick the registry entry for a model id: prefer the soonest-shutting (most urgent) wave. */
function entryForModel(
  model: string,
  provider: string,
  entries: readonly LlmModelIdDeprecation[],
): LlmModelIdDeprecation | undefined {
  const matches = entries.filter(
    (e) => e.deprecated === model && (e.provider === provider || provider === 'unknown'),
  );
  if (matches.length === 0) return undefined;
  // Soonest dated shutdown first; dated before undated.
  return [...matches].sort((a, b) => {
    if (a.shutdownDate && b.shutdownDate) return a.shutdownDate < b.shutdownDate ? -1 : 1;
    if (a.shutdownDate) return -1;
    if (b.shutdownDate) return 1;
    return 0;
  })[0];
}

/** Aggregate raw usage rows by (provider, normalized model) — providers return per-bucket rows. */
function aggregate(rows: readonly UsageRow[]): Map<string, UsageRow & { observed: string }> {
  const byModel = new Map<string, UsageRow & { observed: string }>();
  for (const row of rows) {
    const model = normalizeModelId(row.model);
    const key = `${row.provider}:${model}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.requests += row.requests;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.costUsd += row.costUsd;
    } else {
      byModel.set(key, { ...row, model, observed: row.model });
    }
  }
  return byModel;
}

/** Order: deprecated first, then by spend, then by requests, then by id. */
function compareFinding(a: ExposureFinding, b: ExposureFinding): number {
  if (a.deprecated !== b.deprecated) return a.deprecated ? -1 : 1;
  if (a.costUsd !== b.costUsd) return b.costUsd - a.costUsd;
  if (a.requests !== b.requests) return b.requests - a.requests;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/** Join observed usage to the registry and summarize the exposure. Pure. */
export function auditUsage(
  rows: readonly UsageRow[],
  registry: LlmRegistry,
  now: Date,
  period?: { start?: string; end?: string },
): UsageAudit {
  const entries = modelIdEntries(registry);
  const findings: ExposureFinding[] = [];

  for (const agg of aggregate(rows).values()) {
    const entry = entryForModel(agg.model, agg.provider, entries);
    findings.push({
      provider: agg.provider,
      model: agg.model,
      observed: agg.observed,
      requests: agg.requests,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      costUsd: agg.costUsd,
      deprecated: entry !== undefined,
      entryId: entry ? displayEntryId(entry) : null,
      replacement: entry?.replacement ?? null,
      replacementVerdict: entry ? effectiveVerificationState(entry) : null,
      status: entry?.status ?? null,
      shutdownDate: entry?.shutdownDate ?? null,
      daysUntil: entry ? daysUntil(entry.shutdownDate, now) : null,
      sourceUrl: entry?.sourceUrl ?? null,
    });
  }

  findings.sort(compareFinding);
  const exposed = findings.filter((f) => f.deprecated);

  let nearest: number | null = null;
  let overdue: number | null = null;
  for (const f of exposed) {
    if (f.daysUntil === null) continue;
    if (f.daysUntil >= 0) nearest = nearest === null ? f.daysUntil : Math.min(nearest, f.daysUntil);
    else overdue = overdue === null ? -f.daysUntil : Math.max(overdue, -f.daysUntil);
  }

  const sum = (xs: ExposureFinding[], pick: (f: ExposureFinding) => number): number =>
    xs.reduce((s, f) => s + pick(f), 0);

  return {
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    providers: [...new Set(findings.map((f) => f.provider))].sort(),
    totalRequests: sum(findings, (f) => f.requests),
    totalCostUsd: round2(sum(findings, (f) => f.costUsd)),
    models: findings,
    exposed,
    exposedRequests: sum(exposed, (f) => f.requests),
    exposedCostUsd: round2(sum(exposed, (f) => f.costUsd)),
    nearestDeadlineDays: nearest,
    mostOverdueDays: overdue,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Diff two audits (prior -> current) for cost regressions: a model whose spend
 * grew past a threshold, or a model that newly appeared. A direct, dollar-
 * denominated win that needs no repo access.
 */
export function detectCostRegressions(
  prior: UsageAudit,
  current: UsageAudit,
  minDeltaUsd = 1,
): CostRegression[] {
  const priorByKey = new Map(prior.models.map((f) => [`${f.provider}:${f.model}`, f]));
  const out: CostRegression[] = [];
  for (const f of current.models) {
    const key = `${f.provider}:${f.model}`;
    const before = priorByKey.get(key);
    if (!before) {
      if (f.costUsd >= minDeltaUsd) {
        out.push({ provider: f.provider, model: f.model, kind: 'new_model', priorCostUsd: 0, currentCostUsd: f.costUsd, deltaUsd: round2(f.costUsd) });
      }
      continue;
    }
    const delta = f.costUsd - before.costUsd;
    if (delta >= minDeltaUsd) {
      out.push({ provider: f.provider, model: f.model, kind: 'spend_increase', priorCostUsd: before.costUsd, currentCostUsd: f.costUsd, deltaUsd: round2(delta) });
    }
  }
  return out.sort((a, b) => b.deltaUsd - a.deltaUsd);
}
