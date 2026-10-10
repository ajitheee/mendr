import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { canonicalizeId, familyOf } from './normalize.js';
import { loadLlmRegistry, resolveRegistryPath } from '../usage/llmRegistry.js';
import { officialRecommendations } from './oracles.js';
import {
  classifyEntry,
  isMachineReason,
  knownDeprecatedFrom,
  mergeReasons,
  namedReplacements,
  verificationSwitches,
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

// THE REGISTRY'S OWN EVIDENCE. The chained check consulted only the hand-curated
// officialRecommendations table, whose `google` section in oracles.ts is `{}`. So a mapping
// into an id THIS REGISTRY already marks retired passed as verified. On 2026-09-14 a discovery
// pass staged five such rows, including gemini-2.5-flash-image -> gemini-3.1-flash-image-preview,
// which the same file records as retired 81 days earlier. Promoting one would have made Mendr
// propose swapping working code to a model that already returns 404, under a verified label.
describe("classifyEntry — chained on the registry's own evidence", () => {
  const live = liveSet('good-model', 'dead-target');

  it('refuses a replacement this registry records as deprecated, even when the oracle table is empty', () => {
    const oracles: VerificationOracles = {
      liveIds: live,
      officialRecommendations: officialMap({}),
      knownDeprecated: knownDeprecatedFrom([
        { kind: 'model_id', deprecated: 'dead-target', status: 'retired', shutdownDate: '2026-06-25' },
      ]),
    };
    const r = classifyEntry(entry('old-model', 'dead-target'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toContain('ITSELF deprecated in this registry');
    expect(r.reasons.join(' ')).toContain('2026-06-25');
  });

  it('still verifies a replacement the registry knows nothing about', () => {
    const oracles: VerificationOracles = {
      liveIds: live,
      officialRecommendations: officialMap({}),
      knownDeprecated: knownDeprecatedFrom([
        { kind: 'model_id', deprecated: 'some-other-id', status: 'retired', shutdownDate: '2026-01-01' },
      ]),
    };
    expect(classifyEntry(entry('old-model', 'good-model'), oracles).status).toBe('verified');
  });

  // DOWNGRADE-ONLY is the property that makes it safe to derive this from data of uncertain
  // quality: the worst outcome of a wrong signal is a refusal, never a wrong edit.
  it('is downgrade-only — it can never turn a non-verified entry into a verified one', () => {
    const base: VerificationOracles = { liveIds: liveSet('good-model'), officialRecommendations: officialMap({}) };
    const withKnowledge: VerificationOracles = {
      ...base,
      knownDeprecated: knownDeprecatedFrom([
        { kind: 'model_id', deprecated: 'good-model', status: 'deprecated', shutdownDate: '2027-01-01' },
      ]),
    };
    // absent from every catalog: unverified with or without the extra knowledge
    expect(classifyEntry(entry('old-model', 'ghost-model'), base).status).toBe('unverified');
    expect(classifyEntry(entry('old-model', 'ghost-model'), withKnowledge).status).toBe('unverified');
    // and knowledge can only take a verified entry DOWN
    expect(classifyEntry(entry('old-model', 'good-model'), base).status).toBe('verified');
    expect(classifyEntry(entry('old-model', 'good-model'), withKnowledge).status).toBe('unverified');
  });

  it('knownDeprecatedFrom ignores non-model entries and lets the registry win over a candidate', () => {
    const m = knownDeprecatedFrom([
      { kind: 'param_removal', deprecated: 'temperature', status: 'deprecated' },
      { kind: 'model_id', deprecated: 'x-model', status: 'retired', shutdownDate: '2026-01-01' },
      { kind: 'model_id', deprecated: 'x-model', status: 'deprecated', shutdownDate: '2027-01-01' },
    ]);
    expect(m.has(canonicalizeId('temperature'))).toBe(false);
    expect(m.get(canonicalizeId('x-model'))).toContain('retired');
  });
});

// --- one of several named replacements --------------------------------------
//
// OpenAI's 2026-03-26 rows name "gpt-5 or gpt-4.1*", footnoted "*For tasks that are especially
// latency sensitive and don't require reasoning". On 2026-10-10 gpt-4-0314 was switched on
// with gpt-5.6-sol (gpt-5's chain) and gpt-4-0125-preview with gpt-4.1: one row resolved two
// ways, both auto-appliable, because the curated table had no row and so nothing contradicted
// either. Which target fits depends on the call, which no catalog can see.
describe('namedReplacements', () => {
  it('reads one id, an "or" pair, and a comma list with a final "or"', () => {
    expect(namedReplacements('claude-opus-4-8')).toEqual(['claude-opus-4-8']);
    expect(namedReplacements('gpt-5 or gpt-4.1*')).toEqual(['gpt-5', 'gpt-4.1']);
    expect(namedReplacements('gpt-image-2, gpt-image-1, or gpt-image-1-mini')).toEqual([
      'gpt-image-2',
      'gpt-image-1',
      'gpt-image-1-mini',
    ]);
  });
});

describe('classifyEntry — UNVERIFIED (the provider names more than one replacement)', () => {
  const oracles: VerificationOracles = {
    liveIds: liveSet('gpt-5', 'gpt-4.1', 'gpt-5.6-sol'),
    officialRecommendations: officialMap({
      'gpt-4-0314': 'gpt-5 or gpt-4.1',
      'gpt-4-0125-preview': 'gpt-5 or gpt-4.1',
    }),
  };

  it('holds whichever named target the registry carries, and the end of either chain', () => {
    for (const [deprecated, replacement] of [
      ['gpt-4-0125-preview', 'gpt-4.1'],
      ['gpt-4-0125-preview', 'gpt-5'],
      ['gpt-4-0314', 'gpt-5.6-sol'],
    ]) {
      const r = classifyEntry(entry(deprecated, replacement), oracles);
      expect(r.status, `${deprecated} -> ${replacement}`).toBe('unverified');
      expect(r.reasons.join(' ')).toContain(
        'the provider names more than one replacement ("gpt-5 or gpt-4.1")',
      );
      // It is a choice, not a stale target: the reason must not call it one.
      expect(r.reasons.join(' ')).not.toMatch(/stale/);
    }
  });

  it('still says so when the carried target is not live', () => {
    const r = classifyEntry(entry('gpt-4-0314', 'gpt-9-ghost'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toContain('more than one replacement');
  });
});

// --- a replacement that changes the model family ----------------------------
//
// Discovery and check-dates admit OpenAI `ft-` rows and Google `veo-` rows. The fine-tune ->
// base model swap drops the customer's training; Veo -> Gemini Omni is a different family
// behind a different request. Both were guarded only by quarantines written on the nine rows
// that existed on 2026-10-10, and `candidates promote` would have written the next one verified.
describe('classifyEntry — UNVERIFIED (family change), whatever the catalogs say', () => {
  const oracles: VerificationOracles = {
    liveIds: liveSet('gpt-5.6-sol', 'gemini-omni-1.1-flash', 'veo-3.2-generate'),
    officialRecommendations: officialMap({}),
  };

  it('never verifies a fine-tune retired to a base model', () => {
    for (const deprecated of ['ft-gpt-4o-2024-08-06', 'ft-babbage-002', 'ft:gpt-4o-2024-08-06:acme::x1']) {
      const r = classifyEntry(entry(deprecated, 'gpt-5.6-sol'), oracles);
      expect(r.status, deprecated).toBe('unverified');
      expect(r.reasons.join(' ')).toContain("drops the customer's training");
    }
  });

  it('never verifies a Veo model retired to a non-Veo model', () => {
    const r = classifyEntry(entry('veo-3.0-generate-001', 'gemini-omni-1.1-flash'), oracles);
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toContain('different model family behind a different request');
  });

  it('leaves a Veo -> Veo swap to the ordinary catalog check', () => {
    expect(classifyEntry(entry('veo-3.0-generate-001', 'veo-3.2-generate'), oracles).status).toBe(
      'verified',
    );
  });

  it('keeps auto-apply off through verificationSwitches, as candidates promote derives it', () => {
    const e: LlmModelIdDeprecation = {
      ...entry('ft-gpt-4o-2024-08-06', 'gpt-5.6-sol'),
      sourceUrl: 'https://developers.openai.com/api/docs/deprecations',
      status: 'deprecated',
      shutdownDate: '2026-10-23',
    };
    const { status } = classifyEntry(e, oracles);
    expect(verificationSwitches(e, status).autoApplyAllowed).toBe(false);
  });
});

describe("mergeReasons — the new verdicts are the machine's own", () => {
  it('recognises the choice and family-change sentences, so a re-stamp regenerates them', () => {
    const oracles: VerificationOracles = {
      liveIds: liveSet('gpt-5.6-sol', 'gemini-omni-1.1-flash'),
      officialRecommendations: officialMap({ 'gpt-4-0314': 'gpt-5 or gpt-4.1' }),
    };
    const cases = [
      entry('gpt-4-0314', 'gpt-5.6-sol'),
      entry('gpt-4-0314', 'ghost-9'),
      entry('ft-gpt-4', 'gpt-5.6-sol'),
      entry('veo-3.1-generate-preview', 'gemini-omni-1.1-flash'),
    ];
    for (const e of cases) {
      for (const reason of classifyEntry(e, oracles).reasons) {
        expect(isMachineReason(reason), reason).toBe(true);
      }
    }
  });
});

// --- the gate, not a hand edit, decides the shipped stamps -------------------
//
// The weekly registry-verify job fails when a record shipped `verified` no longer classifies
// verified, and it can only catch what the classifier knows. This is that check offline, with
// every replacement assumed live, the most generous answer the catalogs could give. On
// 2026-10-10 nine records were stamped verified by hand against provider rows the curated
// table did not carry; with the rows in the table, this test refuses that edit.
describe('the shipped registry, against the curated table', () => {
  const shipped = loadLlmRegistry(resolveRegistryPath()).filter(
    (e): e is LlmModelIdDeprecation => e.kind === 'model_id',
  );
  const generous: VerificationOracles = {
    liveIds: liveSet(...shipped.map((e) => e.replacement)),
    officialRecommendations: officialRecommendations(),
    knownDeprecated: knownDeprecatedFrom(shipped),
  };

  it('stamps nothing verified that the classifier would hold, even with every replacement live', () => {
    const contradicted = shipped
      .filter((e) => e.verification?.status === 'verified')
      .filter((e) => classifyEntry(e, generous).status !== 'verified')
      .map((e) => `${e.deprecated} -> ${e.replacement}: ${classifyEntry(e, generous).reasons.join('; ')}`);
    expect(contradicted).toEqual([]);
  });

  it('holds every record whose provider row names two targets or a dated one', () => {
    for (const id of [
      'gpt-4-0314',
      'gpt-4-0125-preview',
      'gpt-4-turbo-preview',
      'gpt-3.5-turbo-0301',
      'gpt-3.5-turbo-0613',
      'gpt-3.5-turbo-16k-0613',
      'text-davinci-003',
      'text-davinci-002',
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash-lite-001',
    ]) {
      const record = shipped.find((e) => e.deprecated === id);
      expect(record, id).toBeTruthy();
      expect(record!.verification?.autoApplyAllowed, id).toBe(false);
      expect(classifyEntry(record!, generous).status, id).toBe('unverified');
    }
  });
});
