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
