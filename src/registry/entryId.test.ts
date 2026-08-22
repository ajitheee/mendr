import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { loadLlmRegistry, modelIdEntries, resolveRegistryPath } from '../usage/llmRegistry.js';
import { displayEntryId, entryIdFor } from './entryId.js';

// A REGISTRY RECORD NEEDS A NAME. Findings told the reader to run
// `mendr evidence <id>` and never printed an id; the bare model id worked as an
// argument by accident and is not an identity (two providers can retire the
// same-looking id, and one provider can retire one model in two waves).

function record(over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4',
    replacement: 'gpt-5.6-sol',
    ...over,
  };
}

describe('entryIdFor', () => {
  it('names the retirement wave when the record carries a shutdown date', () => {
    expect(entryIdFor(record({ shutdownDate: '2026-10-23' }))).toBe(
      'openai.gpt-4.retirement-2026-10-23',
    );
  });

  it('says "undated" rather than leaving the qualifier off', () => {
    // An id whose SHAPE changes with the data is an id a reader cannot pattern
    // match and a validator cannot check.
    expect(entryIdFor(record())).toBe('openai.gpt-4.retirement-undated');
  });

  it('is deterministic and depends on exactly three fields', () => {
    const a = record({ shutdownDate: '2026-10-23', note: 'one', replacement: 'gpt-5.6-sol' });
    const b = record({ shutdownDate: '2026-10-23', note: 'two', replacement: 'gpt-4o' });
    expect(entryIdFor(a)).toBe(entryIdFor(b));
  });

  it('separates two waves of the same model, and two providers of the same id', () => {
    expect(entryIdFor(record({ shutdownDate: '2024-06-13' }))).not.toBe(
      entryIdFor(record({ shutdownDate: '2026-10-23' })),
    );
    expect(entryIdFor(record({ provider: 'azure' }))).not.toBe(entryIdFor(record()));
  });

  it('leaves dots in a model id alone', () => {
    // The id is a display + lookup key, not a path. Escaping the dots would
    // make the printed id differ from the model id a reader recognises, which
    // is the one property that makes it copyable.
    expect(entryIdFor(record({ provider: 'google', deprecated: 'gemini-2.0-flash' }))).toBe(
      'google.gemini-2.0-flash.retirement-undated',
    );
  });
});

describe('displayEntryId', () => {
  it('prefers the stamped id', () => {
    expect(displayEntryId(record({ entryId: 'stamped.id.retirement-undated' }))).toBe(
      'stamped.id.retirement-undated',
    );
  });

  it('derives one rather than printing a blank row', () => {
    expect(displayEntryId(record())).toBe('openai.gpt-4.retirement-undated');
  });
});

describe('the shipped registry', () => {
  it('stamps every record with the id its own fields derive', () => {
    for (const entry of modelIdEntries(loadLlmRegistry(resolveRegistryPath()))) {
      expect(entry.entryId, entry.deprecated).toBe(entryIdFor(entry));
    }
  });

  it('gives every record a UNIQUE id -- an id naming two records names neither', () => {
    const entries = modelIdEntries(loadLlmRegistry(resolveRegistryPath()));
    const ids = entries.map((e) => e.entryId!);
    expect(new Set(ids).size).toBe(entries.length);
  });
});
