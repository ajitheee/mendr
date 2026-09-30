import { describe, expect, it } from 'vitest';
import { lineIsInStubEntry, stubModelListEntries } from './yamlEntries.js';

// ENTRY-SCOPED STUB DETECTION — the regression suite for the false clean measured 2026-09-29.
//
// One `model_list` item carrying `FAKE_OPENAI_API_BASE` demoted a SIBLING item's
// `model: gpt-4-0613` from review to informational, because that marker sat in the FILE-level set
// while an `api_base` belongs to exactly one route. A stub beside live routes is the ordinary
// shape — LiteLLM's own docker sample ships one — so this was a false clean on the very
// configuration the gateway work exists to cover.
//
// Every case below asks one of two questions:
//   * is the stub correctly confined to its own item, and
//   * when the shape is anything other than tidy, does the answer fail CLOSED (demote nothing)?
//
// The second is the one that matters. A wrong demotion is a missed retirement reported as
// informational. A missing demotion is a review-queue entry on a stub. Ambiguity must always pick
// the second, so most of these tests assert `resolved: false` rather than a clever guess.

const line = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split('\n').length;

describe('a stub route is confined to its own entry', () => {
  const MIXED = [
    'model_list:',
    '  - model_name: fast',
    '    litellm_params:',
    '      model: gpt-4-0613',
    '      api_key: os.environ/OPENAI_API_KEY',
    '  - model_name: stub',
    '    litellm_params:',
    '      model: openai/fake',
    '      api_base: os.environ/FAKE_OPENAI_API_BASE',
  ].join('\n');

  it('marks the stub entry and leaves the live one alone', () => {
    const scope = stubModelListEntries(MIXED);
    expect(scope.resolved).toBe(true);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, line(MIXED, 'gpt-4-0613'))).toBe(false);
    expect(lineIsInStubEntry(scope, line(MIXED, 'openai/fake'))).toBe(true);
    expect(lineIsInStubEntry(scope, line(MIXED, 'FAKE_OPENAI_API_BASE'))).toBe(true);
  });

  it('works when the stub comes FIRST — order must not matter', () => {
    // The old line scanner walked outward in both directions, so ordering was exactly the kind of
    // thing that could change the answer. It must not.
    const stubFirst = [
      'model_list:',
      '  - model_name: stub',
      '    litellm_params:',
      '      model: openai/fake',
      '      api_key: fake-key',
      '  - model_name: fast',
      '    litellm_params:',
      '      model: gpt-4-0613',
    ].join('\n');
    const scope = stubModelListEntries(stubFirst);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, line(stubFirst, 'gpt-4-0613'))).toBe(false);
  });

  it('works with a stub between two live routes', () => {
    const sandwich = [
      'model_list:',
      '  - model_name: a',
      '    litellm_params:',
      '      model: gpt-4-0613',
      '  - model_name: stub',
      '    litellm_params:',
      '      api_key: fake-key',
      '  - model_name: b',
      '    litellm_params:',
      '      model: gpt-3.5-turbo',
    ].join('\n');
    const scope = stubModelListEntries(sandwich);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, line(sandwich, 'gpt-4-0613'))).toBe(false);
    expect(lineIsInStubEntry(scope, line(sandwich, 'gpt-3.5-turbo'))).toBe(false);
  });

  it('survives four-space indentation', () => {
    const wide = [
      'model_list:',
      '    -   model_name: fast',
      '        litellm_params:',
      '            model: gpt-4-0613',
      '    -   model_name: stub',
      '        litellm_params:',
      '            api_key: fake-key',
    ].join('\n');
    const scope = stubModelListEntries(wide);
    expect(scope.resolved).toBe(true);
    expect(lineIsInStubEntry(scope, line(wide, 'gpt-4-0613'))).toBe(false);
    expect(lineIsInStubEntry(scope, line(wide, 'fake-key'))).toBe(true);
  });

  it('does not care which key comes first in an entry', () => {
    // A route is a mapping, not a fixed field order. `litellm_params` before `model_name`, or no
    // `model_name` at all, is still one route.
    const odd = [
      'model_list:',
      '  - litellm_params:',
      '      model: gpt-4-0613',
      '    model_name: fast',
      '  - litellm_params:',
      '      api_key: fake-key',
      '    rpm: 10',
    ].join('\n');
    const scope = stubModelListEntries(odd);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, line(odd, 'gpt-4-0613'))).toBe(false);
  });

  it('marks every entry when every entry is a stub, without needing a file-level rule', () => {
    const allFake = [
      'model_list:',
      '  - model_name: a',
      '    litellm_params:',
      '      model: openai/fake',
      '      api_key: fake-key',
      '  - model_name: b',
      '    litellm_params:',
      '      model: openai/fake',
      '      api_base: os.environ/FAKE_OPENAI_API_BASE',
    ].join('\n');
    const scope = stubModelListEntries(allFake);
    // Both marked by the SAME per-entry rule. An "all entries are fake" file rule is not needed
    // and is not implemented: it would only ever restate what per-entry marking already says,
    // while reintroducing the whole-file blast radius this exists to remove.
    expect(scope.stubs).toHaveLength(2);
    expect(lineIsInStubEntry(scope, line(allFake, 'api_key: fake-key'))).toBe(true);
  });

  it('scopes per document when one file holds several', () => {
    const multi = [
      'model_list:',
      '  - model_name: live',
      '    litellm_params:',
      '      model: gpt-4-0613',
      '---',
      'model_list:',
      '  - model_name: stub',
      '    litellm_params:',
      '      api_key: fake-key',
    ].join('\n');
    const scope = stubModelListEntries(multi);
    expect(scope.resolved).toBe(true);
    expect(scope.stubs).toHaveLength(1);
    // The live route in the FIRST document must be untouched by the stub in the second.
    expect(lineIsInStubEntry(scope, line(multi, 'gpt-4-0613'))).toBe(false);
    expect(lineIsInStubEntry(scope, line(multi, 'fake-key'))).toBe(true);
  });

  it('finds a route list nested under another key, as a Helm chart nests it', () => {
    const helm = [
      'proxy:',
      '  config:',
      '    model_list:',
      '      - model_name: fast',
      '        litellm_params:',
      '          model: gpt-4-0613',
      '      - model_name: stub',
      '        litellm_params:',
      '          api_key: fake-key',
    ].join('\n');
    const scope = stubModelListEntries(helm);
    expect(scope.resolved).toBe(true);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, line(helm, 'gpt-4-0613'))).toBe(false);
  });
});

describe('ambiguity never demotes — every one of these answers "no opinion"', () => {
  const noOpinion = (text: string, why: string) => {
    const scope = stubModelListEntries(text);
    expect(scope.resolved, why).toBe(false);
    // And the accessor must refuse regardless of what is in `stubs`.
    expect(lineIsInStubEntry(scope, 1), why).toBe(false);
    expect(lineIsInStubEntry(scope, 4), why).toBe(false);
  };

  it('malformed YAML', () => {
    noOpinion('model_list:\n  - model_name: [unclosed\n    litellm_params:\n      api_key: fake-key\n', 'unclosed flow sequence');
  });

  it('a tab-indented file, which YAML forbids', () => {
    noOpinion('model_list:\n\t- model_name: a\n\t  api_key: fake-key\n', 'tabs are not valid YAML indentation');
  });

  it('a duplicate key, which the parser rejects rather than silently picking one', () => {
    noOpinion('model_list:\n  - model_name: a\n    model_name: b\n    api_key: fake-key\n', 'duplicate key');
  });

  it('one bad document poisons the whole file, not just itself', () => {
    // Boundaries in document 2 are unknown, and a partially-understood file is not a file whose
    // entries we can confine a marker to. Refuse for all of it.
    noOpinion(
      'model_list:\n  - model_name: a\n    api_key: fake-key\n---\nmodel_list:\n  - model_name: [unclosed\n',
      'second document is malformed',
    );
  });

  it('no route list at all', () => {
    noOpinion('litellm_settings:\n  drop_params: true\n  api_key: fake-key\n', 'nothing shaped like a route list');
  });

  it('a route list that is a mapping rather than a sequence', () => {
    noOpinion('model_list:\n  fast:\n    model: gpt-4-0613\n    api_key: fake-key\n', 'model_list is a map, so it has no items');
  });

  it('an empty file', () => {
    noOpinion('', 'nothing to read');
  });

  it('a file that is only a comment', () => {
    noOpinion('# just a note\n', 'no contents');
  });
});

describe('a resolved file with no stubs is still an ANSWER, not an abstention', () => {
  it('reports resolved with an empty stub list', () => {
    const clean = 'model_list:\n  - model_name: fast\n    litellm_params:\n      model: gpt-4-0613\n';
    const scope = stubModelListEntries(clean);
    expect(scope.resolved).toBe(true);
    expect(scope.stubs).toEqual([]);
    expect(lineIsInStubEntry(scope, 4)).toBe(false);
  });
});
