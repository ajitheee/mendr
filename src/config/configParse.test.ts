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

  // Commented-out config is everywhere in Helm values and docker-compose, and it is the opposite
  // of a live selector. The inner-key search reads straight through a leading #, so it had to be
  // stopped explicitly: re-running the harness caught it promoting two commented lines in
  // LibreChat helm/librechat/values.yaml from informational to runtime selector candidates.
  it('a commented-out line is never a selector', () => {
    expect(at('#         titleModel: "gpt-4-0613"', 'gpt-4-0613').position).toBe('config_catalog');
    expect(at('  # model: gpt-4-0613', 'gpt-4-0613').position).toBe('config_catalog');
    expect(at('  // "model": "gpt-4-0613"', 'gpt-4-0613').position).toBe('config_catalog');
  });

  it('a # inside a quoted value does not make the line a comment', () => {
    expect(at('model: gpt-4-0613  # pinned', 'gpt-4-0613')).toMatchObject({ position: 'config_selector' });
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

describe('an empty file is not malformed configuration', () => {
  // MENDR FAILED ON ITS OWN OUTPUT. The generated audit workflow ran
  // `mendr audit . --json > mendr-audit.json` from the repository root, and the shell creates
  // that file BEFORE mendr starts. So every run scanned mendr's own zero-byte output, called it
  // malformed JSON, and fail-closed.
  //
  // It hid for weeks because a run WITH findings concludes `exposure_detected` regardless of
  // parse failures. It therefore only ever struck a repository that was CLEAN -- turning every
  // all-clear into `inconclusive` with a neutral check. It surfaced on mendr's own demo, whose
  // migration pull request failed the check mendr opened it with.
  //
  // The rule is the same one that already exempts docs and fixtures: a file with no content
  // cannot be hiding a model id, so its unreadability narrows nothing.
  it('a zero-byte json file is not a parse failure', () => {
    expect(configParseIssue('mendr-audit.json', '')).toBeNull();
  });

  it('whitespace only is the same thing', () => {
    expect(configParseIssue('a.json', '   ')).toBeNull();
    expect(configParseIssue('a.json', String.fromCharCode(10, 10))).toBeNull();
    expect(configParseIssue('a.yaml', '  ')).toBeNull();
  });

  // The guard must not become an excuse to ignore real breakage.
  it('a file with actual malformed content still fails closed', () => {
    expect(configParseIssue('a.json', '{ "model": "gpt-4", ')).toBe('malformed_json');
  });

  it('a single stray character is content, not emptiness', () => {
    expect(configParseIssue('a.json', '{')).toBe('malformed_json');
  });
});

// Windows PowerShell 5.1 writes a UTF-8 BOM into every file it creates, and
// `JSON.parse` rejects a BOM that RFC 8259 explicitly allows a parser to
// ignore. So a valid config written on Windows was classified malformed — and
// the fail-closed rule then turns a CLEAN repository `inconclusive`, which is
// the same failure shape as the zero-byte-output bug, reached through a
// different door and only on Windows.
describe('configParseIssue — a byte-order mark is not malformed content', () => {
  it('accepts valid JSON that begins with a BOM', () => {
    expect(configParseIssue('a.json', '\uFEFF{ "model": "gpt-4" }')).toBeNull();
  });

  it('accepts a BOM in front of JSON with comments', () => {
    expect(configParseIssue('tsconfig.json', '\uFEFF{\n // comment\n "compilerOptions": {},\n}')).toBeNull();
  });

  it('still fails closed on malformed JSON that happens to carry a BOM', () => {
    expect(configParseIssue('a.json', '\uFEFF{ "model": "gpt-4", ')).toBe('malformed_json');
  });
});
