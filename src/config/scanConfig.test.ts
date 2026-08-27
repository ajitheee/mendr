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
