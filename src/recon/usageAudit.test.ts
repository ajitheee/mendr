import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { autoApplyVerification, loadLlmRegistry, modelIdEntries, withheldVerification } from '../usage/llmRegistry.js';
import { auditUsage, detectCostRegressions, normalizeModelId, registryModelId } from './usageAudit.js';
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

// OpenAI retires fine-tunes in rows of their own (`ft-babbage-002`), not always on the base
// model's date. babbage-002 shut down 2026-09-28; its fine-tunes run until 2026-10-23. Joined to
// the base, a working fine-tune was reported as already dead.
describe('auditUsage — a fine-tune joins the provider row for fine-tunes, when there is one', () => {
  const held = withheldVerification('quarantined', { quarantineReason: 'a fine-tune cannot be swapped' });
  const FT_REGISTRY: LlmRegistry = [
    { provider: 'openai', kind: 'model_id', deprecated: 'babbage-002', replacement: 'gpt-5.6-terra', status: 'retired', shutdownDate: '2026-09-28', verification: autoApplyVerification() },
    { provider: 'openai', kind: 'model_id', deprecated: 'ft-babbage-002', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: held },
    { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo-1106', replacement: 'gpt-5.6-terra', status: 'retired', shutdownDate: '2026-09-28', verification: autoApplyVerification() },
    { provider: 'openai', kind: 'model_id', deprecated: 'ft-gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: held },
    { provider: 'openai', kind: 'model_id', deprecated: 'ft-gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: held },
    { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4o-2024-05-13', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  ];
  const entries = FT_REGISTRY as LlmModelIdDeprecation[];
  const TODAY = new Date('2026-10-10T00:00:00Z');
  const row = (model: string, requests: number): UsageRow => ({ provider: 'openai', model, requests, inputTokens: 1, outputTokens: 1, costUsd: 1 });

  it("reports a babbage-002 fine-tune on its own row's date, apart from the base model", () => {
    const audit = auditUsage([row('ft:babbage-002:acme::abc123', 7), row('babbage-002', 3)], FT_REGISTRY, TODAY);
    const ft = audit.models.find((f) => f.observed === 'ft:babbage-002:acme::abc123')!;
    expect(ft).toMatchObject({ model: 'ft-babbage-002', deprecated: true, shutdownDate: '2026-10-23', daysUntil: 13, requests: 7 });
    // Detect-only: the replacement is a base model, and a swap would drop the training.
    expect(ft.replacementVerdict).toBe('quarantined');
    const base = audit.models.find((f) => f.model === 'babbage-002')!;
    expect(base).toMatchObject({ shutdownDate: '2026-09-28', requests: 3 });
  });

  it('reads a family row as covering every snapshot of the family, and nothing next to it', () => {
    expect(registryModelId('ft:gpt-3.5-turbo-1106:acme::x', 'openai', entries)).toBe('ft-gpt-3.5-turbo');
    expect(registryModelId('ft:gpt-3.5-turbo-0125:acme:support:y', 'openai', entries)).toBe('ft-gpt-3.5-turbo');
    expect(registryModelId('ft:gpt-4-0613:acme::z', 'openai', entries)).toBe('ft-gpt-4');
    // gpt-4o is not gpt-4 plus a segment: a fine-tune of it keeps joining its own base.
    expect(registryModelId('ft:gpt-4o-2024-05-13:acme::w', 'openai', entries)).toBe('gpt-4o-2024-05-13');
  });

  it('leaves everything that is not a fine-tune alone, and a fine-tune with no row joins its base', () => {
    expect(registryModelId('babbage-002', 'openai', entries)).toBe('babbage-002');
    expect(registryModelId('gpt-3.5-turbo-1106', 'openai', entries)).toBe('gpt-3.5-turbo-1106');
    expect(registryModelId('ft:gpt-4o-mini-2024-07-18:acme::v', 'openai', entries)).toBe('gpt-4o-mini-2024-07-18');
    // Another provider's fine-tune never joins an OpenAI row.
    expect(registryModelId('ft:babbage-002:acme::u', 'google', entries)).toBe('babbage-002');
  });

  it('dates the fine-tunes in the shipped registry the way OpenAI does', () => {
    const shipped = loadLlmRegistry();
    for (const [observed, expected] of [
      ['ft:babbage-002:acme::abc', 'ft-babbage-002'],
      ['ft:davinci-002:acme::abc', 'ft-davinci-002'],
      ['ft:gpt-3.5-turbo-1106:acme::abc', 'ft-gpt-3.5-turbo'],
      ['ft:gpt-4-0613:acme::abc', 'ft-gpt-4'],
      ['ft:gpt-4.1-nano-2025-04-14:acme::abc', 'ft-gpt-4.1-nano-2025-04-14'],
      ['ft:o4-mini-2025-04-16:acme::abc', 'ft-o4-mini-2025-04-16'],
    ]) {
      const [f] = auditUsage([row(observed, 1)], shipped, TODAY).models;
      expect(f.model, observed).toBe(expected);
      expect(f.shutdownDate, observed).toBe('2026-10-23');
      expect(f.replacementVerdict, observed).toBe('quarantined');
    }
    // ...and every fine-tune row ships held: none is ever an automatic swap.
    const rows = modelIdEntries(shipped).filter((e) => e.deprecated.startsWith('ft-'));
    expect(rows).toHaveLength(6);
    for (const e of rows) expect(e.verification?.autoApplyAllowed, e.deprecated).toBe(false);
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
