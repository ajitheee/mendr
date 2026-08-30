import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { foldConfigExposure, scanConfigText } from './scanConfig.js';

// MULTI-SIGNAL, OCCURRENCE-LEVEL CLASSIFICATION.
//
// The rule these fixtures defend: density may CONTRIBUTE to "this looks like a
// catalog", but it can never, on its own, override an occurrence that is shaped
// like a selector or sits under a runtime route key. A ten-model production
// router is an ordinary config, and silently downgrading its ten real selectors
// to informational is a false negative — far worse than the noise density was
// added to suppress.

const REG: LlmRegistry = [
  'gpt-4', 'gpt-4-32k', 'gpt-3.5-turbo', 'gpt-4-turbo', 'gpt-4-1106-preview',
  'claude-2.1', 'claude-1', 'gemini-pro', 'gemini-1.5-pro', 'text-davinci-003',
  'dall-e-2', 'gpt-4-vision-preview',
].map((m) => ({
  provider: m.startsWith('claude') ? 'anthropic' : m.startsWith('gemini') ? 'google' : 'openai',
  kind: 'model_id' as const,
  deprecated: m,
  replacement: 'successor-x',
  status: 'deprecated' as const,
  shutdownDate: '2026-10-23',
  verification: autoApplyVerification(),
}));

const TEN = ['gpt-4', 'gpt-4-32k', 'gpt-3.5-turbo', 'gpt-4-turbo', 'gpt-4-1106-preview',
  'claude-2.1', 'claude-1', 'gemini-pro', 'gemini-1.5-pro', 'text-davinci-003'];

const selectorsOf = (file: string, text: string) =>
  scanConfigText(file, text, REG).filter((m) => m.position === 'config_selector');
const catalogOf = (file: string, text: string) =>
  scanConfigText(file, text, REG).filter((m) => m.position === 'config_catalog');

// --- FIXTURE 1: a 10-model PRODUCTION ROUTER --------------------------------
// Ten distinct deprecated ids, every one a live runtime route. Density is high,
// but these are real selectors and must stay review findings.
const ROUTER = `
api_key: \${OPENAI_API_KEY}
base_url: https://api.openai.com/v1
timeout: 30
routes:
${TEN.map((m, i) => `  tier${i}:
    model: ${m}
    temperature: 0.2
    max_tokens: 1024`).join('\n')}
`;

// --- FIXTURE 2: a 10-model CATALOG ------------------------------------------
// The same ten ids, but each is a record DEFINING a model: the id is the block's
// own key, with label/pricing/features siblings. Informational, never selectors.
const CATALOG = `
models:
${TEN.map((m) => `  ${m}:
    model: ${m}
    label: ${m.toUpperCase()}
    model_type: llm
    pricing:
      input: 0.01
      output: 0.03
    features:
      - chat`).join('\n')}
`;

// --- FIXTURE 3: MIXED — selectors AND catalog entries in one file -----------
// Each occurrence must be judged on its own evidence, not by a file-wide verdict.
const MIXED = `
api_key: \${OPENAI_API_KEY}
base_url: https://api.openai.com/v1
default_model: gpt-4
fallback_model: gpt-3.5-turbo
temperature: 0.7
supported_models:
  - gpt-4-32k
  - gpt-4-turbo
  - claude-2.1
model_catalog:
  gemini-pro:
    model: gemini-pro
    label: Gemini Pro
    pricing:
      input: 0.001
  gemini-1.5-pro:
    model: gemini-1.5-pro
    label: Gemini 1.5 Pro
    pricing:
      input: 0.002
`;

describe('fixture 1 — a 10-model production router keeps its selectors', () => {
  const sel = selectorsOf('config/router.yaml', ROUTER);

  it('classifies all ten runtime routes as SELECTORS despite high density', () => {
    expect(sel).toHaveLength(10);
    expect(new Set(sel.map((m) => m.value)).size).toBe(10);
  });

  it('records why: a selector key on a runtime route, with density noted but not decisive', () => {
    const one = sel[0];
    expect(one.signals).toContain('selector_key');
    expect(one.signals).toContain('runtime_route_key');
    expect(one.signals).toContain('catalog_density'); // observed…
    expect(one.position).toBe('config_selector'); // …but did NOT override
  });

  it('every one is Tier B (review), never silently downgraded to informational', () => {
    expect(sel.every((m) => m.tier === 'B')).toBe(true);
    const exposures = foldConfigExposure(scanConfigText('config/router.yaml', ROUTER, REG));
    expect(exposures.every((e) => e.selectors.length > 0)).toBe(true);
  });
});

describe('fixture 2 — a 10-model catalog stays informational', () => {
  const all = scanConfigText('config/catalog.yaml', CATALOG, REG);

  it('produces NO selectors', () => {
    expect(all.filter((m) => m.position === 'config_selector')).toHaveLength(0);
  });

  it('classifies the nested `model:` as a catalog DEFINITION, by structure not density', () => {
    const nested = all.filter((m) => m.key === 'model');
    expect(nested.length).toBeGreaterThan(0);
    for (const m of nested) {
      expect(m.purpose).toBe('catalog_definition');
      // The decisive evidence is structural — the block is keyed by the id, and
      // the file defines models — NOT the fact that there happen to be ten.
      expect(
        m.signals?.includes('model_keyed_block') || m.signals?.includes('catalog_definition_file'),
      ).toBe(true);
    }
  });

  it('the id used as a map key is a lookup key', () => {
    const keys = all.filter((m) => m.purpose === 'lookup_key');
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('fixture 3 — a mixed file classifies each occurrence independently', () => {
  const all = scanConfigText('config/mixed.yaml', MIXED, REG);
  const sel = all.filter((m) => m.position === 'config_selector');
  const cat = all.filter((m) => m.position === 'config_catalog');

  it('the runtime routes ARE selectors', () => {
    const models = sel.map((m) => `${m.key}=${m.value}`);
    expect(models).toContain('default_model=gpt-4');
    expect(models).toContain('fallback_model=gpt-3.5-turbo');
  });

  it('the supported_models LIST entries are NOT selectors', () => {
    for (const id of ['gpt-4-32k', 'gpt-4-turbo', 'claude-2.1']) {
      expect(sel.some((m) => m.value === id), `${id} must not be a selector`).toBe(false);
      expect(cat.some((m) => m.value === id && m.purpose === 'list_entry')).toBe(true);
    }
  });

  it('the catalog block entries are NOT selectors, even though they use `model:`', () => {
    for (const id of ['gemini-pro', 'gemini-1.5-pro']) {
      const nested = all.filter((m) => m.value === id && m.key === 'model');
      expect(nested.length).toBeGreaterThan(0);
      for (const m of nested) expect(m.position).toBe('config_catalog');
    }
  });

  it('selectors and catalog entries coexist — no file-wide verdict was applied', () => {
    expect(sel.length).toBeGreaterThan(0);
    expect(cat.length).toBeGreaterThan(0);
  });
});

describe('density is a hint, never a verdict', () => {
  it('does NOT downgrade a runtime route key even with no runtime context present', () => {
    // Ten ids, all under `model:`, but nothing else in the file.
    const bare = TEN.map((m, i) => `svc${i}:\n  model: ${m}`).join('\n');
    const sel = selectorsOf('config/bare.yaml', bare);
    expect(sel).toHaveLength(10); // runtime_route_key protects them
  });

  it('DOES downgrade a dense file whose keys are not runtime routes and has no runtime context', () => {
    // `served_as:` is model-like enough to be a selector shape, but names no route.
    const odd = TEN.map((m, i) => `entry${i}:\n  served_as_model: ${m}`).join('\n');
    const sel = selectorsOf('config/odd.yaml', odd);
    const cat = catalogOf('config/odd.yaml', odd);
    expect(sel).toHaveLength(0);
    expect(cat.some((m) => m.signals?.includes('catalog_density'))).toBe(true);
  });

  it('a SPARSE file with the same odd key keeps its selector (density was the only reason)', () => {
    const sparse = 'entry0:\n  served_as_model: gpt-4\n';
    expect(selectorsOf('config/sparse.yaml', sparse)).toHaveLength(1);
  });
});
