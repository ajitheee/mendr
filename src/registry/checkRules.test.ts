import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { checkRules, ruleCheckFails, rulePageUrls } from './checkRules.js';

const REF = 'https://example.test/api/reference';
const GUIDE = 'https://example.test/migration-guide';

const REG: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1'],
    quotes: [
      { sourceUrl: REF, text: 'This value is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models.', about: 'rule' },
      { sourceUrl: REF, text: 'including visible output tokens and reasoning tokens.', about: 'behaviour' },
    ],
  },
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'temperature',
    on_models: ['claude-opus-4-7'],
    quotes: [{ sourceUrl: GUIDE, text: 'returns a 400 error.', about: 'rule' }],
  },
  // A rule that edits code and quotes nothing at all.
  { provider: 'anthropic', kind: 'param_removal', param: 'top_k', on_models: ['claude-opus-4-7'] },
];

const REF_PAGE =
  '<p><code>max_tokens</code>: Deprecated. This value is now deprecated in favor of <code>max_completion_tokens</code>, and is not compatible with o-series models.</p>' +
  '<p>An upper bound ..., including visible output tokens and reasoning tokens.</p>';

describe('checkRules: every quoted sentence must still be on its page', () => {
  it('lists each cited page once, for the caller to fetch', () => {
    expect(rulePageUrls(REG)).toEqual([REF, GUIDE]);
  });

  it('confirms sentences that are on the page, through the markup', () => {
    const [openai] = checkRules(REG, new Map([[REF, REF_PAGE], [GUIDE, 'x']]));
    expect(openai.quotes.map((q) => q.verdict)).toEqual(['confirmed', 'confirmed']);
    expect(ruleCheckFails(openai)).toBe(false);
  });

  it('FAILS a rule whose sentence is gone from a page that was read', () => {
    const [, anthropic] = checkRules(REG, new Map([[REF, REF_PAGE], [GUIDE, '<p>Sampling parameters are now accepted.</p>']]));
    expect(anthropic.quotes[0].verdict).toBe('missing');
    expect(ruleCheckFails(anthropic)).toBe(true);
  });

  it('reports an unread page as unread, never as confirmed and never as a failure of the rule', () => {
    const [, anthropic] = checkRules(REG, new Map([[REF, REF_PAGE], [GUIDE, undefined]]));
    expect(anthropic.quotes[0].verdict).toBe('unread');
    expect(ruleCheckFails(anthropic)).toBe(false);
  });

  it('FAILS a rule that quotes nothing', () => {
    const [, , topK] = checkRules(REG, new Map());
    expect(topK).toMatchObject({ rule: 'anthropic.param_removal.top_k', unquoted: true });
    expect(ruleCheckFails(topK)).toBe(true);
  });

  it('a behaviour quote alone does not make a rule quoted', () => {
    const behaviourOnly: LlmRegistry = [
      { provider: 'openai', kind: 'param_removal', param: 'n', on_models: ['o1'], quotes: [{ sourceUrl: REF, text: 'x', about: 'behaviour' }] },
    ];
    expect(checkRules(behaviourOnly, new Map([[REF, 'x']]))[0].unquoted).toBe(true);
  });

  it('checks only parameter rules', () => {
    const modelOnly: LlmRegistry = [{ provider: 'openai', kind: 'model_id', deprecated: 'o1', replacement: 'gpt-5.6-sol' }];
    expect(checkRules(modelOnly, new Map())).toEqual([]);
  });
});
