import { describe, it, expect } from 'vitest';
import {
  canonicalizeId,
  familyOf,
  idsEqual,
  idsFamilyMatch,
  inferModelClass,
  isCatalogVerifiableClass,
  isLiveId,
} from './normalize.js';

// Normalization is ~90% of the verification risk, so every gotcha the spike hit
// gets a dedicated assertion here.

describe('canonicalizeId', () => {
  it('lowercases and trims', () => {
    expect(canonicalizeId('  GPT-4O  ')).toBe('gpt-4o');
  });

  it('strips the OpenRouter provider namespace', () => {
    expect(canonicalizeId('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(canonicalizeId('openai/gpt-4o')).toBe('gpt-4o');
  });

  it('strips the "~" alias marker', () => {
    expect(canonicalizeId('~openai/gpt-4o')).toBe('gpt-4o');
  });

  it('strips a ":batch" / ":free" / ":thinking" variant suffix', () => {
    expect(canonicalizeId('anthropic/claude-sonnet-4-6:batch')).toBe('claude-sonnet-4-6');
    expect(canonicalizeId('openai/gpt-4o:free')).toBe('gpt-4o');
    expect(canonicalizeId('anthropic/claude-opus-4-8:thinking')).toBe('claude-opus-4-8');
  });

  it('replaces "." with "-" on BOTH sides so dotted and dashed spellings unify', () => {
    expect(canonicalizeId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(canonicalizeId('gpt-3.5-turbo')).toBe('gpt-3-5-turbo');
    // OpenRouter dotted + namespaced folds to the same canonical form as the
    // registry's dashed spelling.
    expect(canonicalizeId('anthropic/claude-sonnet-4.6')).toBe(canonicalizeId('claude-sonnet-4-6'));
  });

  it('composes all rules at once (the OpenRouter worst case)', () => {
    expect(canonicalizeId('~anthropic/claude-sonnet-4.6:batch')).toBe('claude-sonnet-4-6');
  });
});

describe('familyOf (bare alias <-> dated snapshot)', () => {
  it('strips an 8-digit dated snapshot suffix', () => {
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('strips an ISO YYYY-MM-DD dated suffix', () => {
    expect(familyOf('o4-mini-2025-04-16')).toBe('o4-mini');
  });

  it('leaves a bare alias unchanged (its own family)', () => {
    expect(familyOf('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('does NOT collapse a version tail or a short MMDD tag', () => {
    // 1-digit version part is not a date.
    expect(familyOf('claude-opus-4-8')).toBe('claude-opus-4-8');
    // 4-digit MMDD snapshot tags are deliberately kept intact.
    expect(familyOf('gpt-4-0613')).toBe('gpt-4-0613');
  });

  it('a bare alias and its dated snapshot share a family; different minors do not', () => {
    expect(idsFamilyMatch('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(idsFamilyMatch('claude-sonnet-4-5', 'claude-sonnet-4-6')).toBe(false);
  });
});

describe('idsEqual (exact canonical identity)', () => {
  it('matches across dot/dash and namespace but NOT across a date suffix', () => {
    expect(idsEqual('anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6')).toBe(true);
    // Identity check is strict: bare alias is NOT equal to its dated snapshot.
    expect(idsEqual('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(false);
  });
});

describe('isLiveId (family-aware set membership)', () => {
  it('matches a dated registry id against a live bare alias, and vice versa', () => {
    // Simulate the oracle set holding BOTH canonical + family forms.
    const liveOnlyBare = new Set(['claude-haiku-4-5']);
    expect(isLiveId('claude-haiku-4-5-20251001', liveOnlyBare)).toBe(true);

    const liveOnlyDated = new Set(['claude-haiku-4-5-20251001', 'claude-haiku-4-5']);
    expect(isLiveId('claude-haiku-4-5', liveOnlyDated)).toBe(true);
  });

  it('does not match an id whose family is absent', () => {
    const live = new Set(['claude-sonnet-4-6']);
    expect(isLiveId('claude-sonnet-4-5', live)).toBe(false);
  });
});

describe('inferModelClass', () => {
  it('flags moderation as out-of-class (catalogs do not list it)', () => {
    expect(inferModelClass('text-moderation-latest')).toBe('moderation');
    expect(inferModelClass('omni-moderation-latest')).toBe('moderation');
    expect(isCatalogVerifiableClass('moderation')).toBe(false);
  });

  it('flags image / audio / tts as out-of-class', () => {
    expect(inferModelClass('dall-e-3')).toBe('image');
    expect(inferModelClass('whisper-1')).toBe('audio');
    expect(inferModelClass('tts-1')).toBe('tts');
    for (const cls of ['image', 'audio', 'tts'] as const) {
      expect(isCatalogVerifiableClass(cls)).toBe(false);
    }
  });

  it('treats chat models (including vision) as the verifiable class', () => {
    expect(inferModelClass('gpt-4o')).toBe('chat');
    // "vision" is multimodal chat, which catalogs DO list — not image-gen.
    expect(inferModelClass('gpt-4-vision-preview')).toBe('chat');
    expect(inferModelClass('claude-sonnet-4-6')).toBe('chat');
    expect(isCatalogVerifiableClass('chat')).toBe(true);
  });
});
