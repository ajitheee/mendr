import { describe, expect, it } from 'vitest';
import { classifyConfigOccurrence, configParseIssue, innerKeyAt, stripJsonComments } from './scanConfig.js';

// THE CONFIG SCANNER'S PARSE GAP.
//
// The scanner is deliberately line-based — it never builds a YAML or JSON tree, which is what
// lets it survive the half-broken and templated config real repositories are full of. Two things
// were genuinely beyond it, and it said nothing about either.

describe('a key inside a flow mapping governs the id', () => {
  // The same logical config written three ways used to get three different verdicts. `parseKey`
  // is anchored to the start of the line, so `llm: {model: x}` returned the key `llm` and never
  // saw the inner `model` — demoting a live selector to an informational reference by YAML style.
  const at = (line: string, id: string) => classifyConfigOccurrence(line, line.indexOf(id), id);

  it('block style is a selector', () => {
    expect(at('model: gpt-4-0613', 'gpt-4-0613')).toMatchObject({ position: 'config_selector', key: 'model' });
  });

  it('flow style is the SAME selector, not a catalog reference', () => {
    expect(at('llm: {model: gpt-4-0613}', 'gpt-4-0613')).toMatchObject({
      position: 'config_selector',
      key: 'model',
    });
  });

  it('works with siblings after it in the flow mapping', () => {
    expect(at('llm: {model: gpt-4-0613, temperature: 0.5}', 'gpt-4-0613')).toMatchObject({
      position: 'config_selector',
      key: 'model',
    });
  });

  it('single-line JSON is a flow mapping too', () => {
    expect(at('{"model": "gpt-4-0613"}', 'gpt-4-0613')).toMatchObject({
      position: 'config_selector',
      key: 'model',
    });
  });

  // The guard that keeps this from over-reaching: a LIST is not the value of its key.
  it('a list is still a catalog, not a selector', () => {
    expect(at('models: [gpt-4-0613, gpt-4-turbo]', 'gpt-4-0613')).toMatchObject({
      position: 'config_catalog',
      key: 'models',
    });
  });

  it('a non-model key is still a catalog even in flow style', () => {
    expect(at('meta: {name: gpt-4-0613}', 'gpt-4-0613')).toMatchObject({ position: 'config_catalog', key: 'name' });
  });

  it('innerKeyAt declines when anything but flow punctuation precedes the id', () => {
    expect(innerKeyAt('models: [', 9)).toBeNull();
    expect(innerKeyAt('llm: {model: ', 13)).toMatchObject({ key: 'model' });
  });
});

describe('stripJsonComments — JSONC is the norm, not a defect', () => {
  // JSON.parse alone declared 23 files malformed across the twelve validation repositories, and
  // every one was fine: .vscode/launch.json, .vscode/settings.json, tsconfig.json, .eslintrc.json.
  // A check that fires on tsconfig is a check people switch off.
  it('strips line comments', () => {
    expect(JSON.parse(stripJsonComments('{\n // a note\n "a": 1\n}'))).toEqual({ a: 1 });
  });

  it('strips block comments', () => {
    expect(JSON.parse(stripJsonComments('{/* note */ "a": 1}'))).toEqual({ a: 1 });
  });

  it('allows a trailing comma', () => {
    expect(JSON.parse(stripJsonComments('{"a": 1,}'))).toEqual({ a: 1 });
  });

  // A naive strip eats the middle of every URL in the file and invents a parse error.
  it('does NOT strip a // inside a string', () => {
    expect(JSON.parse(stripJsonComments('{"u": "https://example.com/x"}'))).toEqual({
      u: 'https://example.com/x',
    });
  });

  it('respects escaped quotes inside strings', () => {
    expect(JSON.parse(stripJsonComments('{"s": "a \\" // not a comment"}'))).toEqual({
      s: 'a " // not a comment',
    });
  });
});

describe('configParseIssue — say what could not be read, guess nothing', () => {
  it('flags genuinely malformed JSON', () => {
    expect(configParseIssue('a.json', '{ "model": "gpt-4-0613", ')).toBe('malformed_json');
  });

  it('does not flag JSONC', () => {
    expect(configParseIssue('tsconfig.json', '{\n // comment\n "compilerOptions": {},\n}')).toBeNull();
  });

  it('flags a model-like key whose value is an alias', () => {
    expect(configParseIssue('a.yaml', 'defaults: &d gpt-4-0613\nservice:\n  model: *d\n')).toBe('unresolved_alias');
  });

  // Flagging every anchor was measurably too broad: it fired on ragflow's `exclude: &web_exclude
  // [globs]` and dify's `document: &id001`, neither of which could hold a model id. A clean repo
  // pushed to inconclusive by a list of file globs teaches people to ignore the tool.
  it('ignores an anchor that could never hold a model', () => {
    expect(configParseIssue('a.yaml', 'exclude: &web ["**/*.min.js"]\nlint:\n  exclude: *web\n')).toBeNull();
    expect(configParseIssue('a.yaml', 'document: &id001\n  x: 1\nother:\n  document: *id001\n')).toBeNull();
  });

  it('says nothing about a well-formed file', () => {
    expect(configParseIssue('a.yaml', 'model: gpt-4-0613\n')).toBeNull();
    expect(configParseIssue('a.json', '{"model": "gpt-4-0613"}')).toBeNull();
  });

  // Docs and examples are data, not deployed config: their unreadability narrows nothing.
  it('ignores an unparseable file under a docs or examples path', () => {
    expect(configParseIssue('docs/api/sample.json', '{ "a": ... }')).toBeNull();
    expect(configParseIssue('examples/demo.json', '{ broken')).toBeNull();
    expect(configParseIssue('config.example.json', '{ broken')).toBeNull();
  });

  it('has no opinion about file types it does not parse', () => {
    expect(configParseIssue('a.toml', 'model = "gpt-4-0613"')).toBeNull();
    expect(configParseIssue('.env', 'MODEL=gpt-4-0613')).toBeNull();
  });
});
