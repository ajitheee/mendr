import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { canonicalizeId, familyOf } from './normalize.js';
import { classifyEntry, type VerificationOracles } from './verify.js';

// Pure-classifier tests. Oracle data is hand-built so every branch of the status
// rule is exercised hermetically — no network, no clock, no filesystem.

/** Build a liveIds set the way oracles.ts does: canonical + family per id. */
function liveSet(...ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const id of ids) {
    set.add(canonicalizeId(id));
    set.add(familyOf(id));
  }
  return set;
}

/** Official recommendation map with canonical keys (as oracles.ts builds it). */
function officialMap(entries: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [dep, rec] of Object.entries(entries)) map.set(canonicalizeId(dep), rec);
  return map;
}

function entry(deprecated: string, replacement: string): LlmModelIdDeprecation {
  return { provider: 'test', kind: 'model_id', deprecated, replacement };
}

describe('classifyEntry — VERIFIED', () => {
  const oracles: VerificationOracles = {
    liveIds: liveSet('claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-4o'),
    officialRecommendations: officialMap({
      'claude-3-opus-20240229': 'claude-opus-4-8',
      'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    }),
  };

  it('live + matches the official recommendation -> verified', () => {
    const r = classifyEntry(entry('claude-3-opus-20240229', 'claude-opus-4-8'), oracles);
    expect(r.status).toBe('verified');
    expect(r.reasons.join(' ')).toMatch(/officially-recommended/);
  });

  it('live + no official recommendation on record -> still verified', () => {
    // No entry for this deprecated id in the official map => nothing to contradict.
    const r = classifyEntry(entry('gpt-4-vision-preview', 'gpt-4o'), oracles);
    expect(r.status).toBe('verified');
  });

  it('a corrected sonnet entry (…-4-6) verifies where …-4-5 would be stale', () => {
    const r = classifyEntry(entry('claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'), oracles);
    expect(r.status).toBe('verified');
  });
});

describe('classifyEntry — UNVERIFIED (stale)', () => {
  const oracles: VerificationOracles = {
    // BOTH the stale target and the official target are live in the catalog…
    liveIds: liveSet('claude-sonnet-4-5', 'claude-sonnet-4-6', 'o1', 'o3'),
    officialRecommendations: officialMap({
      'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
      'o1-preview': 'o3',
    }),
  };

  it('sonnet-4-5 is live but the provider recommends sonnet-4-6 -> unverified (stale)', () => {
    const r = classifyEntry(entry('claude-3-5-sonnet-20241022', 'claude-sonnet-4-5'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/stale/);
    expect(r.reasons.join(' ')).toMatch(/claude-sonnet-4-6/);
  });

  it('o1-preview -> o1 is stale: official recommends o3', () => {
    const r = classifyEntry(entry('o1-preview', 'o1'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/o3/);
  });
});

describe('classifyEntry — UNVERIFIED (chained deprecation)', () => {
  const oracles: VerificationOracles = {
    liveIds: liveSet('gpt-3.5-turbo-instruct'),
    // The replacement is itself a KEY in the official table => it is deprecated.
    officialRecommendations: officialMap({ 'gpt-3.5-turbo-instruct': 'gpt-5.6-terra' }),
  };

  it('davinci -> gpt-3.5-turbo-instruct is chained even though the target is live', () => {
    const r = classifyEntry(entry('text-davinci-003', 'gpt-3.5-turbo-instruct'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/chained/);
  });
});

describe('classifyEntry — UNVERIFIABLE (out-of-class)', () => {
  const oracles: VerificationOracles = {
    liveIds: liveSet('gpt-4o'), // catalogs never list moderation models
    officialRecommendations: officialMap({}),
  };

  it('a moderation mapping is unverifiable, not wrong', () => {
    const r = classifyEntry(entry('text-moderation-latest', 'omni-moderation-latest'), oracles);
    expect(r.status).toBe('unverifiable');
    expect(r.reasons.join(' ')).toMatch(/moderation/);
    expect(r.reasons.join(' ')).toMatch(/NOT evidence/);
  });
});

describe('classifyEntry — UNVERIFIED (replacement not live)', () => {
  it('an in-class replacement absent from every catalog cannot be verified', () => {
    const oracles: VerificationOracles = {
      liveIds: liveSet('gpt-4o'),
      officialRecommendations: officialMap({}),
    };
    const r = classifyEntry(entry('gpt-4-0613', 'gpt-4-imaginary'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/not found live/);
  });
});
