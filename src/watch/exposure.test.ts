import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { TYPE_CAST_REASON } from '../usage/scanLiterals.js';
import {
  computeExposure,
  daysUntil,
  foldExposure,
  MAX_LOCATIONS_PER_MODEL,
  type ExposureMatch,
} from './exposure.js';

const NOW = new Date('2026-08-22T12:00:00Z');

function entry(overrides: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-4.1',
    shutdownDate: '2026-10-23',
    status: 'deprecated',
    ...overrides,
  };
}

function match(over: Partial<ExposureMatch> = {}): ExposureMatch {
  return {
    value: over.entry?.deprecated ?? 'gpt-4-0314',
    entry: entry(),
    file: 'src/app.ts',
    line: 1,
    column: 1,
    tier: 'C',
    ...over,
  };
}

describe('daysUntil', () => {
  it('counts whole days to a future retirement at UTC day granularity', () => {
    expect(daysUntil('2026-10-23', NOW)).toBe(62);
  });
  it('is 0 on the retirement day and negative after it', () => {
    expect(daysUntil('2026-08-22', NOW)).toBe(0);
    expect(daysUntil('2026-08-01', NOW)).toBe(-21);
  });
  it('is null for an undated entry or a malformed date', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
  it('is null for a calendar-invalid date instead of silently rolling it over', () => {
    expect(daysUntil('2026-11-31', NOW)).toBeNull();
    expect(daysUntil('2025-02-29', NOW)).toBeNull();
    expect(daysUntil('2028-02-29', NOW)).not.toBeNull();
  });
});

describe('classifyOccurrenceTier (the ONE tier classifier, shared with fix-llm)', () => {
  const verified = entry({ verification: autoApplyVerification() });
  const unverified = entry();
  it('a verified live model argument is Tier A', () => {
    expect(classifyOccurrenceTier({ position: 'model_arg', deprecation: verified })).toEqual({ tier: 'A' });
  });
  it('an unverified live model argument is Tier B (replacement_unverified)', () => {
    expect(classifyOccurrenceTier({ position: 'model_arg', deprecation: unverified })).toEqual({
      tier: 'B',
      reason: 'replacement_unverified',
    });
  });
  it('a sink-less model-like assignment is Tier B (usage_unverified)', () => {
    expect(classifyOccurrenceTier({ position: 'usage_unverified', deprecation: unverified })).toEqual({
      tier: 'B',
      reason: 'usage_unverified',
    });
  });
  it('an azure deployment alias is Tier B (platform_blocked)', () => {
    expect(classifyOccurrenceTier({ position: 'azure_deployment', deprecation: unverified })).toEqual({
      tier: 'B',
      reason: 'platform_blocked',
    });
  });
  it('a data literal behind an as-cast is Tier B (type_cast_masked)', () => {
    expect(
      classifyOccurrenceTier({ position: 'data', deprecation: unverified, reason: TYPE_CAST_REASON }),
    ).toEqual({ tier: 'B', reason: 'type_cast_masked' });
  });
  it('a plain data literal is Tier C', () => {
    expect(classifyOccurrenceTier({ position: 'data', deprecation: unverified })).toEqual({ tier: 'C' });
  });
});

describe('foldExposure', () => {
  it('groups occurrences and counts them per tier, with the highest tier', () => {
    const models = foldExposure([
      match({ file: 'src/b.ts', line: 5, tier: 'B', reason: 'usage_unverified' }),
      match({ file: 'src/a.ts', line: 9, tier: 'C' }),
      match({ file: 'src/a.ts', line: 2, tier: 'C' }),
    ]);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.occurrences).toBe(3);
    expect(m.tierCounts).toEqual({ A: 0, B: 1, C: 2 });
    expect(m.highestTier).toBe('B');
    // Locations sorted by (file, line): a:2, a:9, b:5.
    expect(m.locations.map((l) => `${l.file}:${l.line}`)).toEqual([
      'src/a.ts:2',
      'src/a.ts:9',
      'src/b.ts:5',
    ]);
  });

  it('orders RISK FIRST, then nearest deadline — a Tier B beats a more-overdue Tier C', () => {
    const reviewNear = entry({ deprecated: 'gpt-4', shutdownDate: '2026-10-23' }); // Tier B, 61d
    const dataOld = entry({ deprecated: 'gemini-1.5-pro', shutdownDate: '2025-01-01' }); // Tier C, retired
    const models = foldExposure([
      match({ entry: dataOld, value: 'gemini-1.5-pro', tier: 'C' }),
      match({ entry: reviewNear, value: 'gpt-4', tier: 'B', reason: 'usage_unverified' }),
    ]);
    // gpt-4 (review) sorts BEFORE gemini-1.5-pro (data), even though gemini is more overdue.
    expect(models.map((m) => m.id)).toEqual(['gpt-4', 'gemini-1.5-pro']);
    expect(models[0].highestTier).toBe('B');
    expect(models[1].highestTier).toBe('C');
  });

  it('within a tier, sorts by nearest deadline, dated before undated', () => {
    const a = entry({ deprecated: 'a', shutdownDate: '2026-12-01' });
    const b = entry({ deprecated: 'b', shutdownDate: '2026-09-01' });
    const undated = entry({ deprecated: 'c', shutdownDate: undefined });
    const models = foldExposure([
      match({ entry: undated, value: 'c', tier: 'C' }),
      match({ entry: a, value: 'a', tier: 'C' }),
      match({ entry: b, value: 'b', tier: 'C' }),
    ]);
    expect(models.map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });

  it('caps persisted locations but keeps the true occurrence count', () => {
    const many: ExposureMatch[] = Array.from({ length: MAX_LOCATIONS_PER_MODEL + 20 }, (_, i) =>
      match({ file: 'src/app.ts', line: i + 1, tier: 'C' }),
    );
    const [m] = foldExposure(many);
    expect(m.occurrences).toBe(MAX_LOCATIONS_PER_MODEL + 20);
    expect(m.tierCounts.C).toBe(MAX_LOCATIONS_PER_MODEL + 20);
    expect(m.locations).toHaveLength(MAX_LOCATIONS_PER_MODEL);
  });
});

describe('computeExposure classifies real code the same way fix-llm does', () => {
  it('a verified live call is Tier A, a price-table key is Tier C', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-ts-'));
    writeFileSync(
      join(dir, 'app.ts'),
      'export const c = create({ model: "gpt-4-0314" });\n' +
        'export const PRICES = { "gpt-4-0314": 1 };\n',
    );
    const registry: LlmRegistry = [entry({ verification: autoApplyVerification() })];
    const { models } = await computeExposure(dir, registry);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.occurrences).toBe(2);
    expect(m.tierCounts).toEqual({ A: 1, B: 0, C: 1 }); // live verified + data key
    expect(m.highestTier).toBe('A');
  });

  // THE REVIEWER'S REGRESSION FIXTURE (Splunk-Agent shape): one Tier B gpt-4
  // (a model-like assignment with no sink), one Tier C gpt-4 (a dict key), and
  // two Tier C gemini-1.5-pro (list entries). Watch must not flatten these.
  it('splunk-shape: 2 models, 4 occurrences, gpt-4 highest B, gemini highest C', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-splunk-'));
    writeFileSync(
      join(dir, 'agent.py'),
      'model = "gpt-4"\n' + // model-like assignment, no sink -> Tier B usage_unverified
        'prices = {"gpt-4": 0.03}\n' + // dict key -> Tier C data
        'choices = ["gemini-1.5-pro", "gemini-1.5-pro"]\n', // list entries -> Tier C x2
    );
    const registry: LlmRegistry = [
      entry({ deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', shutdownDate: '2026-10-23' }),
      entry({
        provider: 'google',
        deprecated: 'gemini-1.5-pro',
        replacement: 'gemini-2.5-pro',
        shutdownDate: '2025-09-24',
        status: 'retired',
      }),
    ];
    const { models } = await computeExposure(dir, registry);

    expect(models).toHaveLength(2);
    const total = models.reduce((s, m) => s + m.occurrences, 0);
    expect(total).toBe(4);

    const gpt = models.find((m) => m.id === 'gpt-4')!;
    const gemini = models.find((m) => m.id === 'gemini-1.5-pro')!;
    expect(gpt.tierCounts).toEqual({ A: 0, B: 1, C: 1 });
    expect(gpt.highestTier).toBe('B');
    expect(gemini.tierCounts).toEqual({ A: 0, B: 0, C: 2 });
    expect(gemini.highestTier).toBe('C');

    // Aggregate tier totals across the repo.
    const tierB = models.reduce((s, m) => s + m.tierCounts.B, 0);
    const tierC = models.reduce((s, m) => s + m.tierCounts.C, 0);
    expect(tierB).toBe(1);
    expect(tierC).toBe(3);

    // Risk first: gpt-4 (review) before gemini-1.5-pro (data), despite gemini
    // being long retired.
    expect(models.map((m) => m.id)).toEqual(['gpt-4', 'gemini-1.5-pro']);
  });

  it('reports no exposure for a repo that uses no deprecated ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-clean-'));
    writeFileSync(join(dir, 'app.ts'), 'export const c = create({ model: "gpt-4.1" });\n');
    const { models } = await computeExposure(dir, [entry()]);
    expect(models).toHaveLength(0);
  });
});
