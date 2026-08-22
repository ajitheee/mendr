import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { EVIDENCE_EXCERPT_MAX_CHARS } from '../types.js';
import {
  autoApplyVerification,
  effectiveVerificationState,
  hasSelfContradictingReasons,
  isVerified,
  loadLlmRegistry,
  modelIdEntries,
  registryProvenance,
  resolveRegistryPath,
  selfContradictionMarkersIn,
  staleRegistryWarning,
  withheldSwitches,
  withheldVerification,
  SELF_CONTRADICTION_MARKERS,
} from './llmRegistry.js';
import type { LlmModelIdDeprecation, VerificationInfo } from '../types.js';

// The freshness guard: model catalogs churn monthly, so fix-llm warns when the
// registry's NEWEST verification stamp is more than 30 days behind "now". The
// NEWEST stamp is the right anchor — one recently re-verified entry proves the
// verification pipeline ran recently, which is what freshness means here.

function entry(checkedAt?: string): LlmRegistry[number] {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-4',
    verification: checkedAt ? { status: 'verified', checkedAt } : { status: 'verified' },
  };
}

describe('staleRegistryWarning', () => {
  it('warns when the newest checkedAt is older than 30 days', () => {
    const registry: LlmRegistry = [entry('2026-01-01'), entry('2026-02-01')];
    const warning = staleRegistryWarning(registry, new Date('2026-04-01T00:00:00Z'));
    // The NEWEST stamp is named, not the oldest.
    expect(warning).toBe(
      'warning: registry last rechecked 2026-02-01 -- run mendr verify-registry for current data.',
    );
  });

  it('stays quiet when any stamp is within 30 days', () => {
    const registry: LlmRegistry = [entry('2026-01-01'), entry('2026-03-20')];
    expect(staleRegistryWarning(registry, new Date('2026-04-01T00:00:00Z'))).toBeUndefined();
  });

  it('stays quiet for a registry with no checkedAt stamps at all', () => {
    // Unstamped entries are already blocked per-entry by the engine gate;
    // a global staleness warning would add noise, not information.
    expect(staleRegistryWarning([entry()], new Date('2030-01-01T00:00:00Z'))).toBeUndefined();
  });
});

// --- evidence parsing ------------------------------------------------------
// Evidence is the audit trail a reviewer trusts, so the loader treats a
// malformed block exactly like a malformed `verification` block: a HARD error.
// A half-parsed EvidenceRef would let a broken hash read as provenance.

const VALID_EVIDENCE = {
  sourceUrl: 'https://example.test/deprecations',
  contentHash: `sha256:${'a'.repeat(64)}`,
  retrievedAt: '2026-08-20T12:00:00.000Z',
  excerpt: 'October 23, 2026 | gpt-4-0613 | gpt-5.6-sol',
};

/** Write a one-entry registry to a temp file and return its path. */
function registryFile(evidence?: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mendr-registry-')), 'llm-deprecations.json');
  writeFileSync(
    path,
    JSON.stringify([
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4-0613',
        replacement: 'gpt-5.6-sol',
        ...(evidence === undefined ? {} : { evidence }),
      },
    ]),
  );
  return path;
}

describe('loadLlmRegistry — evidence', () => {
  it('parses a well-formed evidence array', () => {
    const [loaded] = modelIdEntries(loadLlmRegistry(registryFile([VALID_EVIDENCE])));
    expect(loaded.evidence).toEqual([VALID_EVIDENCE]);
  });

  it('leaves evidence undefined on a hand-seeded entry', () => {
    const [loaded] = modelIdEntries(loadLlmRegistry(registryFile()));
    expect(loaded.evidence).toBeUndefined();
  });

  it('HARD-errors on a non-array evidence', () => {
    expect(() => loadLlmRegistry(registryFile({}))).toThrow(/non-array "evidence"/);
  });

  it('HARD-errors on an empty evidence array', () => {
    expect(() => loadLlmRegistry(registryFile([]))).toThrow(/empty "evidence"/);
  });

  it('HARD-errors on a missing sourceUrl', () => {
    const { sourceUrl: _drop, ...rest } = VALID_EVIDENCE;
    expect(() => loadLlmRegistry(registryFile([rest]))).toThrow(/sourceUrl/);
  });

  it('HARD-errors on a contentHash that is not sha256:<64 hex>', () => {
    for (const bad of ['deadbeef', 'sha256:xyz', `sha1:${'a'.repeat(40)}`, `sha256:${'A'.repeat(64)}`]) {
      expect(() => loadLlmRegistry(registryFile([{ ...VALID_EVIDENCE, contentHash: bad }]))).toThrow(
        /malformed contentHash/,
      );
    }
  });

  it('HARD-errors on an over-long excerpt (a quote, not a copy of the page)', () => {
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX_CHARS + 1);
    expect(() => loadLlmRegistry(registryFile([{ ...VALID_EVIDENCE, excerpt }]))).toThrow(
      /excerpt of 241 chars/,
    );
  });

  it('accepts an excerpt exactly at the limit', () => {
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX_CHARS);
    const [loaded] = modelIdEntries(loadLlmRegistry(registryFile([{ ...VALID_EVIDENCE, excerpt }])));
    expect(loaded.evidence?.[0].excerpt).toBe(excerpt);
  });
});


// --- the engine gate: structured fields, never prose -----------------------
//
// THE DEFECT THIS EXISTS FOR, verbatim from the shipped registry:
//
//   "deprecated": "gemini-2.0-flash",
//   "replacement": "gemini-flash-latest",
//   "verification": { "status": "verified", "reasons": [
//     "... Status unknown; likely retired given the rest of the 2.0 line but
//      unverified -- DO NOT AUTO-APPLY. Target gemini-flash-latest is a rolling
//      alias currently resolving to gemini-3-flash-preview, which is itself
//      deprecated." ] }
//
// The stamp said Tier A. The sentence under the stamp said do not touch this.
// The stamp won, and the swap was auto-applied to user code.
//
// The FIRST fix regex-matched those sentences at gate time. It held the twelve
// records and left the mechanism broken: a safety decision computed from prose
// changes when somebody rewords a caveat. The gate now reads four booleans, the
// twelve records are `quarantined` IN THE DATA, and the marker list survives
// only as a CI lint. These tests hold that line from both directions -- the
// booleans decide, and the prose decides nothing.

/** A model_id entry carrying exactly the verification block under test. */
function entryWith(verification: VerificationInfo): LlmModelIdDeprecation {
  return {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-3.6-flash',
    verification,
  };
}

describe('isVerified (the engine gate)', () => {
  it('passes ONLY on the full four-field conjunction', () => {
    expect(isVerified(entryWith(autoApplyVerification()))).toBe(true);
  });

  it.each([
    ['officialSourceConfirmed', { officialSourceConfirmed: false }],
    ['replacementConfirmed', { replacementConfirmed: false }],
    ['autoApplyAllowed', { autoApplyAllowed: false }],
  ] as const)('is held back when %s is false, whatever the stamp says', (_field, override) => {
    const entry = entryWith(autoApplyVerification(override));
    expect(entry.verification!.status).toBe('verified');
    expect(isVerified(entry)).toBe(false);
    // Reported as `withheld`, NOT as `unverified`: the file really does say
    // `verified`, and a reader who runs `mendr evidence <id>` must not find the
    // two disagreeing.
    expect(effectiveVerificationState(entry)).toBe('withheld');
  });

  it('names the switches that are off, as field names rather than quoted prose', () => {
    const entry = entryWith(
      autoApplyVerification({ replacementConfirmed: false, autoApplyAllowed: false }),
    );
    expect(withheldSwitches(entry)).toEqual(['replacementConfirmed', 'autoApplyAllowed']);
  });

  it.each(['quarantined', 'unverified', 'unverifiable'] as const)(
    'never passes a %s record',
    (status) => {
      const entry = entryWith(withheldVerification(status));
      expect(isVerified(entry)).toBe(false);
      expect(effectiveVerificationState(entry)).toBe(status);
    },
  );

  it('never passes an unstamped record -- a missing block is not a licence to swap', () => {
    const bare: LlmModelIdDeprecation = {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0613',
      replacement: 'gpt-5.6-sol',
    };
    expect(isVerified(bare)).toBe(false);
    expect(effectiveVerificationState(bare)).toBe('unstamped');
  });

  it('IGNORES the reasons entirely -- rewording a caveat cannot change the gate', () => {
    // THE WHOLE POINT. Two records identical but for their prose: one carrying
    // every marker the old regex looked for, one carrying none. The gate gives
    // the same answer, because it never reads either.
    const caveats = entryWith(
      autoApplyVerification({
        reasons: ['Status unknown; DO NOT AUTO-APPLY -- the target is itself deprecated, stale.'],
      }),
    );
    const clean = entryWith(
      autoApplyVerification({ reasons: ['replacement is live in a public catalog'] }),
    );
    expect(isVerified(caveats)).toBe(true);
    expect(isVerified(clean)).toBe(true);
    // ...and dropping the caveat from a HELD record does not release it either.
    const held = entryWith(withheldVerification('quarantined', { reasons: [] }));
    expect(isVerified(held)).toBe(false);
  });
});

// The marker list still exists, and still only for the CI validator. These
// tests pin what it recognises; validateRegistry.test.ts pins what it is FOR.
describe('hasSelfContradictingReasons (the CI lint)', () => {
  it('fires on every documented marker, whatever the case', () => {
    for (const marker of SELF_CONTRADICTION_MARKERS) {
      const entry = entryWith(
        autoApplyVerification({ reasons: [`Provider-named. ${marker.toUpperCase()} here.`] }),
      );
      expect(hasSelfContradictingReasons(entry), marker).toBe(true);
      expect(selfContradictionMarkersIn(entry.verification!.reasons), marker).toContain(marker);
    }
  });

  it('stays quiet for the sentences the classifier itself writes', () => {
    // A genuinely clean re-stamp produces only these; if either ever tripped
    // the lint, every verified record in the registry would fail CI.
    const entry = entryWith(
      autoApplyVerification({
        reasons: [
          'replacement "gpt-5.6-sol" is live in a public catalog',
          "matches the provider's officially-recommended replacement \"gpt-5.6-sol\"",
        ],
      }),
    );
    expect(hasSelfContradictingReasons(entry)).toBe(false);
  });

  it('asks about the TEXT, so an already-unverified record answers honestly too', () => {
    const entry = entryWith(withheldVerification('unverified', { reasons: ['status unknown'] }));
    expect(hasSelfContradictingReasons(entry)).toBe(true);
    // ...and the state is still just the stamp. The lint reports; it does not
    // reclassify.
    expect(effectiveVerificationState(entry)).toBe('unverified');
  });

  it('treats a record with no reasons at all as unlinted, not contradictory', () => {
    expect(hasSelfContradictingReasons(entryWith(autoApplyVerification()))).toBe(false);
  });
});

// THE SHIPPED REGISTRY, not a fixture. The twelve records the audit named must
// be held back for real, in the file that actually ships -- and held back by
// their STATUS, so the hold survives someone tidying the prose.
describe('the shipped registry', () => {
  it('quarantines the twelve records whose research contradicts a verified stamp', () => {
    const entries = modelIdEntries(loadLlmRegistry(resolveRegistryPath()));
    const quarantined = entries.filter((e) => e.verification?.status === 'quarantined');
    expect(quarantined).toHaveLength(12);
    for (const entry of quarantined) {
      expect(isVerified(entry), entry.deprecated).toBe(false);
      // Every quarantine says what has to be resolved. A hold nobody can act
      // on is a hold that never gets lifted.
      expect(entry.verification!.quarantineReason, entry.deprecated).toBeTruthy();
    }
  });

  it('leaves no auto-appliable record carrying a caveat in its reasons', () => {
    // The invariant the old regex gate enforced at RUNTIME, now a property of
    // the data itself: nothing that ships is both switched on and warned about.
    const entries = modelIdEntries(loadLlmRegistry(resolveRegistryPath()));
    for (const entry of entries) {
      if (!hasSelfContradictingReasons(entry)) continue;
      expect(entry.verification?.autoApplyAllowed ?? false, entry.deprecated).toBe(false);
      expect(isVerified(entry), entry.deprecated).toBe(false);
    }
  });

  it('holds back gemini-2.0-flash, and points it at a stable id rather than an alias', () => {
    const entries = modelIdEntries(loadLlmRegistry(resolveRegistryPath()));
    for (const id of ['gemini-2.0-flash', 'gemini-2.0-flash-001']) {
      const entry = entries.find((e) => e.deprecated === id)!;
      expect(entry, id).toBeTruthy();
      // A rolling alias is never a migration target: it resolves to whatever
      // the provider points it at, including a deprecated preview.
      expect(entry.replacement, id).not.toMatch(/-latest$/);
      expect(isVerified(entry), id).toBe(false);
    }
  });

  it('reports the same auto-fix-eligible count the engine gate would apply', () => {
    const registry = loadLlmRegistry(resolveRegistryPath());
    const provenance = registryProvenance(registry);
    const entries = modelIdEntries(registry);
    expect(provenance.autoFixEligible).toBe(entries.filter(isVerified).length);
    // The parts close: eligible + every review-only bucket = the whole file.
    const reviewOnly = Object.values(provenance.reviewOnlyCounts).reduce((n, c) => n + c, 0);
    expect(provenance.autoFixEligible + reviewOnly).toBe(provenance.activeEntries);
    // And the MEASURED shape of the shipped registry, so a re-stamp that moves
    // records between buckets has to be acknowledged here rather than landing
    // silently.
    expect(provenance.activeEntries).toBe(106);
    expect(provenance.autoFixEligible).toBe(86);
    expect(provenance.reviewOnlyCounts.quarantined).toBe(12);
    expect(provenance.reviewOnlyCounts.unverified).toBe(3);
    expect(provenance.reviewOnlyCounts.unverifiable).toBe(5);
    // Nothing ships in the defence-in-depth state; the validator forbids it.
    expect(provenance.reviewOnlyCounts.withheld).toBe(0);
  });
});
