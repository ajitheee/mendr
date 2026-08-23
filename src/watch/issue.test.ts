import { describe, it, expect } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { foldExposure, type Exposure, type ExposureMatch } from './exposure.js';
import {
  countdownLabel,
  nearestDeadlineDays,
  renderBadge,
  renderIssueBody,
  renderTextSummary,
  WATCH_CLEAR_MARKER,
  WATCH_MARKER,
} from './issue.js';

const NOW = new Date('2026-08-22T12:00:00Z');

function exposureOf(matches: ExposureMatch[]): Exposure {
  return { models: foldExposure(matches), filesScanned: 1, filesMatched: 1 };
}

function match(over: Partial<ExposureMatch>): ExposureMatch {
  return {
    value: 'gpt-4-0314',
    entry: {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0314',
      replacement: 'gpt-4.1',
      shutdownDate: '2026-10-23',
      status: 'deprecated',
    },
    file: 'src/app.ts',
    line: 1,
    position: 'model_arg',
    ...over,
  };
}

const EMPTY_REGISTRY: LlmRegistry = [];

describe('countdownLabel', () => {
  it('renders future, today, and past deadlines in words', () => {
    const [future] = foldExposure([match({})]);
    expect(countdownLabel(future, NOW)).toBe('62d left');
    const [today] = foldExposure([match({ entry: { ...match({}).entry, shutdownDate: '2026-08-22' } })]);
    expect(countdownLabel(today, NOW)).toBe('retires today');
    const [past] = foldExposure([match({ entry: { ...match({}).entry, shutdownDate: '2026-08-12' } })]);
    expect(countdownLabel(past, NOW)).toBe('retired 10d ago');
  });
  it('says unscheduled for an undated, non-retired entry', () => {
    const [undated] = foldExposure([
      match({ entry: { ...match({}).entry, shutdownDate: undefined, status: undefined } }),
    ]);
    expect(countdownLabel(undated, NOW)).toBe('unscheduled');
  });
});

describe('nearestDeadlineDays', () => {
  it('is the smallest days-until across dated models', () => {
    const models = foldExposure([
      match({ entry: { ...match({}).entry, deprecated: 'a', shutdownDate: '2026-12-01' }, value: 'a' }),
      match({ entry: { ...match({}).entry, deprecated: 'b', shutdownDate: '2026-09-01' }, value: 'b' }),
    ]);
    expect(nearestDeadlineDays(models, NOW)).toBe(10); // Aug 22 -> Sep 1
  });
});

describe('renderIssueBody', () => {
  it('carries the hidden marker and one row per exposed model', () => {
    const body = renderIssueBody(exposureOf([match({})]), EMPTY_REGISTRY, NOW);
    expect(body.startsWith(WATCH_MARKER)).toBe(true);
    expect(body).toContain('| Model | Provider | Retires | Countdown | In code | Fix |');
    expect(body).toContain('`gpt-4-0314`');
    expect(body).toContain('2026-10-23');
    expect(body).toContain('62d left');
  });

  it('marks a verified live model as auto-fix ready', () => {
    const verified: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4-0314',
        replacement: 'gpt-4.1',
        shutdownDate: '2026-10-23',
        status: 'deprecated',
        entryId: 'openai.gpt-4-0314.retirement-2026-10-23',
        verification: autoApplyVerification(),
      },
    ];
    const body = renderIssueBody(exposureOf([match({})]), verified, NOW);
    expect(body).toContain('auto-fix ready');
  });

  it('renders an all-clear body (both markers) when there is no exposure', () => {
    const body = renderIssueBody({ models: [], filesScanned: 5, filesMatched: 0 }, EMPTY_REGISTRY, NOW);
    expect(body).toContain(WATCH_MARKER);
    expect(body).toContain(WATCH_CLEAR_MARKER);
    expect(body).toContain('No **supported** deprecated model ids');
    expect(body).not.toContain('| Model |');
    // The all-clear trigger must name only what detection can fire on — a
    // registry change matching code — never a date passing (which never flips
    // a clean repo to exposed).
    expect(body).not.toMatch(/reaches a provider retirement date/);
    expect(body).toContain('matches a model id your code already uses');
  });

  it('an exposure body never carries the clear marker', () => {
    const body = renderIssueBody(exposureOf([match({})]), EMPTY_REGISTRY, NOW);
    expect(body).toContain(WATCH_MARKER);
    expect(body).not.toContain(WATCH_CLEAR_MARKER);
  });

  it('a live exposure is offered the verified diff', () => {
    const body = renderIssueBody(exposureOf([match({ position: 'model_arg' })]), EMPTY_REGISTRY, NOW);
    expect(body).toContain('See a proposed, verified diff');
  });

  it('a data-only exposure is NOT promised a diff (heads-up, not a fix)', () => {
    const body = renderIssueBody(exposureOf([match({ position: 'data' })]), EMPTY_REGISTRY, NOW);
    expect(body).toContain('data only');
    expect(body).not.toContain('See a proposed, verified diff');
    expect(body).toContain('nothing for');
    expect(body).toContain('heads-up, not a fix');
  });
});

describe('renderBadge', () => {
  it('encodes the nearest LIVE deadline into a static shields url', () => {
    const badge = renderBadge(exposureOf([match({})]), NOW);
    expect(badge).toContain('https://img.shields.io/badge/');
    expect(badge).toContain('next%2062d');
  });
  it('says no deprecations when clear', () => {
    const badge = renderBadge({ models: [], filesScanned: 1, filesMatched: 0 }, NOW);
    expect(badge).toContain('no%20deprecations');
    expect(badge).toContain('brightgreen');
  });
  it('a data-only reference to a retired id is NOT alarmed as overdue', () => {
    // Retired 10 days ago, but only as data (a pricing-table key): blue, not red.
    const dataOnly = renderBadge(
      exposureOf([match({ entry: { ...match({}).entry, shutdownDate: '2026-08-12' }, position: 'data' })]),
      NOW,
    );
    expect(dataOnly).toContain('data%20only');
    expect(dataOnly.endsWith('-blue)')).toBe(true);
    expect(dataOnly).not.toContain('overdue');
  });
  it('a LIVE call past its date IS alarmed red as overdue', () => {
    const liveOverdue = renderBadge(
      exposureOf([match({ entry: { ...match({}).entry, shutdownDate: '2026-08-12' }, position: 'model_arg' })]),
      NOW,
    );
    expect(liveOverdue).toContain('retirement%20overdue');
    expect(liveOverdue.endsWith('-red)')).toBe(true);
  });
});

describe('renderTextSummary', () => {
  it('lists the migration for each exposed model', () => {
    const summary = renderTextSummary(exposureOf([match({})]), EMPTY_REGISTRY, NOW);
    expect(summary).toContain('gpt-4-0314');
    expect(summary).toContain('gpt-4.1');
    expect(summary).toContain('62d left');
  });
  it('says clear when there is nothing to watch', () => {
    const summary = renderTextSummary({ models: [], filesScanned: 1, filesMatched: 0 }, EMPTY_REGISTRY, NOW);
    expect(summary).toContain('no supported deprecated model ids');
  });
});

describe('false-all-clear coverage (a clean result names what was checked)', () => {
  const REG: LlmRegistry = [
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0314',
      replacement: 'gpt-4.1',
      shutdownDate: '2026-10-23',
      status: 'deprecated',
      verification: autoApplyVerification(),
    },
    {
      provider: 'anthropic',
      kind: 'model_id',
      deprecated: 'claude-3-opus-20240229',
      replacement: 'claude-opus-4-8',
      status: 'retired',
    },
  ];
  const CLEAN = { models: [], filesScanned: 3, filesMatched: 0 };

  it('the human no-exposure summary states coverage, not a bare "clean"', () => {
    const s = renderTextSummary(CLEAN, REG, NOW);
    expect(s).toContain('no supported deprecated model ids');
    expect(s).toContain('Coverage:');
    expect(s).toContain('JavaScript-only');
    expect(s).toContain('OpenAI');
    expect(s).toContain('Anthropic');
    expect(s).toContain('2 records'); // registryProvenance over the two entries
    expect(s).toContain('1 auto-fix eligible'); // only the verified one
  });

  it('the all-clear issue body states scope so unsupported code is not read as safe', () => {
    const b = renderIssueBody(CLEAN, REG, NOW);
    expect(b).toContain('No **supported** deprecated model ids');
    expect(b).toContain('JavaScript-only code is not scanned');
    expect(b).toContain('OpenAI');
    expect(b).toContain('registry 2 records');
    // Still an all-clear body: both markers, no exposure table.
    expect(b).toContain(WATCH_CLEAR_MARKER);
    expect(b).not.toContain('| Model |');
  });
});
