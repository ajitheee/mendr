import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { validateRegistry } from './validateRegistry.js';

// A replacement the registry migrates TO, sitting just outside a param rule that plainly means
// to cover it. The param matcher is an exact prefix, so on_models "gpt-5" covers gpt-5-mini and
// does NOT cover gpt-5.6-sol — which was the replacement target of 20 shipped entries, with
// gpt-5.6-terra behind another 18. Every one of those migrations swapped the model and left a
// max_tokens the new model rejects with a 400, and nothing in the pipeline asked.
describe('validateRegistry — a param rule that misses the model it migrates to', () => {
  const rule = {
    provider: 'openai',
    kind: 'param_rename' as const,
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1', 'gpt-5'],
  };
  const entry = (replacement: string) => ({
    provider: 'openai',
    kind: 'model_id' as const,
    deprecated: 'gpt-4-0613',
    replacement,
    status: 'deprecated' as const,
    shutdownDate: '2026-10-23',
    sourceUrl: 'https://developers.openai.com/api/docs/deprecations',
    verification: autoApplyVerification(),
  });
  const codes = (reg: LlmRegistry) =>
    validateRegistry(reg).violations.map((v) => v.code);

  it('flags a replacement in the family with the wrong separator', () => {
    const v = codes([entry('gpt-5.6-sol'), rule] as unknown as LlmRegistry);
    expect(v).toContain('param_rule_misses_replacement');
  });

  it('says which rule and which family, so the fix is obvious', () => {
    const [first] = validateRegistry([entry('gpt-5.6-sol'), rule] as unknown as LlmRegistry)
      .violations.filter((x) => x.code === 'param_rule_misses_replacement');
    expect(first?.message).toContain('gpt-5.6-sol');
    expect(first?.message).toContain('gpt-5');
    expect(first?.message).toContain('max_tokens');
  });

  it('is silent once the family is added — the fix must clear it', () => {
    const fixed = { ...rule, on_models: ['o1', 'gpt-5', 'gpt-5.6'] };
    const v = codes([entry('gpt-5.6-sol'), fixed] as unknown as LlmRegistry);
    expect(v).not.toContain('param_rule_misses_replacement');
  });

  it('is silent on a replacement the rule already matches', () => {
    const v = codes([entry('gpt-5-mini'), rule] as unknown as LlmRegistry);
    expect(v).not.toContain('param_rule_misses_replacement');
  });

  // The narrowness is the point: a blunter "shares a prefix" test would fire on every gpt-*
  // replacement and be turned off within a week.
  it('is silent on an unrelated family that merely shares a vendor prefix', () => {
    for (const rep of ['gpt-4o', 'gpt-4.1', 'gpt-image-2']) {
      expect(codes([entry(rep), rule] as unknown as LlmRegistry), rep)
        .not.toContain('param_rule_misses_replacement');
    }
  });
});
