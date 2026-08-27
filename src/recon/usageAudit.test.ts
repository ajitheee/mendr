import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { auditUsage, detectCostRegressions, normalizeModelId } from './usageAudit.js';
import type { UsageRow } from './types.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-4o-mini', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];
const NOW = new Date('2026-08-26T00:00:00Z');

const rows: UsageRow[] = [
  { provider: 'openai', model: 'gpt-4', requests: 100, inputTokens: 1000, outputTokens: 200, costUsd: 50 },
  { provider: 'openai', model: 'ft:gpt-3.5-turbo:acme::x', requests: 10, inputTokens: 100, outputTokens: 20, costUsd: 5 },
  { provider: 'openai', model: 'gpt-3.5-turbo', requests: 40, inputTokens: 400, outputTokens: 80, costUsd: 15 },
  { provider: 'openai', model: 'gpt-4o', requests: 500, inputTokens: 5000, outputTokens: 1000, costUsd: 200 }, // current, not deprecated
];

describe('normalizeModelId', () => {
  it('strips the fine-tune prefix to the base model', () => {
    expect(normalizeModelId('ft:gpt-3.5-turbo:acme::abc')).toBe('gpt-3.5-turbo');
    expect(normalizeModelId('gpt-4')).toBe('gpt-4');
  });
});

describe('auditUsage — join observed usage to the registry', () => {
  const audit = auditUsage(rows, REGISTRY, NOW, { start: '2026-07-27', end: '2026-08-26' });

  it('flags deprecated models and leaves current ones out of the exposure', () => {
    expect(audit.exposed.map((f) => f.model).sort()).toEqual(['gpt-3.5-turbo', 'gpt-4']);
    expect(audit.models.find((f) => f.model === 'gpt-4o')!.deprecated).toBe(false);
  });

  it('merges a fine-tune into its base model (normalization + aggregation)', () => {
    const g35 = audit.exposed.find((f) => f.model === 'gpt-3.5-turbo')!;
    expect(g35.requests).toBe(50); // 10 (ft) + 40 (base)
    expect(g35.costUsd).toBe(20); // 5 + 15
  });

  it('carries the registry replacement, verdict, and deadline', () => {
    const g4 = audit.exposed.find((f) => f.model === 'gpt-4')!;
    expect(g4.replacement).toBe('gpt-4o');
    expect(g4.replacementVerdict).toBe('verified');
    expect(g4.daysUntil).toBe(58); // 2026-08-26 -> 2026-10-23
  });

  it('aggregates totals and the exposure subtotal in dollars', () => {
    expect(audit.totalCostUsd).toBe(270); // 50 + 5 + 15 + 200
    expect(audit.exposedCostUsd).toBe(70); // 50 + 20
    expect(audit.nearestDeadlineDays).toBe(58);
  });

  it('reports a clean audit when nothing deprecated is in use', () => {
    const clean = auditUsage(
      [{ provider: 'openai', model: 'gpt-4o', requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 1 }],
      REGISTRY,
      NOW,
    );
    expect(clean.exposed).toEqual([]);
  });
});

describe('detectCostRegressions', () => {
  it('flags a spend increase and a newly-appeared model', () => {
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
    const regs = detectCostRegressions(prior, current);
    expect(regs.find((r) => r.model === 'gpt-4')).toMatchObject({ kind: 'spend_increase', deltaUsd: 160 });
    expect(regs.find((r) => r.model === 'gpt-4o')).toMatchObject({ kind: 'new_model', deltaUsd: 40 });
  });
});
