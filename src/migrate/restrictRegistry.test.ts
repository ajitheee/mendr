import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { restrictRegistry } from './migrate.js';

// `mendr migrate --only` carries out exactly what a person approved in the App:
// the named model-id entries stay, every other model-id entry is dropped, and
// the model-coupled param transforms stay because they only fire on a swap.

const registry: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4.1' },
  { provider: 'google', kind: 'model_id', deprecated: 'gemini-1.5-pro', replacement: 'gemini-2.5-pro' },
  { provider: 'anthropic', kind: 'model_id', deprecated: 'claude-3-opus', replacement: 'claude-opus-4' },
  { provider: 'openai', kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', on_models: ['o1'] },
  { provider: 'anthropic', kind: 'param_removal', param: 'temperature', on_models: ['claude-opus-4'] },
];

const models = (r: LlmRegistry) => r.filter((e) => e.kind === 'model_id').map((e) => `${e.provider}/${(e as { deprecated: string }).deprecated}`);

describe('restrictRegistry (mendr migrate --only)', () => {
  it('keeps only the named model-id entries, by provider/model or bare model id, case-insensitively', () => {
    expect(models(restrictRegistry(registry, ['openai/gpt-4']))).toEqual(['openai/gpt-4']);
    expect(models(restrictRegistry(registry, ['gemini-1.5-pro', 'Claude-3-Opus']))).toEqual(['google/gemini-1.5-pro', 'anthropic/claude-3-opus']);
    expect(models(restrictRegistry(registry, [' OpenAI/GPT-4 ']))).toEqual(['openai/gpt-4']);
  });

  it('keeps the model-coupled param transforms — they only apply on a swap', () => {
    const kept = restrictRegistry(registry, ['openai/gpt-4']);
    expect(kept.filter((e) => e.kind !== 'model_id')).toHaveLength(2);
  });

  it('an unknown model leaves nothing to migrate rather than migrating everything', () => {
    expect(models(restrictRegistry(registry, ['openai/gpt-3']))).toEqual([]);
  });

  it('no restriction means the whole registry, unchanged', () => {
    expect(restrictRegistry(registry, undefined)).toBe(registry);
    expect(restrictRegistry(registry, [])).toBe(registry);
    expect(restrictRegistry(registry, [' '])).toBe(registry);
  });
});
