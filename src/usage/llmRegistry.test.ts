import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { EVIDENCE_EXCERPT_MAX_CHARS } from '../types.js';
import { loadLlmRegistry, modelIdEntries, staleRegistryWarning } from './llmRegistry.js';

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
      'warning: registry last verified 2026-02-01 -- run mendr verify-registry for current data.',
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
