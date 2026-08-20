import { describe, it, expect } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { staleRegistryWarning } from './llmRegistry.js';

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
