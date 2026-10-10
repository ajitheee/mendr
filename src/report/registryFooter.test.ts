import { describe, it, expect } from 'vitest';
import type { LlmRegistry, VerificationStatus } from '../types.js';
import {
  autoApplyVerification,
  isVerified,
  loadLlmRegistry,
  modelIdEntries,
  registryProvenance,
  withheldVerification,
} from '../usage/llmRegistry.js';
import { formatRegistryProvenanceLines } from './llmReport.js';

// THE FOOTER HAS OVERCLAIMED TWICE, and the second time is the instructive one.
//
//   v1  `registry: 106 entries, verified 2026-08-18`
//       One date standing in for a verdict it never produced.
//   v2  `entry verification: 98 verified, 3 unverified, 5 unverifiable`
//       plus a separate `held at review: 12 ...` line. Arithmetically true, and
//       still misleading: the number a reader takes away is the one next to the
//       word "verified", and 98 was never the number of things mendr would
//       auto-fix. It was 86.
//
// So the headline is now the ONE number a reader acts on -- how many records
// clear the engine gate -- computed through the same isVerified() the codemod
// calls, with everything else itemised under `review-only`.

function entry(
  deprecated: string,
  status?: VerificationStatus,
  checkedAt?: string,
): LlmRegistry[number] {
  const dated = checkedAt ? { checkedAt } : {};
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated,
    replacement: 'gpt-5.6-sol',
    ...(status
      ? {
          verification:
            status === 'verified'
              ? autoApplyVerification(dated)
              : withheldVerification(status, dated),
        }
      : {}),
  };
}

describe('registryProvenance', () => {
  it('counts what the ENGINE would fix, and buckets everything else', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'verified', '2026-08-18'),
      entry('c', 'quarantined', '2026-08-18'),
      entry('d', 'unverified', '2026-08-18'),
      entry('e', 'unverifiable', '2026-07-01'),
      entry('f'), // unstamped
      // Param entries are not "active records" in the model-id sense — the
      // footer's number is what the model-id matcher can act on.
      { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['o1'] },
    ];
    const p = registryProvenance(registry);
    expect(p.activeEntries).toBe(6);
    expect(p.autoFixEligible).toBe(2);
    expect(p.reviewOnlyCounts).toEqual({
      verified: 0,
      quarantined: 1,
      unverified: 1,
      unverifiable: 1,
      unstamped: 1,
      withheld: 0,
    });
    expect(p.oldestCheckedAt).toBe('2026-07-01');
    expect(p.newestCheckedAt).toBe('2026-08-18');
    expect(p.undatedEntries).toBe(1);
  });

  it('counts a `verified` stamp with a switch off as WITHHELD, not as eligible', () => {
    // Defence in depth. The CI validator rejects this combination outright, so
    // it should never ship — but if it ever did, the footer must not count it
    // among the records mendr would auto-fix.
    const registry: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4',
        replacement: 'gpt-5.6-sol',
        verification: autoApplyVerification({ replacementConfirmed: false }),
      },
    ];
    const p = registryProvenance(registry);
    expect(p.autoFixEligible).toBe(0);
    expect(p.reviewOnlyCounts.withheld).toBe(1);
  });

  it('reports no dates at all when nothing is stamped', () => {
    const p = registryProvenance([entry('a'), entry('b')]);
    expect(p.oldestCheckedAt).toBeUndefined();
    expect(p.newestCheckedAt).toBeUndefined();
    expect(p.undatedEntries).toBe(2);
  });
});

describe('formatRegistryProvenanceLines', () => {
  it('leads with the auto-fixable count and itemises the rest', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'quarantined', '2026-08-18'),
      entry('c', 'unverified', '2026-08-18'),
    ];
    expect(formatRegistryProvenanceLines(registryProvenance(registry))).toEqual([
      'registry: 3 records',
      'auto-fix eligible: 1',
      'review-only: 2 (quarantined 1, unverified 1)',
      'catalog recheck: 2026-08-18',
    ]);
  });

  it('prints ONE recheck date when every record shares it', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'unverified', '2026-08-18'),
    ];
    const lines = formatRegistryProvenanceLines(registryProvenance(registry));
    expect(lines[3]).toBe('catalog recheck: 2026-08-18');
  });

  it('names BOTH ends when the stamps differ, instead of implying one date covers all', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'verified', '2026-05-02'),
    ];
    const lines = formatRegistryProvenanceLines(registryProvenance(registry));
    expect(lines[3]).toBe('catalog recheck: 2026-08-18 (oldest entry checked 2026-05-02)');
  });

  it('says so when records carry no recheck date', () => {
    const registry: LlmRegistry = [entry('a', 'verified', '2026-08-18'), entry('b', 'verified')];
    const lines = formatRegistryProvenanceLines(registryProvenance(registry));
    expect(lines[3]).toBe('catalog recheck: 2026-08-18; 1 entry carries no recheck date');
  });

  it('refuses to invent a date for a registry that was never rechecked', () => {
    const lines = formatRegistryProvenanceLines(registryProvenance([entry('a')]));
    expect(lines).toEqual([
      'registry: 1 record',
      'auto-fix eligible: 0',
      'review-only: 1 (unstamped 1)',
      'catalog recheck: never recorded',
    ]);
  });
});

describe('the SHIPPED registry footer', () => {
  it('is computed from the shipped data, never a constant', () => {
    const registry = loadLlmRegistry();
    const p = registryProvenance(registry);
    const lines = formatRegistryProvenanceLines(p);

    // The arithmetic has to close: every record is either auto-fix eligible or
    // in exactly one review-only bucket. A footer whose parts do not sum to its
    // whole is the same class of bug as the overclaims it replaced.
    const reviewOnly = Object.values(p.reviewOnlyCounts).reduce((n, c) => n + c, 0);
    expect(p.autoFixEligible + reviewOnly).toBe(p.activeEntries);
    expect(lines[0]).toBe(`registry: ${p.activeEntries} records`);
    // The headline number is the ENGINE's answer, not a stamp tally.
    expect(lines[1]).toBe(
      `auto-fix eligible: ${modelIdEntries(registry).filter(isVerified).length}`,
    );
    // ...and neither of the old blanket wordings can come back.
    expect(lines.join('\n')).not.toMatch(/entries, verified/);
    expect(lines.join('\n')).not.toMatch(/entry verification:/);
  });

  it('prints the measured shape of the shipped registry', () => {
    const lines = formatRegistryProvenanceLines(registryProvenance(loadLlmRegistry()));
    // 2026-10-04: -4 gpt-5 aliases (no provider date), +10 ids OpenAI retires
    // 2026-10-23, and the 4 reasoning.mode: pro replacements moved to quarantine. 2026-10-06:
    // +1 claude-sonnet-4-5-20250929, quarantined (Sonnet 5.5 rejects settings an id swap keeps).
    // 2026-10-10: the two retired Live API ids move to gemini-3.8-live, which no public catalog
    // lists yet, so they leave auto-fix for unverified; gpt-5.2 is removed (OpenAI does not
    // deprecate it); three image models retiring 2026-12-01 are added, unverifiable by class;
    // the providers' pages settle 11 quarantines and one unverified hold; eight Google ids
    // retiring 2026-10-22 and 2026-11-17 are added, all detect-only; so are OpenAI's six
    // fine-tune rows, quarantined. Then 13 discovered candidates the gate cannot check, added
    // review-only: 6 OpenAI realtime ids and gemini-2.5-flash-lite-preview-09-2025 (unverified),
    // 6 OpenAI audio ids (unverifiable by class).
    expect(lines[0]).toBe('registry: 193 records');
    expect(lines[1]).toBe('auto-fix eligible: 144');
    expect(lines[2]).toBe('review-only: 49 (quarantined 16, unverified 14, unverifiable 19)');
  });
});
