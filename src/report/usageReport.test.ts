import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { auditUsage, detectCostRegressions } from '../recon/usageAudit.js';
import type { ExposureFinding, UsageAudit } from '../recon/types.js';
import { renderCostRegressions, renderUsageReport } from './usageReport.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-4o-mini', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];
const NOW = new Date('2026-08-26T00:00:00Z');

// The positive path: a real audit with live deprecated usage (one of them a
// fine-tune), joined through auditUsage, then rendered for the terminal.
describe('renderUsageReport — a real exposure renders the MEASURE report', () => {
  const audit = auditUsage(
    [
      { provider: 'openai', model: 'gpt-4', requests: 100, inputTokens: 1000, outputTokens: 200, costUsd: 50 },
      { provider: 'openai', model: 'ft:gpt-3.5-turbo:acme::x', requests: 40, inputTokens: 400, outputTokens: 80, costUsd: 20 },
      { provider: 'openai', model: 'gpt-4o', requests: 500, inputTokens: 5000, outputTokens: 1000, costUsd: 200 },
    ],
    REGISTRY,
    NOW,
    { start: '2026-07-27', end: '2026-08-26' },
  );
  const out = renderUsageReport(audit).join('\n');

  it('headers the audited period, the providers, and the whole-account totals', () => {
    expect(out).toContain('AI dependency audit — 2026-07-27 to 2026-08-26');
    expect(out).toContain('providers: openai');
    expect(out).toContain('across 3 model(s)'); // gpt-4, gpt-3.5-turbo, gpt-4o
  });

  it('summarizes the exposure in dollars with the nearest deadline', () => {
    // gpt-4 (100 req, $50) + gpt-3.5-turbo (40 req, $20) = 140 req, $70.
    expect(out).toContain('EXPOSURE: 2 deprecated model(s), 140 live requests, $70.00 spend');
    expect(out).toContain('nearest deadline 58d'); // 2026-08-26 -> 2026-10-23
  });

  it('shows a verified replacement as an actionable arrow', () => {
    expect(out).toContain('gpt-4');
    expect(out).toContain('-> gpt-4o [registry: verified]');
  });

  it('preserves the raw fine-tune id it observed, distinct from the base model', () => {
    expect(out).toContain('gpt-3.5-turbo (observed as ft:gpt-3.5-turbo:acme::x)');
  });

  it('states it MEASURES but does not LOCATE — the honest boundary of this shape', () => {
    expect(out).toContain('does not locate the file/flag/row to change');
  });
});

// An unverified registry mapping must render as review-only, never as a swap.
describe('renderUsageReport — an unverified replacement is not offered as a swap', () => {
  const finding: ExposureFinding = {
    provider: 'openai',
    model: 'gpt-4',
    observed: 'gpt-4',
    requests: 10,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 12,
    deprecated: true,
    entryId: 'openai/gpt-4',
    replacement: 'gpt-4o',
    replacementVerdict: 'community',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    daysUntil: 58,
    sourceUrl: null,
  };
  const audit: UsageAudit = {
    periodStart: null, periodEnd: null, providers: ['openai'],
    totalRequests: 10, totalCostUsd: 12, models: [finding], exposed: [finding],
    exposedRequests: 10, exposedCostUsd: 12, nearestDeadlineDays: 58, mostOverdueDays: null,
  };
  const out = renderUsageReport(audit).join('\n');

  it('labels it a review, not a recommended swap', () => {
    expect(out).toContain('replacement gpt-4o is community — review, not a recommended swap');
    expect(out).not.toContain('-> gpt-4o [registry: verified]');
  });
});

describe('renderCostRegressions — a spend spike and a new model render', () => {
  it('renders an UP line for a spend increase and a NEW line for a fresh model', () => {
    const prior = auditUsage(
      [{ provider: 'openai', model: 'gpt-4', requests: 10, inputTokens: 1, outputTokens: 1, costUsd: 100 }],
      REGISTRY, NOW,
    );
    const current = auditUsage(
      [
        { provider: 'openai', model: 'gpt-4', requests: 10, inputTokens: 1, outputTokens: 1, costUsd: 260 },
        { provider: 'openai', model: 'gpt-4o', requests: 10, inputTokens: 1, outputTokens: 1, costUsd: 40 },
      ],
      REGISTRY, NOW,
    );
    const out = renderCostRegressions(detectCostRegressions(prior, current)).join('\n');
    expect(out).toContain('[UP] gpt-4 (openai): $100.00 -> $260.00  (+$160.00)');
    expect(out).toContain('[NEW] gpt-4o (openai): $0.00 -> $40.00  (+$40.00)');
  });

  it('says so plainly when there is no regression', () => {
    expect(renderCostRegressions([])).toEqual(['No cost regressions between the two periods.']);
  });
});
