import { describe, it, expect } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals } from './scanPy.js';

// Tier A safety corpus (P0 from the 12-repo review): a Python `model=`-style
// keyword argument must NOT reach model_arg (Tier A auto-patch) on the NAME
// alone — the called function must be a recognized SDK sink. The concrete
// failure was dify-official-plugins' models/azure_openai/models/constants.py,
// where AzureBaseModel(base_model_name="gpt-4") — a model-DEFINITION catalog
// constructor — was proposed for auto-patch.

const REGISTRY: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4',
    replacement: 'gpt-5.6-sol',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    verification: autoApplyVerification(),
  },
];

async function positionOf(source: string): Promise<string | undefined> {
  const matches = await findPyModelIdLiterals([{ path: 'app.py', text: source }], REGISTRY);
  return matches.find((m) => m.value === 'gpt-4')?.position;
}

describe('Tier A safety — Python sink rule (Azure/catalog guard)', () => {
  it('AzureBaseModel(base_model_name=...) is NOT a live model call (must not be model_arg)', async () => {
    expect(await positionOf('AzureBaseModel(base_model_name="gpt-4")')).not.toBe('model_arg');
  });

  it('a model-definition constructor is not a sink (must not be model_arg)', async () => {
    expect(await positionOf('AIModelEntity(model="gpt-4", label="legacy")')).not.toBe('model_arg');
  });

  it('a real SDK sink chat.completions.create(model=) stays model_arg', async () => {
    expect(await positionOf('client.chat.completions.create(model="gpt-4")')).toBe('model_arg');
  });

  it('client.create(model=) stays model_arg', async () => {
    expect(await positionOf('client.create(model="gpt-4")')).toBe('model_arg');
  });

  it('litellm.completion(model=) stays model_arg', async () => {
    expect(await positionOf('litellm.completion(model="gpt-4")')).toBe('model_arg');
  });

  it('a bare model-like kwarg in an unknown constructor demotes off Tier A', async () => {
    // A wrapper we do not recognize: safe default is NOT model_arg (recall is
    // recovered later by inter-file wrapper tracing).
    expect(await positionOf('SomeConfig(model="gpt-4")')).not.toBe('model_arg');
  });
});
