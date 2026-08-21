import { describe, it, expect } from 'vitest';
import type { LlmRegistry, VerificationStatus } from '../types.js';
import { loadLlmRegistry, registryProvenance } from '../usage/llmRegistry.js';
import { formatRegistryProvenanceLines } from './llmReport.js';

// THE FOOTER USED TO OVERCLAIM. `registry: 106 entries, verified 2026-08-18`
// reads as "all 106 replacements were fully verified that day". Two separate
// things happened — a catalog recheck of every replacement, and a per-entry
// verdict, 12 of which were not `verified` — and the footer now says both,
// computed from the loaded registry rather than a hardcoded constant.

function entry(
  deprecated: string,
  status?: VerificationStatus,
  checkedAt?: string,
): LlmRegistry[number] {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated,
    replacement: 'gpt-5.6-sol',
    ...(status ? { verification: { status, ...(checkedAt ? { checkedAt } : {}) } } : {}),
  };
}

describe('registryProvenance', () => {
  it('counts active model_id entries and their per-entry verdicts', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'verified', '2026-08-18'),
      entry('c', 'unverified', '2026-08-18'),
      entry('d', 'unverifiable', '2026-07-01'),
      entry('e'), // unstamped
      // Param entries are not "active entries" in the model-id sense — the
      // footer's number is what the model-id matcher can act on.
      { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['o1'] },
    ];
    const p = registryProvenance(registry);
    expect(p.activeEntries).toBe(5);
    expect(p.statusCounts).toEqual({
      verified: 2,
      unverified: 1,
      unverifiable: 1,
      unstamped: 1,
    });
    expect(p.oldestCheckedAt).toBe('2026-07-01');
    expect(p.newestCheckedAt).toBe('2026-08-18');
    expect(p.undatedEntries).toBe(1);
  });

  it('reports no dates at all when nothing is stamped', () => {
    const p = registryProvenance([entry('a'), entry('b')]);
    expect(p.oldestCheckedAt).toBeUndefined();
    expect(p.newestCheckedAt).toBeUndefined();
    expect(p.undatedEntries).toBe(2);
  });
});

describe('formatRegistryProvenanceLines', () => {
  it('prints ONE recheck date when every entry shares it', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'unverified', '2026-08-18'),
    ];
    expect(formatRegistryProvenanceLines(registryProvenance(registry))).toEqual([
      'registry: 2 active entries',
      'catalog recheck: 2026-08-18',
      'entry verification: 1 verified, 1 unverified (per entry, see `mendr evidence <id>`)',
    ]);
  });

  it('names BOTH ends when the stamps differ, instead of implying one date covers all', () => {
    const registry: LlmRegistry = [
      entry('a', 'verified', '2026-08-18'),
      entry('b', 'verified', '2026-05-02'),
    ];
    const lines = formatRegistryProvenanceLines(registryProvenance(registry));
    expect(lines[1]).toBe('catalog recheck: 2026-08-18 (oldest entry checked 2026-05-02)');
  });

  it('says so when entries carry no recheck date', () => {
    const registry: LlmRegistry = [entry('a', 'verified', '2026-08-18'), entry('b', 'verified')];
    const lines = formatRegistryProvenanceLines(registryProvenance(registry));
    expect(lines[1]).toBe('catalog recheck: 2026-08-18; 1 entry carries no recheck date');
  });

  it('refuses to invent a date for a registry that was never rechecked', () => {
    const lines = formatRegistryProvenanceLines(registryProvenance([entry('a')]));
    expect(lines).toEqual([
      'registry: 1 active entry',
      'catalog recheck: never recorded',
      'entry verification: 1 unstamped (per entry, see `mendr evidence <id>`)',
    ]);
  });
});

describe('the SHIPPED registry footer', () => {
  it('is computed from the shipped data, never a constant', () => {
    const registry = loadLlmRegistry();
    const p = registryProvenance(registry);
    const lines = formatRegistryProvenanceLines(p);

    // The arithmetic has to close: every active entry lands in exactly one
    // verdict bucket. A footer whose parts do not sum to its whole is the same
    // class of bug as the overclaim it replaced.
    const summed = Object.values(p.statusCounts).reduce((n, c) => n + c, 0);
    expect(summed).toBe(p.activeEntries);
    expect(lines[0]).toBe(`registry: ${p.activeEntries} active entries`);
    // ...and the old blanket wording is gone for good.
    expect(lines.join('\n')).not.toMatch(/entries, verified/);
  });
});
