import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
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
    position: 'model_arg',
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
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
  it('is null for a calendar-invalid date instead of silently rolling it over', () => {
    // V8 would roll "2026-11-31" -> Dec 1 and "2025-02-29" -> Mar 1; a typo in
    // the registry must yield "unscheduled", never a plausible wrong countdown.
    expect(daysUntil('2026-11-31', NOW)).toBeNull();
    expect(daysUntil('2025-02-29', NOW)).toBeNull();
    expect(daysUntil('2026-02-30', NOW)).toBeNull();
    // A real leap day still parses.
    expect(daysUntil('2028-02-29', NOW)).not.toBeNull();
  });
});

describe('foldExposure', () => {
  it('groups occurrences of one entry and counts live vs data positions', () => {
    const models = foldExposure([
      match({ file: 'src/b.ts', line: 5, position: 'model_arg' }),
      match({ file: 'src/a.ts', line: 9, position: 'data' }),
      match({ file: 'src/a.ts', line: 2, position: 'model_arg' }),
    ]);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe('gpt-4-0314');
    expect(m.entryId).toBe('openai.gpt-4-0314.retirement-2026-10-23');
    expect(m.occurrences).toBe(3);
    expect(m.liveOccurrences).toBe(2);
    // Locations sorted by (file, line): a:2, a:9, b:5.
    expect(m.locations.map((l) => `${l.file}:${l.line}`)).toEqual([
      'src/a.ts:2',
      'src/a.ts:9',
      'src/b.ts:5',
    ]);
  });

  it('keeps distinct registry entries separate even at the same value', () => {
    const wave1 = entry({ shutdownDate: '2026-10-23' });
    const wave2 = entry({ shutdownDate: '2027-01-01' });
    const models = foldExposure([
      match({ entry: wave2, position: 'data' }),
      match({ entry: wave1, position: 'model_arg' }),
    ]);
    expect(models).toHaveLength(2);
    // Soonest deadline first.
    expect(models[0].shutdownDate).toBe('2026-10-23');
    expect(models[1].shutdownDate).toBe('2027-01-01');
  });

  it('sorts dated models ahead of undated ones, then by entry id', () => {
    const dated = entry({ deprecated: 'gpt-4-0613', shutdownDate: '2026-12-01' });
    const undated = entry({ deprecated: 'text-davinci-003', shutdownDate: undefined });
    const models = foldExposure([
      match({ entry: undated, value: 'text-davinci-003', position: 'data' }),
      match({ entry: dated, value: 'gpt-4-0613', position: 'model_arg' }),
    ]);
    expect(models.map((m) => m.id)).toEqual(['gpt-4-0613', 'text-davinci-003']);
    expect(models[1].shutdownDate).toBeNull();
  });

  it('counts usage_unverified / azure as review — neither live nor pure data', () => {
    const models = foldExposure([
      match({ position: 'model_arg' }),
      match({ position: 'usage_unverified' }),
      match({ position: 'azure_deployment' }),
      match({ position: 'data' }),
    ]);
    const m = models[0];
    expect(m.occurrences).toBe(4);
    expect(m.liveOccurrences).toBe(1);
    expect(m.reviewOccurrences).toBe(2); // usage_unverified + azure alias
  });

  it('caps persisted locations but keeps the true occurrence count', () => {
    const many: ExposureMatch[] = Array.from({ length: MAX_LOCATIONS_PER_MODEL + 20 }, (_, i) =>
      match({ file: 'src/app.ts', line: i + 1, position: 'data' }),
    );
    const [m] = foldExposure(many);
    expect(m.occurrences).toBe(MAX_LOCATIONS_PER_MODEL + 20);
    expect(m.locations).toHaveLength(MAX_LOCATIONS_PER_MODEL);
  });
});

describe('computeExposure (on disk)', () => {
  it('finds a live model-arg literal in a TS repo and reports it exposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-'));
    writeFileSync(
      join(dir, 'app.ts'),
      'export const c = create({ model: "gpt-4-0314" });\n' +
        'export const PRICES = { "gpt-4-0314": 1 };\n',
    );
    const registry: LlmRegistry = [entry()];
    const exposure = await computeExposure(dir, registry);

    expect(exposure.models).toHaveLength(1);
    const m = exposure.models[0];
    expect(m.id).toBe('gpt-4-0314');
    expect(m.shutdownDate).toBe('2026-10-23');
    // One live model_arg (the create call) + one data occurrence (the price key).
    expect(m.occurrences).toBe(2);
    expect(m.liveOccurrences).toBe(1);
  });

  it('reports no exposure for a repo that uses no deprecated ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-clean-'));
    writeFileSync(join(dir, 'app.ts'), 'export const c = create({ model: "gpt-4.1" });\n');
    const exposure = await computeExposure(dir, [entry()]);
    expect(exposure.models).toHaveLength(0);
  });

  // REGRESSION (watch-review finding #1): the scanners once indexed the registry
  // by `deprecated` value FIRST-WINS, so a value with two records surfaced under
  // only the first record's id and the second retirement deadline vanished. This
  // drives the REAL scanner (not just foldExposure) with two records for one id
  // and proves BOTH deadlines reach the exposure.
  it('surfaces BOTH records when one deprecated id has two retirement waves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-watch-dup-'));
    // One physical live occurrence of the id + one data occurrence (a price key).
    writeFileSync(
      join(dir, 'app.ts'),
      'export const c = create({ model: "gpt-4-0314" });\n' +
        'export const PRICES = { "gpt-4-0314": 1 };\n',
    );
    // Two records for ONE value: same provider, distinct shutdownDates -> distinct
    // entryIds (validateRegistry permits this; entryId.ts is built for it).
    const wave1 = entry({ shutdownDate: '2026-10-23' });
    const wave2 = entry({ shutdownDate: '2027-03-01' });
    const exposure = await computeExposure(dir, [wave1, wave2]);

    // Two exposures, soonest deadline first — the second is no longer dropped.
    expect(exposure.models).toHaveLength(2);
    expect(exposure.models.map((m) => m.shutdownDate)).toEqual(['2026-10-23', '2027-03-01']);
    expect(exposure.models.map((m) => m.entryId)).toEqual([
      'openai.gpt-4-0314.retirement-2026-10-23',
      'openai.gpt-4-0314.retirement-2027-03-01',
    ]);
    // BOTH records saw the SAME two physical occurrences (one live, one data):
    // the multimap emits a match per record, it does not split the occurrences.
    for (const m of exposure.models) {
      expect(m.id).toBe('gpt-4-0314');
      expect(m.occurrences).toBe(2);
      expect(m.liveOccurrences).toBe(1);
    }
  });
});
