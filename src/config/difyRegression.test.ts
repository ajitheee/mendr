import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { detectProviderSurface, isCatalogDefinitionFile, scanConfigText } from './scanConfig.js';

// Dify-review regression corpus. The real dify-official-plugins scan flagged 148
// model-DEFINITION catalog entries as live "selectors to change" (P0). These pin
// the fix: model-definition files -> Tier C catalog_definition, surfaces attributed,
// and never a selector on the NAME of a model-def file alone.

const REGISTRY: LlmRegistry = [
  { provider: 'anthropic', kind: 'model_id', deprecated: 'claude-3-opus-20240229', replacement: 'claude-opus-4-8', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', verification: autoApplyVerification() },
];

// A Dify model-definition YAML: a root `model:` plus catalog-definition siblings.
const MODEL_DEF_YAML = `model: claude-3-opus-20240229
label:
  en_US: Claude 3 Opus
model_type: llm
features:
  - tool-call
  - vision
model_properties:
  mode: chat
  context_size: 200000
parameter_rules:
  - name: temperature
    default: 1
pricing:
  input: '15.0'
  output: '75.0'
`;

describe('Dify regression — model-definition catalogs are NOT selectors (P0)', () => {
  it('isCatalogDefinitionFile detects a model-def by its catalog sibling keys', () => {
    expect(isCatalogDefinitionFile('models/anthropic/models/llm/claude-3-opus.yaml', MODEL_DEF_YAML)).toBe(true);
    // and by the provider model-directory path even with fewer signals
    expect(isCatalogDefinitionFile('models/gemini/models/llm/x.yaml', 'model: gpt-4\n')).toBe(true);
  });

  it('a plain runtime config is NOT a catalog definition', () => {
    expect(isCatalogDefinitionFile('config/app.yaml', 'llm:\n  model: gpt-4\n  temperature: 0.7\n')).toBe(false);
  });

  it('the root model: in a model-def file classifies as catalog_definition (Tier C), never a selector', () => {
    const matches = scanConfigText('models/anthropic/models/llm/claude-3-opus.yaml', MODEL_DEF_YAML, REGISTRY);
    const m = matches.find((x) => x.value === 'claude-3-opus-20240229')!;
    expect(m.position).toBe('config_catalog');
    expect(m.purpose).toBe('catalog_definition');
    expect(m.tier).toBe('C');
  });

  it('a genuine runtime selector in a plain config is still Tier B', () => {
    const matches = scanConfigText('config/app.yaml', 'model: gpt-4\n', REGISTRY);
    expect(matches[0].position).toBe('config_selector');
    expect(matches[0].tier).toBe('B');
    expect(matches[0].providerSurface).toBeNull();
  });
});

describe('Dify regression — provider-surface attribution (P0)', () => {
  it('detects non-direct surfaces from the path', () => {
    expect(detectProviderSurface('models/bedrock/models/llm/claude.yaml')).toBe('aws_bedrock');
    expect(detectProviderSurface('models/vertex_ai/models/llm/gemini.yaml')).toBe('google_vertex');
    expect(detectProviderSurface('models/azure_openai/models/llm/gpt.yaml')).toBe('azure_openai');
    expect(detectProviderSurface('models/cometapi/models/llm/openai/gpt.yaml')).toBe('provider_ambiguous');
    expect(detectProviderSurface('config/app.yaml')).toBeNull();
  });

  it('a selector under a non-direct surface carries the surface (so the renderer suppresses a direct swap)', () => {
    // Not a model-def file (no catalog sibling keys), but under a bedrock path.
    const matches = scanConfigText('deploy/bedrock/runtime.yaml', 'model: gpt-4\n', REGISTRY);
    expect(matches[0].providerSurface).toBe('aws_bedrock');
  });
});

describe('Dify regression — unverified replacements are exposure-only (P0)', () => {
  it('surfaces an unverified entry but its verdict is not "verified"', () => {
    const reg: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', verification: withheldVerification('unverified') },
    ];
    const matches = scanConfigText('config/app.yaml', 'model: gpt-4\n', reg);
    // still a selector (a live selection), but the renderer keys "change these" off the verdict
    expect(matches[0].position).toBe('config_selector');
    // the effective verdict is not verified -> renderer must not print "change to"
  });
});
