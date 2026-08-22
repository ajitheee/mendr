import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepoConfig, REPO_CONFIG_FILENAME } from './repoConfig.js';

// Hermetic: every case builds a throwaway repo dir in the OS temp dir and
// writes (or omits) a mendr.config.json. No network, no fixtures on disk.

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Throwaway repo dir, with the given config text written only if supplied. */
function makeRepo(configText?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-config-test-'));
  created.push(dir);
  if (configText !== undefined) writeFileSync(join(dir, REPO_CONFIG_FILENAME), configText);
  return dir;
}

describe('loadRepoConfig', () => {
  it('returns an empty config when the repo has no mendr.config.json', () => {
    expect(loadRepoConfig(makeRepo())).toEqual({});
  });

  it('reads evalCommand and evalTimeoutMs', () => {
    const repo = makeRepo(JSON.stringify({ evalCommand: 'npm run eval', evalTimeoutMs: 30000 }));
    expect(loadRepoConfig(repo)).toEqual({ evalCommand: 'npm run eval', evalTimeoutMs: 30000 });
  });

  it('keeps every field optional (a config with neither field is legal)', () => {
    expect(loadRepoConfig(makeRepo('{}'))).toEqual({});
  });

  it('ignores unknown fields rather than rejecting the file', () => {
    // Forward compatibility: a config written for a newer mendr must not brick
    // an older one. Unknown KEYS are inert; malformed KNOWN keys still throw.
    const repo = makeRepo(JSON.stringify({ evalCommand: 'make eval', futureOption: true }));
    expect(loadRepoConfig(repo)).toEqual({ evalCommand: 'make eval' });
  });

  // The malformed cases below all assert the FILE PATH is in the message: a
  // config error the user cannot locate is barely better than a silent ignore.
  it('throws, naming the file, on malformed JSON', () => {
    const repo = makeRepo('{ "evalCommand": "npm run eval", }');
    expect(() => loadRepoConfig(repo)).toThrow(/mendr\.config\.json/);
    expect(() => loadRepoConfig(repo)).toThrow(/could not read\/parse/);
  });

  it('throws when the file is JSON but not an object', () => {
    expect(() => loadRepoConfig(makeRepo('["npm run eval"]'))).toThrow(/must be a JSON object/);
    expect(() => loadRepoConfig(makeRepo('"npm run eval"'))).toThrow(/must be a JSON object/);
  });

  it('throws when evalCommand is not a non-empty string', () => {
    expect(() => loadRepoConfig(makeRepo(JSON.stringify({ evalCommand: 42 })))).toThrow(
      /"evalCommand" must be a non-empty string/,
    );
    expect(() => loadRepoConfig(makeRepo(JSON.stringify({ evalCommand: '   ' })))).toThrow(
      /"evalCommand" must be a non-empty string/,
    );
  });

  it('throws when evalTimeoutMs is not a positive number', () => {
    for (const bad of [0, -1, 'soon', null]) {
      expect(() => loadRepoConfig(makeRepo(JSON.stringify({ evalTimeoutMs: bad })))).toThrow(
        /"evalTimeoutMs" must be a positive number/,
      );
    }
  });

  it('trims the command so a stray newline cannot become part of the shell line', () => {
    expect(loadRepoConfig(makeRepo(JSON.stringify({ evalCommand: ' npm run eval\n' })))).toEqual({
      evalCommand: 'npm run eval',
    });
  });
});

describe('loadRepoConfig: the gates block', () => {
  it('reads a full gate policy', () => {
    const repo = makeRepo(
      JSON.stringify({
        gates: {
          typecheck: { required: true },
          tests: { required: false },
          eval: { command: 'npm run eval:model-migration', required: true },
        },
      }),
    );
    expect(loadRepoConfig(repo)).toEqual({
      gates: {
        typecheck: { required: true },
        tests: { required: false },
        eval: { command: 'npm run eval:model-migration', required: true },
      },
    });
  });

  it('keeps every gate and every field optional', () => {
    expect(loadRepoConfig(makeRepo(JSON.stringify({ gates: {} })))).toEqual({ gates: {} });
    expect(loadRepoConfig(makeRepo(JSON.stringify({ gates: { tests: {} } })))).toEqual({
      gates: { tests: {} },
    });
  });

  it('accepts the legacy evalCommand alongside a gates block', () => {
    const repo = makeRepo(
      JSON.stringify({ evalCommand: 'npm run eval', gates: { tests: { required: true } } }),
    );
    expect(loadRepoConfig(repo)).toEqual({
      evalCommand: 'npm run eval',
      gates: { tests: { required: true } },
    });
  });

  it('accepts the two spellings of the eval command when they AGREE', () => {
    const repo = makeRepo(
      JSON.stringify({ evalCommand: 'npm run eval', gates: { eval: { command: 'npm run eval' } } }),
    );
    expect(loadRepoConfig(repo).gates?.eval?.command).toBe('npm run eval');
  });

  it('refuses to choose when the two spellings DISAGREE', () => {
    // Picking a winner silently means one of the two commands the file names
    // never runs, and the file itself cannot tell the reader which.
    const repo = makeRepo(
      JSON.stringify({ evalCommand: 'npm run eval', gates: { eval: { command: 'make eval' } } }),
    );
    expect(() => loadRepoConfig(repo)).toThrow(/mendr\.config\.json/);
    expect(() => loadRepoConfig(repo)).toThrow(/"evalCommand".*"gates\.eval\.command".*disagree/s);
  });

  // A MISSPELLED GATE IS NOT FORWARD COMPATIBILITY. Unknown TOP-LEVEL fields
  // are inert on purpose, but a typo under `gates` leaves the user believing a
  // gate is mandatory while mendr quietly does not enforce it -- the exact
  // silent ignore this block exists to prevent.
  it('throws on an unknown gate name, naming the field and the known gates', () => {
    const repo = makeRepo(JSON.stringify({ gates: { lint: { required: true } } }));
    expect(() => loadRepoConfig(repo)).toThrow(/mendr\.config\.json/);
    expect(() => loadRepoConfig(repo)).toThrow(/unknown gate "gates\.lint"/);
    expect(() => loadRepoConfig(repo)).toThrow(/typecheck, tests, eval/);
  });

  it('throws on an unknown field inside a gate (the "requred" typo)', () => {
    const repo = makeRepo(JSON.stringify({ gates: { tests: { requred: true } } }));
    expect(() => loadRepoConfig(repo)).toThrow(/unknown field "gates\.tests\.requred"/);
    expect(() => loadRepoConfig(repo)).toThrow(/allowed: required/);
  });

  it('throws when required is not a boolean', () => {
    for (const bad of ['yes', 1, null]) {
      const repo = makeRepo(JSON.stringify({ gates: { tests: { required: bad } } }));
      expect(() => loadRepoConfig(repo)).toThrow(/"gates\.tests\.required" must be true or false/);
    }
  });

  it('throws when gates, or one gate, is not a JSON object', () => {
    expect(() => loadRepoConfig(makeRepo(JSON.stringify({ gates: ['tests'] })))).toThrow(
      /"gates" must be a JSON object/,
    );
    expect(() => loadRepoConfig(makeRepo(JSON.stringify({ gates: { tests: true } })))).toThrow(
      /"gates\.tests" must be a JSON object/,
    );
  });

  it('rejects a command on a gate that runs no command of yours', () => {
    // `typecheck` and `tests` are mendr's own gates. Accepting a command there
    // would read as a way to override them, and would do nothing at all.
    expect(
      () => loadRepoConfig(makeRepo(JSON.stringify({ gates: { tests: { command: 'pytest' } } }))),
    ).toThrow(/"gates\.tests\.command" is not supported/);
  });

  it('throws when the eval command is not a non-empty string, and trims it otherwise', () => {
    expect(
      () => loadRepoConfig(makeRepo(JSON.stringify({ gates: { eval: { command: '  ' } } }))),
    ).toThrow(/"gates\.eval\.command" must be a non-empty string/);
    expect(
      loadRepoConfig(makeRepo(JSON.stringify({ gates: { eval: { command: ' make eval\n' } } })))
        .gates?.eval?.command,
    ).toBe('make eval');
  });
});
