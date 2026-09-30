import { describe, expect, it } from 'vitest';
import { hasGlobalMockTestingSwitch, lineIsInStubEntry, stubModelListEntries } from './yamlEntries.js';

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

// THE FILE-WIDE SWITCH, at parsed scope rather than anywhere in the text.
//
// `hasMockMarkers` was `FILE_MOCK_FLAGS.test(text)` — an unrestricted match. It fired on the switch
// inside a comment, inside a quoted string, or inside a `model_list` entry, and demoted the WHOLE
// file on that basis. The key must be a real mapping key, at the root or directly under a settings
// block, with a truthy value.
//
// `mock_timeout` and `mock_response` are no longer file-wide at all: both are `litellm_params`
// fields. Verified in litellm's own proxy_server_config.yaml, where `mock_timeout: True` sits inside
// a model_list entry's litellm_params beside FAKE_OPENAI_API_BASE.
describe('the file-wide mock switch is read at its parsed scope', () => {
  const SWITCH = 'dangerously_allow_mock_testing_request_params';

  it('fires under root general_settings, which is where litellm defines it', () => {
    expect(hasGlobalMockTestingSwitch(`general_settings:\n  ${SWITCH}: true\n`)).toBe(true);
  });

  it('is recognised ONLY there — not under other settings blocks, and not at the root', () => {
    // Narrowed 2026-09-29. An earlier draft accepted litellm_settings, router_settings,
    // environment_variables and the bare root. That breadth was guesswork: it invented scopes the
    // product does not have, and every extra scope is one more way to record something wrongly.
    expect(hasGlobalMockTestingSwitch(`litellm_settings:\n  ${SWITCH}: true\n`)).toBe(false);
    expect(hasGlobalMockTestingSwitch(`router_settings:\n  ${SWITCH}: true\n`)).toBe(false);
    expect(hasGlobalMockTestingSwitch(`${SWITCH}: true\n`)).toBe(false);
  });

  it('accepts the truthy spellings a config actually uses', () => {
    for (const v of ['true', 'True', 'yes', 'on', '1']) {
      expect(hasGlobalMockTestingSwitch(`general_settings:\n  ${SWITCH}: ${v}\n`), v).toBe(true);
    }
  });

  it('does NOT fire when the switch is explicitly off', () => {
    // The old text match could not tell `: true` from `: false`, so a config that deliberately
    // disabled mock testing was demoted as if it had enabled it.
    expect(hasGlobalMockTestingSwitch(`general_settings:\n  ${SWITCH}: false\n`)).toBe(false);
  });

  it('does NOT fire from a COMMENT', () => {
    expect(hasGlobalMockTestingSwitch(`general_settings:\n  # ${SWITCH}: true\n  master_key: os.environ/KEY\n`)).toBe(false);
  });

  it('does NOT fire from a quoted string value', () => {
    expect(hasGlobalMockTestingSwitch(`general_settings:\n  note: "never set ${SWITCH}: true in production"\n`)).toBe(false);
  });

  it('does NOT fire from inside a model_list entry, which is not a file-wide scope', () => {
    expect(hasGlobalMockTestingSwitch(`model_list:\n  - model_name: a\n    litellm_params:\n      ${SWITCH}: true\n`)).toBe(false);
  });

  it('does NOT fire for the per-route mock fields, which are no longer file-wide', () => {
    expect(hasGlobalMockTestingSwitch('model_list:\n  - model_name: a\n    litellm_params:\n      mock_timeout: True\n')).toBe(false);
    expect(hasGlobalMockTestingSwitch('litellm_settings:\n  mock_response: hello\n')).toBe(false);
  });

  it('treats the per-route mock fields as ENTRY markers instead', () => {
    const mixed = [
      'model_list:',
      '  - model_name: live',
      '    litellm_params:',
      '      model: gpt-4-0613',
      '  - model_name: stub',
      '    litellm_params:',
      '      mock_timeout: True',
    ].join('\n');
    const scope = stubModelListEntries(mixed);
    expect(scope.stubs).toHaveLength(1);
    expect(lineIsInStubEntry(scope, 4)).toBe(false); // the live route
    expect(lineIsInStubEntry(scope, 7)).toBe(true); // the stub route
  });

  it('answers false for unparseable input — an unreadable file has declared nothing', () => {
    expect(hasGlobalMockTestingSwitch(`general_settings:\n  ${SWITCH}: [unclosed\n`)).toBe(false);
  });

  it('reads JSON too, since YAML is a superset of it', () => {
    expect(hasGlobalMockTestingSwitch(`{ "general_settings": { "${SWITCH}": true } }`)).toBe(true);
  });
});
