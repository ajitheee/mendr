import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// END-TO-END for the CONFIGURABLE GATE POLICY. The unit tests in
// gates/policy.test.ts prove the decision; these prove the WIRING, which is
// where the interesting failure lives: a policy that downgrades the tier in the
// report while `--write` still writes, or an exit code that says success over a
// gate that never ran, is worse than no policy at all.
//
// Hermetic: temp-dir fixtures, no network, and deliberately NO installed
// node_modules — which is exactly the state that makes the test gate
// inconclusive, the case this whole feature exists to let a repo decide about.
// The same missing node_modules now makes the TYPE-CHECK gate inconclusive too
// (it runs blind: the types that would reject a bad model id are unresolved),
// and that gate is required by default — so a fixture that wants some OTHER
// gate to be the deciding one says `gates: { typecheck: { required: false } }`
// and says why. See makeRepo below.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const CALL_SITE = [
  'import OpenAI from "openai";',
  'const client = new OpenAI();',
  'export async function chat() {',
  "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
  '}',
  '',
].join('\n');

/**
 * A repo with ONE Tier A swap and a test script mendr cannot run: the package
 * declares `npm test` but nothing is installed, so the test gate comes back
 * `inconclusive` — a real suite that exists and could not be executed, which is
 * not the same fact as "this repo has no tests".
 *
 * The missing node_modules costs the TYPE-CHECK gate its verdict too: with the
 * SDK unresolved, the model argument is `any` and nothing could have failed, so
 * that gate is `inconclusive` as well — and it is required by default, so any
 * test here that needs a gate OTHER than the type-check to be the deciding one
 * must pass `gates: { typecheck: { required: false } }`.
 */
function makeRepo(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-gate-policy-'));
  created.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'gate-policy-fixture', scripts: { test: 'vitest run' } }, null, 2),
  );
  if (config) writeFileSync(join(dir, 'mendr.config.json'), JSON.stringify(config, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'chat.ts'), CALL_SITE);
  return dir;
}

/** Run fix-llm from source. `reject: false` — a non-zero exit is data here. */
async function runFixLlm(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'fix-llm', ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

describe('a required gate that cannot run blocks Tier A', () => {
  it(
    'gates.tests.required = true: downgraded, --write refused, exit non-zero, gate named',
    async () => {
      const repo = makeRepo({ gates: { tests: { required: true } } });
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      // WHICH gate, and what it returned. "gates failed" alone would leave the
      // user guessing between the type-check, the tests and their eval.
      expect(stdout).toContain('required gate "tests" did not pass');
      expect(stdout).toContain('the tests gate could not run');
      // The row itself never launders the missing run into a pass.
      expect(stdout).toMatch(/^ {2}tests: +inconclusive \(.*node_modules.*\) {2}\[required\]$/m);
      expect(stdout).not.toMatch(/^ {2}tests: +passed/m);
      // The working tree is untouched, and the summary says so rather than
      // counting the patch as applied.
      expect(readFileSync(join(repo, 'src', 'chat.ts'), 'utf8')).toBe(CALL_SITE);
      expect(stdout).toContain('Refusing to --write the Tier A candidates that failed their gates');
      // A script must be able to see the refusal in $?.
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  it(
    'gates.tests.required = false: Tier A stands, and tests still report inconclusive',
    async () => {
      // The same repo, same un-runnable suite, opposite policy. The OUTCOME
      // word does not change with the policy -- only whether it blocks.
      //
      // `typecheck: { required: false }` is here for the SAME reason the suite
      // is un-runnable: with no node_modules the type-check runs BLIND (the SDK
      // types that would reject a bad model id are unresolved, so nothing could
      // have failed), which is now `inconclusive` rather than `passed`. The
      // type-check gate is required by default, so at the default policy it
      // would block this run before the TESTS policy could be observed at all.
      // Opting it out isolates the gate this test is about.
      const repo = makeRepo({
        gates: { typecheck: { required: false }, tests: { required: false } },
      });
      const { exitCode, stdout } = await runFixLlm([repo]);

      // NOT "(VERIFIED)". The patch is applied — neither gate is required here,
      // so nothing blocks it — but the type-check ran blind, and the heading
      // says which of those two things happened. Asserting `(VERIFIED)` over an
      // `inconclusive` type-check row is the contradiction this milestone
      // exists to remove: one run, one check, two surfaces disagreeing.
      expect(stdout).toContain('=== Tier A: auto-fixable model-id + param codemod (NOT type-verified) ===');
      expect(stdout).not.toContain('(VERIFIED)');
      expect(stdout).toMatch(/^ {2}tests: +inconclusive \(.*node_modules.*\)$/m);
      expect(stdout).not.toMatch(/^ {2}tests: +(passed|not run)/m);
      // The blind type-check names itself as blind, in its own state word.
      expect(stdout).toMatch(/^ {2}type-check: +inconclusive \(ran without the types.*\)$/m);
      // Neither gate is required under this policy, so no row wears the tag.
      expect(stdout).not.toContain('[required]');
      expect(stdout).not.toContain('required gate "tests"');
      expect(exitCode).toBe(0);
    },
    180_000,
  );

  it(
    'the default policy leaves tests advisory -- but a BLIND type-check now blocks',
    async () => {
      // BEHAVIOUR CHANGE. This used to assert "unchanged behavior for an
      // unconfigured repo": Tier A (VERIFIED), exit 0. It cannot any more, and
      // the reason is the point of the change rather than an accident of it.
      //
      // A type-check against a checkout with no node_modules completes and
      // reports no new errors -- but the SDK types that would have rejected a
      // bad model id were never loaded, so the model argument is `any` and
      // nothing could have failed. That is `inconclusive`, not `passed`, and
      // because the type-check gate is REQUIRED BY DEFAULT it blocks Tier A on
      // a dependency-less checkout. Install dependencies to earn the pass.
      //
      // What this test still guards is the TESTS half of the default policy:
      // an un-runnable suite stays advisory. It reports `inconclusive`, it
      // carries no [required] tag, and it is not the gate the block names.
      const { exitCode, stdout } = await runFixLlm([makeRepo()]);
      expect(stdout).toMatch(/^ {2}tests: +inconclusive/m);
      expect(stdout).not.toMatch(/^ {2}tests:.*\[required\]$/m);
      expect(stdout).not.toContain('required gate "tests"');
      // ...and the type-check is: required by default, inconclusive, blocking.
      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      expect(stdout).toMatch(
        /^ {2}type-check: +inconclusive \(ran without the types.*\) {2}\[required\]$/m,
      );
      expect(stdout).toContain('required gate "typecheck" did not pass');
      expect(stdout).toContain('the type-check gate could not run');
      expect(exitCode).toBe(1);
    },
    180_000,
  );
});

describe('a required eval gate', () => {
  it(
    'a FAILING required eval blocks Tier A and names the command',
    async () => {
      // `typecheck: { required: false }`: the eval gate only runs AFTER the code
      // gates pass, and a blind type-check is now `inconclusive` (required by
      // default) in this dependency-less fixture -- which would stop mendr ever
      // starting the eval, and this test is about what the eval's own failure
      // reports.
      const repo = makeRepo({
        gates: {
          typecheck: { required: false },
          tests: { required: false },
          eval: { command: 'node eval.js', required: true },
        },
      });
      writeFileSync(join(repo, 'eval.js'), 'process.exit(3);\n');
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      expect(stdout).toMatch(
        /^ {2}behavioral evaluation: +failed \(your eval command: node eval\.js, exit 3\) {2}\[required\]$/m,
      );
      expect(stdout).toContain('your eval command failed against the patched code (node eval.js, exit 3)');
      expect(readFileSync(join(repo, 'src', 'chat.ts'), 'utf8')).toBe(CALL_SITE);
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  it(
    'gates.eval.command is the same setting as the legacy evalCommand',
    async () => {
      // typecheck opted out for the same reason as above: an eval that mendr
      // never started cannot prove the two settings are the same setting.
      const repo = makeRepo({
        gates: { typecheck: { required: false }, eval: { command: 'node eval.js' } },
      });
      writeFileSync(join(repo, 'eval.js'), 'process.exit(0);\n');
      const { exitCode, stdout } = await runFixLlm([repo]);
      expect(stdout).toMatch(
        /^ {2}behavioral evaluation: +passed \(your eval command: node eval\.js, exit 0\) {2}\[required\]$/m,
      );
      expect(exitCode).toBe(0);
    },
    180_000,
  );

  it(
    'gates.eval.required = false makes a failing eval advisory -- but it still blocks',
    async () => {
      // `required: false` is not "ignore the result". A gate that RAN and came
      // back negative always blocks; the flag only governs the cases where the
      // gate could not produce a verdict at all.
      //
      // typecheck opted out deliberately: left at its default this test would
      // still go green on the blind type-check's block alone, and would no
      // longer prove anything about a failing-but-advisory eval.
      const repo = makeRepo({
        gates: { typecheck: { required: false }, eval: { command: 'node eval.js', required: false } },
      });
      writeFileSync(join(repo, 'eval.js'), 'process.exit(1);\n');
      const { exitCode, stdout } = await runFixLlm([repo]);
      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      // The eval RAN, and its own verdict -- not a required-gate tag -- is what
      // blocked: no [required] on the row, and the reason names their command.
      expect(stdout).toMatch(
        /^ {2}behavioral evaluation: +failed \(your eval command: node eval\.js, exit 1\)$/m,
      );
      expect(stdout).toContain('your eval command failed against the patched code (node eval.js, exit 1)');
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  it(
    'a required eval with NO command blocks rather than dropping the requirement',
    async () => {
      // typecheck opted out so the MISSING EVAL COMMAND is the only thing that
      // can block: at the default policy the blind type-check would block too,
      // and this test would pass even if the eval requirement were dropped.
      const repo = makeRepo({ gates: { typecheck: { required: false }, eval: { required: true } } });
      const { exitCode, stdout, stderr } = await runFixLlm([repo]);
      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      // The row word is `not run` (there was nothing to run), not the old
      // "not configured": one vocabulary, and "n/a" now survives only for a
      // registry attribution row -- never for a check.
      expect(stdout).toMatch(/^ {2}behavioral evaluation: +not run {2}\[required\]$/m);
      expect(`${stdout}${stderr}`).toContain('required gate "eval" did not pass');
      expect(exitCode).toBe(1);
    },
    180_000,
  );
});

describe('the gate policy in --json', () => {
  it(
    'itemizes policy and outcomes, and marks the blocking gate',
    async () => {
      const repo = makeRepo({ gates: { tests: { required: true } } });
      const { stdout, exitCode } = await runFixLlm([repo, '--json']);
      const doc = JSON.parse(stdout);

      expect(doc.gates.policy).toEqual({
        typecheck: { required: true },
        tests: { required: true },
        eval: { required: false, command: null },
      });
      const tests = doc.gates.outcomes.find(
        (o: { gate: string; language: string }) => o.gate === 'tests' && o.language === 'typescript',
      );
      expect(tests.outcome).toBe('inconclusive');
      expect(tests.required).toBe(true);
      expect(tests.blocking).toBe(true);
      // BEHAVIOUR CHANGE: the type-check used to be `pass`/non-blocking here.
      // In a checkout with no node_modules it ran BLIND -- the SDK types that
      // would reject a bad model id were never loaded -- so it is now
      // `inconclusive`, and being required by default it blocks as well. The
      // machine surface carries that as a STATE, which nothing downstream can
      // drop, where it used to carry a bare pass plus a detail string that the
      // PR body suppressed and the App discarded.
      const typecheck = doc.gates.outcomes.find((o: { gate: string }) => o.gate === 'typecheck');
      expect(typecheck).toMatchObject({
        outcome: 'inconclusive',
        required: true,
        blocking: true,
      });
      expect(typecheck.detail).toContain('not installed in this checkout');
      // `blocking` is still per-gate and not a blanket over every non-pass row:
      // the unconfigured eval is `not_run`, unrequired, and blocks nothing.
      const evaluation = doc.gates.outcomes.find((o: { gate: string }) => o.gate === 'eval');
      expect(evaluation).toMatchObject({ outcome: 'not_run', required: false, blocking: false });
      expect(exitCode).toBe(1);
    },
    180_000,
  );
});

describe('a malformed gates block', () => {
  it(
    'fails immediately, naming the file and the field, before any scanning',
    async () => {
      const repo = makeRepo({ gates: { tests: { requred: true } } });
      const { exitCode, stderr, stdout } = await runFixLlm([repo]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('mendr.config.json');
      expect(stderr).toContain('unknown field "gates.tests.requred"');
      // Nothing was scanned and nothing was reported: a config mendr cannot
      // honor must not produce a report that looks like it honored it.
      expect(stdout).toBe('');
    },
    120_000,
  );
});
