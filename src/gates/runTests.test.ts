import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NO_TEST_RUNNER, parseTestCounts, runRepoTests } from './runTests.js';
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

// node:test prints its totals WORD FIRST (`ℹ pass 2`), which none of the
// number-first patterns above match. Every repo whose `npm test` was `node
// --test` came back `inconclusive` -- ajitheee/mendr-demo's PR #5 said "your
// tests: could not run" over a suite that passed. These outputs are captured
// from real runs (Node 24), trimmed only of durations and stack frames.
const NODE_SPEC_PASS = [
  '',
  '> mendr-demo@0.1.0 test',
  '> tsc -p . && node --test test/prompt.test.mjs',
  '',
  '✔ handles 3 failed requests (0.9558ms)',
  '✔ buildPrompt collapses whitespace and trims (0.7ms)',
  'ℹ tests 2',
  'ℹ suites 0',
  'ℹ pass 2',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 97.3',
  '',
].join('\n');

const NODE_SPEC_FAIL = [
  '✔ ok (0.8486ms)',
  '✖ bad (1.6996ms)',
  'ℹ tests 2',
  'ℹ suites 0',
  'ℹ pass 1',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 124.2026',
  '',
  '✖ failing tests:',
  '',
  'test at a.test.mjs:4:1',
  '✖ bad (1.6996ms)',
  '  AssertionError [ERR_ASSERTION]: 1 == 2',
  '',
].join('\n');

const NODE_TAP_PASS = [
  'TAP version 13',
  '# Subtest: handles 3 failed requests',
  'ok 1 - handles 3 failed requests',
  '  ---',
  '  duration_ms: 0.8805',
  "  type: 'test'",
  '  ...',
  '# Subtest: second',
  'ok 2 - second',
  '  ---',
  '  duration_ms: 0.1608',
  "  type: 'test'",
  '  ...',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 2',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 157.3382',
  '',
].join('\n');

const NODE_SPEC_ZERO = [
  'ℹ tests 0',
  'ℹ suites 0',
  'ℹ pass 0',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 13.091',
  '',
].join('\n');

describe('parseTestCounts (node:test)', () => {
  it('parses the spec reporter summary', () => {
    // The test NAMED "handles 3 failed requests" is the trap: the number-first
    // fallback would read it as three failures. The summary lines win.
    expect(parseTestCounts(NODE_SPEC_PASS)).toEqual({ passed: 2, failed: 0 });
  });

  it('parses the spec reporter summary with a failure', () => {
    expect(parseTestCounts(NODE_SPEC_FAIL)).toEqual({ passed: 1, failed: 1 });
  });

  it('parses the TAP reporter summary (the piped-output default on Node 20 and 22)', () => {
    expect(parseTestCounts(NODE_TAP_PASS)).toEqual({ passed: 2, failed: 0 });
  });

  it('parses the spec summary when FORCE_COLOR wraps each line in SGR codes', () => {
    const colored = NODE_SPEC_PASS.split('\n')
      .map((l) => (l.startsWith('ℹ') ? `\x1b[34m${l}\x1b[39m` : l))
      .join('\n');
    expect(parseTestCounts(colored)).toEqual({ passed: 2, failed: 0 });
  });

  it('sums the summaries of a script that runs node --test more than once', () => {
    // `node --test test/unit && node --test test/e2e` prints one summary each.
    expect(parseTestCounts(`${NODE_SPEC_PASS}${NODE_SPEC_FAIL}`)).toEqual({ passed: 3, failed: 1 });
  });

  it('reads a zero-test summary as zero, not as no summary', () => {
    // Parsed, and empty. The gate decides what that means (see below): it is
    // NOT evidence that a test ran.
    expect(parseTestCounts(NODE_SPEC_ZERO)).toEqual({ passed: 0, failed: 0 });
  });

  it('still prefers the vitest Tests line when the output also carries node-shaped lines', () => {
    // A vitest run whose own output contains "ℹ" text -- a logged node:test
    // child, a console line -- must keep reading vitest's dedicated totals.
    const out = [
      'stdout | src/child.test.ts > spawns a node:test run',
      'ℹ tests 9',
      'ℹ pass 9',
      'ℹ fail 0',
      'ℹ using cached fixtures',
      '',
      ' Test Files  2 failed | 15 passed (17)',
      '      Tests  2 failed | 116 passed (118)',
      '',
    ].join('\n');
    expect(parseTestCounts(out)).toEqual({ passed: 116, failed: 2 });
  });
});

describe('runRepoTests on a node:test suite', () => {
  // These run REAL `node --test` (it is built into node, so the fixture needs no
  // dependencies): whichever reporter the running Node defaults to -- TAP for
  // piped output on 22, spec on 23+ -- the gate has to read it.
  function makeNodeTestRepo(testFile: string): string {
    const repo = makeRepo({ name: 'node-test-fixture', scripts: { test: 'node --test test/a.test.mjs' } });
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'a.test.mjs'), testFile);
    return repo;
  }

  it('returns passed for a passing node --test suite', async () => {
    const repo = makeNodeTestRepo(
      "import test from 'node:test';\ntest('handles 3 failed requests', () => {});\ntest('second', () => {});\n",
    );
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('passed');
    expect(result.counts).toEqual({ passed: 2, failed: 0 });
  });

  it('returns failed, with counts, for a failing node --test suite', async () => {
    const repo = makeNodeTestRepo(
      "import test from 'node:test';\nimport assert from 'node:assert';\ntest('ok', () => {});\ntest('bad', () => { assert.equal(1, 2); });\n",
    );
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('failed');
    expect(result.counts).toEqual({ passed: 1, failed: 1 });
  });

  it('returns inconclusive for a node:test summary of zero tests (exit 0 is still not proof)', async () => {
    // `ℹ tests 0` IS a parseable summary -- of nothing. The rule this gate
    // encodes is that `passed` needs at least one test to have run.
    const repo = makeRepo({ name: 'node-zero-fixture', scripts: { test: 'node print-zero.js' } });
    writeFileSync(join(repo, 'print-zero.js'), `process.stdout.write(${JSON.stringify(NODE_SPEC_ZERO)});\n`);
    const result = await runRepoTests(repo, []);
    expect(result.status).toBe('inconclusive');
    expect(result.note).toMatch(/exited 0/);
    expect(isVerified(result.status)).toBe(false);
  });
});

describe('a repository this gate has no runner for', () => {
  // The defect: a repo with no package.json fell through to the catch below
  // and came back `inconclusive` carrying the raw ENOENT -- Error, message and
  // the CI runner's ABSOLUTE PATH -- which mendr-action published verbatim in
  // the body of a public pull request, on every run against a python repo.
  it('says it has no runner, without naming a path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-nopkg-'));
    created.push(dir);
    writeFileSync(join(dir, 'app.py'), 'model = "gpt-4"\n');

    const r = await runRepoTests(dir, []);

    expect(r.output).toBe(NO_TEST_RUNNER);
    // The published string must not carry the checkout root, a drive letter,
    // or the node ENOENT shape it used to.
    expect(r.output).not.toContain(dir);
    expect(r.output).not.toMatch(/ENOENT|[A-Za-z]:[\/]|\/(?:home|Users|tmp)\//);
  });

  it('is inconclusive, not not_run -- it has not proven there are no tests', () => {
    // `not_run` means "there was nothing to run". This gate cannot claim that
    // about a repo whose suite may be pytest: it only knows it cannot reach it.
    // The distinction is not cosmetic -- a required test gate must still block.
    expect(NO_TEST_RUNNER).toMatch(/only `npm test` is supported/);
  });
});
