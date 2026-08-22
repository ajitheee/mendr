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
  'export async function chat(client: any) {',
  "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
  '}',
  '',
].join('\n');

/**
 * A repo with ONE Tier A swap and a test script mendr cannot run: the package
 * declares `npm test` but nothing is installed, so the test gate comes back
 * `inconclusive` — a real suite that exists and could not be executed, which is
 * not the same fact as "this repo has no tests".
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
      const repo = makeRepo({ gates: { tests: { required: false } } });
      const { exitCode, stdout } = await runFixLlm([repo]);

      expect(stdout).toContain('=== Tier A: auto-fixable model-id + param codemod (VERIFIED) ===');
      expect(stdout).toMatch(/^ {2}tests: +inconclusive \(.*node_modules.*\)$/m);
      expect(stdout).not.toMatch(/^ {2}tests: +(passed|not configured)/m);
      expect(stdout).not.toContain('[required]  ');
      expect(stdout).not.toContain('required gate "tests"');
      expect(exitCode).toBe(0);
    },
    180_000,
  );

  it(
    'the default policy leaves tests advisory (unchanged behavior for an unconfigured repo)',
    async () => {
      const { exitCode, stdout } = await runFixLlm([makeRepo()]);
      expect(stdout).toContain('=== Tier A: auto-fixable model-id + param codemod (VERIFIED) ===');
      expect(stdout).toMatch(/^ {2}tests: +inconclusive/m);
      expect(exitCode).toBe(0);
    },
    180_000,
  );
});

describe('a required eval gate', () => {
  it(
    'a FAILING required eval blocks Tier A and names the command',
    async () => {
      const repo = makeRepo({
        gates: { tests: { required: false }, eval: { command: 'node eval.js', required: true } },
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
      const repo = makeRepo({ gates: { eval: { command: 'node eval.js' } } });
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
      const repo = makeRepo({ gates: { eval: { command: 'node eval.js', required: false } } });
      writeFileSync(join(repo, 'eval.js'), 'process.exit(1);\n');
      const { exitCode, stdout } = await runFixLlm([repo]);
      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  it(
    'a required eval with NO command blocks rather than dropping the requirement',
    async () => {
      const repo = makeRepo({ gates: { eval: { required: true } } });
      const { exitCode, stdout, stderr } = await runFixLlm([repo]);
      expect(stdout).toContain('=== Tier A candidate -> NOT APPLIED (gates failed, review only) ===');
      expect(stdout).toMatch(/^ {2}behavioral evaluation: +not configured {2}\[required\]$/m);
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
      // The type-check ran and passed; it is not what blocked the fix.
      const typecheck = doc.gates.outcomes.find((o: { gate: string }) => o.gate === 'typecheck');
      expect(typecheck).toMatchObject({ outcome: 'pass', required: true, blocking: false });
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
