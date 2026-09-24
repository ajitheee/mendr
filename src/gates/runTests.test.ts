import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTestCounts, runRepoTests } from './runTests.js';
import { isVerified } from './status.js';

// Hermetic tests for the test gate. Each builds a throwaway "repo" in the OS
// temp dir with a trivial package.json (and, where a run is expected, an empty
// node_modules so the gate's junction has a target). No network, no real deps —
// the test scripts are plain `node -e` one-liners.
//
// THE RULE THESE TESTS NOW ENCODE (see gates/status.ts): `passed` is the only
// word that claims verification, and the gate may only say it when the suite
// demonstrably RAN. So a fixture that stands in for a passing suite has to look
// like a real runner and print a parseable summary; a script that merely exits 0
// is `inconclusive`, and a repo with no test script at all is `not_run`.

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
  it('returns passed when the repo test suite runs and passes', async () => {
    // The fixture prints a vitest-shaped summary because `passed` now requires
    // EVIDENCE that tests ran: a parseable summary with at least one test in it.
    // A bare `process.exit(0)` no longer earns this word (see the next test).
    const repo = makeRepo({
      name: 'pass-fixture',
      scripts: { test: 'node -e "console.log(\'Tests  2 passed (2)\'); process.exit(0)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('passed');
    expect(result.counts).toEqual({ passed: 2, failed: 0 });
  });

  it('returns inconclusive when the test command exits 0 without parseable results (exit 0 is not proof a test ran)', async () => {
    // BEHAVIOUR CHANGE. `"test": "exit 0"` used to return pass, which was enough
    // to make a migration `verified` and open a PR whose body told the reviewer
    // "your tests: passed" when nothing had run. The command succeeding is not
    // the suite succeeding, so the honest state is `inconclusive` — plus a note,
    // because the captured output does not explain itself.
    const repo = makeRepo({
      name: 'silent-exit-zero-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('inconclusive');
    expect(result.counts).toBeUndefined();
    expect(result.note).toMatch(/exited 0/);
    // The consequence that matters downstream: nothing was verified here.
    expect(isVerified(result.status)).toBe(false);
  });

  it('returns failed when the repo test suite fails', async () => {
    const repo = makeRepo({
      name: 'fail-fixture',
      scripts: { test: 'node -e "process.exit(1)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('failed');
  });

  it('returns not_run when there is no test script (nothing to run, as opposed to tried-and-cannot-say)', async () => {
    // BEHAVIOUR CHANGE. This was `inconclusive`, and the caller re-split the two
    // cases by string-matching `output` against 'no test script'. The STATUS now
    // carries that distinction: `not_run` means no amount of installing or
    // retrying would produce a result, `inconclusive` means we tried.
    const repo = makeRepo({ name: 'no-test-fixture' }, false);
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('not_run');
    // Still a human-readable reason, but it is no longer the discriminator.
    expect(result.output).toContain('no test script');
  });

  it('returns inconclusive when a test script exists but the repo has no installed node_modules', async () => {
    // The other side of the distinction above: there IS something to run and we
    // cannot run it. `npm test` needs the repo's own devDependencies.
    const repo = makeRepo(
      { name: 'no-deps-fixture', scripts: { test: 'node -e "process.exit(1)"' } },
      false,
    );
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('inconclusive');
    expect(result.output).toContain('node_modules');
  });

  it('captures parsed counts from the runner output when present', async () => {
    const repo = makeRepo({
      name: 'counts-fixture',
      scripts: { test: 'node -e "console.log(\'Tests  3 passed (3)\'); process.exit(0)"' },
    });
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('passed');
    expect(result.counts).toEqual({ passed: 3, failed: 0 });
  });

  it('overlays patched files into the temp copy (patched content decides passed/failed)', async () => {
    // The test script asserts a marker file contains PATCHED. We supply that
    // content only via patchedFiles, proving the overlay reached the sandbox.
    // It prints a summary on the success path so the gate can say `passed` at
    // all: an exit-0-with-no-results run is now `inconclusive`, which would not
    // distinguish "the overlay landed" from "the gate could not run".
    const repo = makeRepo({
      name: 'overlay-fixture',
      scripts: {
        test:
          'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'marker.txt\',\'utf8\');if(t.trim()!==\'PATCHED\')process.exit(1);console.log(\'Tests  1 passed (1)\')"',
      },
    });
    writeFileSync(join(repo, 'marker.txt'), 'ORIGINAL');

    const result = await runRepoTests(repo, [
      { absPath: join(repo, 'marker.txt'), newText: 'PATCHED' },
    ]);
    expect(result.status).toBe('passed');
  });

  it('reports failed when the unpatched content is what the suite sees (overlay is load-bearing)', async () => {
    // The negative control for the test above: same fixture, no overlay, so the
    // marker still says ORIGINAL and the suite rejects it. Without this, an
    // overlay that silently did nothing could still look like a green gate.
    const repo = makeRepo({
      name: 'overlay-control-fixture',
      scripts: {
        test:
          'node -e "const fs=require(\'fs\');const t=fs.readFileSync(\'marker.txt\',\'utf8\');if(t.trim()!==\'PATCHED\')process.exit(1);console.log(\'Tests  1 passed (1)\')"',
      },
    });
    writeFileSync(join(repo, 'marker.txt'), 'ORIGINAL');

    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('failed');
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
