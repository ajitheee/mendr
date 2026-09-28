import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { foldConfigExposure, scanConfigText } from './scanConfig.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-4o-mini', verification: autoApplyVerification() },
];

function scan(text: string) {
  return scanConfigText('f', text, REGISTRY).map((m) => ({ value: m.value, position: m.position, purpose: m.purpose, key: m.key, tier: m.tier }));
}
function one(text: string) {
  const r = scan(text);
  expect(r.length).toBe(1);
  return r[0];
}

describe('scanConfigText — selector vs catalog classification', () => {
  it('a model-like key with an exact scalar value is a SELECTOR (Tier B)', () => {
    expect(one('model: gpt-4')).toMatchObject({ position: 'config_selector', key: 'model', tier: 'B' });
    expect(one('fallback_model: gpt-3.5-turbo')).toMatchObject({ position: 'config_selector', tier: 'B' });
  });

  it('an .env model-like key is a selector', () => {
    expect(one('OPENAI_MODEL=gpt-4')).toMatchObject({ position: 'config_selector', key: 'OPENAI_MODEL', tier: 'B' });
  });

  it('a quoted JSON value with a trailing comma is a selector', () => {
    expect(one('  "defaultModel": "gpt-4",')).toMatchObject({ position: 'config_selector', key: 'defaultModel', tier: 'B' });
  });

  it('a list element is CATALOG (Tier C), not a selector', () => {
    expect(one('  - gpt-4')).toMatchObject({ position: 'config_catalog', purpose: 'list_entry', tier: 'C' });
  });

  it('a map KEY is catalog (lookup_key), not a selector', () => {
    expect(one('  gpt-4:')).toMatchObject({ position: 'config_catalog', purpose: 'lookup_key', tier: 'C' });
  });

  it('an id embedded in an inline list is catalog, not a selector', () => {
    expect(one('allowedModels: ["gpt-4"]')).toMatchObject({ position: 'config_catalog', tier: 'C' });
  });

  it('a non-model-like key with the id as value is catalog, not a selector', () => {
    expect(one('provider: gpt-4')).toMatchObject({ position: 'config_catalog', purpose: 'catalog_entry', tier: 'C' });
  });

  it('exact-value only — gpt-4o never matches gpt-4', () => {
    expect(scan('model: gpt-4o')).toEqual([]);
  });

  it('a current model id (not in the registry) yields nothing', () => {
    expect(scan('model: claude-opus-4-8')).toEqual([]);
  });
});

describe('foldConfigExposure — selectors split from catalog, actionable first', () => {
  it('groups by model and separates Tier B selectors from Tier C references', () => {
    const matches = scanConfigText('app.yaml', 'model: gpt-4\navailable:\n  - gpt-4\n  - gpt-4o\n', REGISTRY);
    const [exposure] = foldConfigExposure(matches);
    expect(exposure.model).toBe('gpt-4');
    expect(exposure.selectors.map((m) => m.line)).toEqual([1]); // model: gpt-4
    expect(exposure.catalog.map((m) => m.line)).toEqual([3]); // - gpt-4 (gpt-4o is not deprecated)
    expect(exposure.replacement).toBe('gpt-4o');
  });
});

describe('a gateway selector carrying a provider prefix is a selector, not catalog', () => {
  // MEASURED BEFORE THE FIX, on a five-line litellm config selecting gpt-4-0613:
  //   Conclusion: INCONCLUSIVE — "We found no retiring AI dependencies in use."
  // The same file with the prefix removed reported EXPOSURE DETECTED. `provider/model`
  // is the canonical spelling in every litellm config in the wild, so the scanner was
  // failing on the standard form and passing on the unusual one — the worst way round,
  // because a confident false negative is worse than no scan at all.

  it('reads `model: openai/gpt-4` as a runtime selector', () => {
    expect(one('model: openai/gpt-4')).toMatchObject({ value: 'gpt-4', position: 'config_selector', purpose: 'gateway_prefixed', key: 'model' });
  });

  it('is capped at review, never auto-applied', () => {
    // The successor may need a different prefix and the gateway may not accept it.
    // Config is never Tier A anyway; this asserts the prefixed case did not sneak past.
    expect(one('model: openai/gpt-4').tier).toBe('B');
  });

  it('works for the litellm_params idiom it exists for', () => {
    const got = scan(['model_list:', '  - model_name: fast', '    litellm_params:', '      model: openai/gpt-4'].join('\n'));
    expect(got.some((m) => m.value === 'gpt-4' && m.position === 'config_selector')).toBe(true);
  });

  it('still refuses a prefix under a key that is not model-like', () => {
    // `label: openai/gpt-4` is describing something, not selecting it.
    expect(one('label: openai/gpt-4').position).toBe('config_catalog');
  });

  it('does not match a DIFFERENT id that merely shares a prefix', () => {
    // Exact-value discipline has to survive the prefix split: `openai/gpt-4o` is not
    // `gpt-4`, and reporting it would be the substring matching this scanner forbids.
    const got = scan('model: openai/gpt-4o');
    expect(got.filter((m) => m.position === 'config_selector')).toEqual([]);
  });

  it('leaves a plain unprefixed selector exactly as it was', () => {
    expect(one('model: gpt-4')).toMatchObject({ position: 'config_selector', key: 'model' });
    expect(one('model: gpt-4').purpose).toBeUndefined();
  });
});
