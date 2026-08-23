import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { foldExposure, type Exposure, type ExposureMatch } from './exposure.js';
import {
  countdownLabel,
  renderBadge,
  renderIssueBody,
  renderTextSummary,
  WATCH_CLEAR_MARKER,
  WATCH_MARKER,
} from './issue.js';

const NOW = new Date('2026-08-22T12:00:00Z');
const EMPTY_REGISTRY: LlmRegistry = [];

function entry(over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4',
    replacement: 'gpt-5.6-sol',
    shutdownDate: '2026-10-23',
    status: 'deprecated',
    ...over,
  };
}

function match(over: Partial<ExposureMatch> = {}): ExposureMatch {
  return {
    value: over.entry?.deprecated ?? 'gpt-4',
    entry: entry(),
    file: 'src/app.ts',
    line: 1,
    column: 1,
    tier: 'C',
    ...over,
  };
}

function exposureOf(matches: ExposureMatch[]): Exposure {
  return { models: foldExposure(matches), filesScanned: 1, filesMatched: 1 };
}

const EMPTY: Exposure = { models: [], filesScanned: 5, filesMatched: 0 };

describe('countdownLabel', () => {
  it('renders future / today / past / unscheduled', () => {
    const [future] = foldExposure([match({})]);
    expect(countdownLabel(future, NOW)).toBe('62d left');
    const [today] = foldExposure([match({ entry: entry({ shutdownDate: '2026-08-22' }) })]);
    expect(countdownLabel(today, NOW)).toBe('retires today');
    const [past] = foldExposure([match({ entry: entry({ shutdownDate: '2026-08-12' }) })]);
    expect(countdownLabel(past, NOW)).toBe('retired 10d ago');
    const [undated] = foldExposure([
      match({ entry: entry({ shutdownDate: undefined, status: undefined }) }),
    ]);
    expect(countdownLabel(undated, NOW)).toBe('unscheduled');
  });
});

describe('renderIssueBody', () => {
  it('carries the marker and a model + occurrence count header, risk-first', () => {
    const body = renderIssueBody(exposureOf([match({ tier: 'B', reason: 'usage_unverified' })]), EMPTY_REGISTRY, NOW);
    expect(body.startsWith(WATCH_MARKER)).toBe(true);
    expect(body).toContain('**1** deprecated model id, **1** unique occurrence.');
    expect(body).toContain('Highest risk first, then nearest deadline.');
  });

  it('groups review-required models and lists their per-tier occurrences with locations', () => {
    const body = renderIssueBody(
      exposureOf([
        match({ file: 'agent_app/simulator.py', line: 166, tier: 'B', reason: 'usage_unverified' }),
        match({ file: 'agent_app/simulator.py', line: 12, tier: 'C' }),
      ]),
      EMPTY_REGISTRY,
      NOW,
    );
    expect(body).toContain('#### Review required');
    expect(body).toContain('**`gpt-4`** → `gpt-5.6-sol`');
    expect(body).toContain('Tier B: 1 usage-unverified occurrence at agent_app/simulator.py:166');
    expect(body).toContain('Tier C: 1 data occurrence at agent_app/simulator.py:12');
    expect(body).not.toContain('data only');
  });

  it('puts a Tier-C-only model under Informational, not Review required', () => {
    const body = renderIssueBody(
      exposureOf([
        match({ entry: entry({ deprecated: 'gemini-1.5-pro' }), value: 'gemini-1.5-pro', file: 'a.py', line: 30, tier: 'C' }),
        match({ entry: entry({ deprecated: 'gemini-1.5-pro' }), value: 'gemini-1.5-pro', file: 'a.py', line: 127, tier: 'C' }),
      ]),
      EMPTY_REGISTRY,
      NOW,
    );
    expect(body).toContain('#### Informational');
    expect(body).not.toContain('#### Review required');
    expect(body).toContain('Tier C: 2 data occurrences at a.py:30,127');
  });

  it('CTA: Tier A -> verified diff; Tier B only -> shows review rows; data only -> heads-up', () => {
    const a = renderIssueBody(exposureOf([match({ tier: 'A' })]), EMPTY_REGISTRY, NOW);
    expect(a).toContain('See a proposed, verified diff');
    const b = renderIssueBody(exposureOf([match({ tier: 'B', reason: 'usage_unverified' })]), EMPTY_REGISTRY, NOW);
    expect(b).toContain('shows the Tier B review rows');
    expect(b).not.toContain('See a proposed, verified diff');
    const c = renderIssueBody(exposureOf([match({ tier: 'C' })]), EMPTY_REGISTRY, NOW);
    expect(c).toContain('heads-up, not a fix');
  });

  it('renders an all-clear body (both markers + coverage) when there is no exposure', () => {
    const body = renderIssueBody(EMPTY, EMPTY_REGISTRY, NOW);
    expect(body).toContain(WATCH_MARKER);
    expect(body).toContain(WATCH_CLEAR_MARKER);
    expect(body).toContain('No **supported** deprecated model ids');
    expect(body).toContain('JavaScript-only code is not scanned');
    expect(body).not.toContain('#### Review required');
  });

  it('an exposure body never carries the clear marker', () => {
    const body = renderIssueBody(exposureOf([match({ tier: 'B', reason: 'usage_unverified' })]), EMPTY_REGISTRY, NOW);
    expect(body).not.toContain(WATCH_CLEAR_MARKER);
  });
});

describe('renderBadge', () => {
  it('counts models by highest classification: review vs informational', () => {
    const badge = renderBadge(
      exposureOf([
        match({ tier: 'B', reason: 'usage_unverified' }),
        match({ entry: entry({ deprecated: 'x', shutdownDate: '2027-01-01' }), value: 'x', tier: 'C' }),
      ]),
      NOW,
    );
    expect(badge).toContain('1%20review%20%C2%B7%201%20informational');
  });
  it('no deprecations is green', () => {
    const badge = renderBadge(EMPTY, NOW);
    expect(badge).toContain('no%20deprecations');
    expect(badge).toContain('brightgreen');
  });
  it('a review model past its date is red; a data-only-overdue model is not', () => {
    const red = renderBadge(
      exposureOf([match({ entry: entry({ shutdownDate: '2026-08-12' }), tier: 'B', reason: 'usage_unverified' })]),
      NOW,
    );
    expect(red.endsWith('-red)')).toBe(true);
    const notRed = renderBadge(
      exposureOf([match({ entry: entry({ shutdownDate: '2026-08-12' }), tier: 'C' })]),
      NOW,
    );
    expect(notRed.endsWith('-red)')).toBe(false); // informational, even though overdue
  });
});

describe('renderTextSummary', () => {
  it('groups REVIEW REQUIRED and INFORMATIONAL with per-tier detail', () => {
    const summary = renderTextSummary(
      exposureOf([
        match({ file: 'agent_app/simulator.py', line: 166, tier: 'B', reason: 'usage_unverified' }),
        match({ file: 'agent_app/simulator.py', line: 12, tier: 'C' }),
      ]),
      EMPTY_REGISTRY,
      NOW,
    );
    expect(summary).toContain('2 unique occurrences');
    expect(summary).toContain('REVIEW REQUIRED');
    expect(summary).toContain('gpt-4 -> gpt-5.6-sol');
    expect(summary).toContain('Tier B: 1 usage-unverified occurrence at agent_app/simulator.py:166');
    expect(summary).toContain('Tier C: 1 data occurrence at agent_app/simulator.py:12');
  });
  it('says clear (with coverage) when there is nothing to watch', () => {
    const summary = renderTextSummary(EMPTY, EMPTY_REGISTRY, NOW);
    expect(summary).toContain('no supported deprecated model ids');
    expect(summary).toContain('Coverage:');
  });
});
