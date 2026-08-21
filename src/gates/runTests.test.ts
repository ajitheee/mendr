import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTestCounts, runRepoTests } from './runTests.js';

// Hermetic tests for the test gate. Each builds a throwaway "repo" in the OS
// temp dir with a trivial package.json (and, where a run is expected, an empty
// node_modules so the gate's junction has a target). No network, no real deps —
// the test scripts are plain `node -e` one-liners.

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

/** Build a throwaway repo dir with the given package.json and (optionally) node_modules. */
function makeRepo(pkg: Record<string, unknown>, withNodeModules = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-gate-test-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (withNodeModules) mkdirSync(join(dir, 'node_modules'));
  return dir;
}

describe('runRepoTests (test gate)', () => {
  it('returns pass when the repo test suite passes', async () => {
    const repo = makeRepo({
      name: 'pass-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('pass');
  });

  it('returns fail when the repo test suite fails', async () => {
    const repo = makeRepo({
      name: 'fail-fixture',
      scripts: { test: 'node -e "process.exit(1)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('fail');
  });

  it('returns inconclusive when there is no test script', async () => {
    const repo = makeRepo({ name: 'no-test-fixture' }, false);
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('inconclusive');
    expect(result.output).toBe('no test script');
  });

  it('captures parsed counts from the runner output when present', async () => {
    const repo = makeRepo({
      name: 'counts-fixture',
      scripts: { test: 'node -e "console.log(\'Tests  3 passed (3)\'); process.exit(0)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('pass');
    expect(result.counts).toEqual({ passed: 3, failed: 0 });
  });

  it('overlays patched files into the temp copy (patched content decides pass/fail)', async () => {
    // The test script asserts a marker file contains PATCHED. We supply that
    // content only via patchedFiles, proving the overlay reached the sandbox.
    const repo = makeRepo({
      name: 'overlay-fixture',
      scripts: {
        test:
          'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'marker.txt\',\'utf8\');process.exit(t.trim()===\'PATCHED\'?0:1)"',
      },
    });
    writeFileSync(join(repo, 'marker.txt'), 'ORIGINAL');

    const result = await runRepoTests(repo, [
      { absPath: join(repo, 'marker.txt'), newText: 'PATCHED' },
    ]);
    expect(result.status).toBe('pass');
  });
});

describe('parseTestCounts (measurable gate labels)', () => {
  it('parses a vitest summary, preferring the Tests line over Test Files', () => {
    const out = ' Test Files  17 passed (17)\n      Tests  118 passed (118)\n';
    expect(parseTestCounts(out)).toEqual({ passed: 118, failed: 0 });
  });

  it('parses a vitest summary with failures', () => {
    const out = ' Test Files  2 failed (17)\n      Tests  2 failed | 116 passed (118)\n';
    expect(parseTestCounts(out)).toEqual({ passed: 116, failed: 2 });
  });

  it('parses a jest summary', () => {
    const out = 'Tests:       1 failed, 117 passed, 118 total\n';
    expect(parseTestCounts(out)).toEqual({ passed: 117, failed: 1 });
  });

  it('parses a pytest summary', () => {
    const out = '=========== 1 failed, 5 passed in 0.12s ===========\n';
    expect(parseTestCounts(out)).toEqual({ passed: 5, failed: 1 });
  });

  it('parses a mocha summary', () => {
    const out = '  7 passing (12ms)\n  1 failing\n';
    expect(parseTestCounts(out)).toEqual({ passed: 7, failed: 1 });
  });

  it('returns undefined for unrecognizable output (never invents numbers)', () => {
    expect(parseTestCounts('ok\nall good\n')).toBeUndefined();
    expect(parseTestCounts('')).toBeUndefined();
  });
});
