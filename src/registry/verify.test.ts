import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { canonicalizeId, familyOf } from './normalize.js';
import {
  classifyEntry,
  isMachineReason,
  mergeReasons,
  type VerificationOracles,
} from './verify.js';

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


// --- re-stamping must not erase the humans ----------------------------------
//
// `verify-registry --write` overwrites each entry's `verification` block. Every
// reason in the shipped registry is hand-written research, and some of it is a
// CAVEAT ("status unknown -- do not auto-apply") that is the only thing holding
// a mis-stamped entry out of Tier A. A recheck that quietly deleted those would
// promote exactly the entries the gate exists to catch — the destructive edit
// dressed up as routine maintenance.
describe('mergeReasons', () => {
  const machine = [
    'replacement "gpt-5.6-sol" is live in a public catalog',
    'matches the provider\'s officially-recommended replacement "gpt-5.6-sol"',
  ];
  const human = [
    'Confirmed retired 2024-09-13 (via gpt-3.5-turbo-16k research note).',
    'Status unknown; do not auto-apply until verified.',
  ];

  it('keeps every hand-written reason, verbatim and in order', () => {
    expect(mergeReasons(machine, human)).toEqual([...machine, ...human]);
  });

  it('replaces the machine\'s PREVIOUS verdict rather than stacking it', () => {
    const stale = ['replacement "gpt-4" was not found live in any public catalog (models.dev / OpenRouter)'];
    expect(mergeReasons(machine, [...stale, ...human])).toEqual([...machine, ...human]);
  });

  it('is idempotent, so a daily recheck never grows the list', () => {
    const once = mergeReasons(machine, human);
    expect(mergeReasons(machine, once)).toEqual(once);
  });

  it('recognises each sentence classifyEntry can emit as the machine\'s own', () => {
    // Driven from the classifier itself: every reason it produces on every
    // branch must be recognised, or a re-stamp would carry it forward as if a
    // person had written it.
    const oracles: VerificationOracles = {
      liveIds: liveSet('gpt-5.6-sol', 'gpt-4o'),
      officialRecommendations: officialMap({ 'gpt-4-0613': 'gpt-5.6-sol', 'gpt-4-32k': 'gpt-4o' }),
    };
    const cases: LlmModelIdDeprecation[] = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'gpt-5.6-sol' },
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'gpt-4o' },
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'ghost-9' },
      { provider: 'openai', kind: 'model_id', deprecated: 'dall-e-3', replacement: 'gpt-image-2' },
      { provider: 'openai', kind: 'model_id', deprecated: 'o1-preview', replacement: 'gpt-4-32k' },
    ];
    for (const entry of cases) {
      for (const reason of classifyEntry(entry, oracles).reasons) {
        expect(isMachineReason(reason), reason).toBe(true);
      }
    }
  });

  it('never mistakes a human caveat for machine output', () => {
    for (const reason of human) expect(isMachineReason(reason), reason).toBe(false);
  });
});
