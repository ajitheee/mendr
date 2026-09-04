import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// END-TO-END wiring tests for the eval gate: the report claim, the downgrade,
// and the --write refusal. These are the behaviors that actually protect a
// user's working tree, and none of them is observable from a unit test of
// runRepoEval alone — they live in how cli.ts sequences the gates.
//
// Hermetic: the fixture repo is a two-file TypeScript project in the OS temp
// dir whose "evaluation" is a `node eval.js` script with a hard-coded exit
// code. No network, no model call, no installed dependencies. The CLI is run
// from source through tsx (the same entry point `mendr` ships).

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

/** A fixture repo with one live deprecated model arg and the given eval exit code. */
function makeRepo(opts: { evalExitCode?: number; config?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-evalgate-'));
  created.push(dir);
  // No "test" script: the test gate reports inconclusive, which does not block
  // Tier A, so the eval gate is the only thing deciding the tier here.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'evalgate-fixture' }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'chat.ts'),
    [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export async function chat() {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  if (opts.evalExitCode !== undefined) {
    writeFileSync(join(dir, 'eval.js'), `process.exit(${opts.evalExitCode});\n`);
  }
  if (opts.config !== undefined) writeFileSync(join(dir, 'mendr.config.json'), opts.config);
  return dir;
}

/** Run fix-llm from source. `reject: false` — a non-zero exit is data here. */
async function runFixLlm(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'fix-llm', ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
    windowsHide: true,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const chatText = (repo: string): string => readFileSync(join(repo, 'src', 'chat.ts'), 'utf8');

describe('fix-llm eval gate wiring', () => {
  it(
    'without a config: Tier A stands, behavior is NOT tested, and the report says how to enable it',
    async () => {
      const repo = makeRepo({});
      const { exitCode, stdout } = await runFixLlm([repo]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Tier A');
      expect(stdout).toContain('Behavioral verification (NOT checked):');
      expect(stdout).toContain('"evalCommand" in mendr.config.json');
      expect(stdout).toContain('behavioral evaluation:  not configured');
      expect(stdout).not.toContain('behavioral evaluation:  passed');
    },
    120_000,
  );

  it(
    'a PASSING eval keeps Tier A, states the pass, and --write applies the fix',
    async () => {
      const repo = makeRepo({
        evalExitCode: 0,
        config: JSON.stringify({ evalCommand: 'node eval.js' }),
      });
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        'behavioral evaluation:  passed (your eval command: node eval.js, exit 0)',
      );
      expect(stdout).toContain('your eval command passed');
      expect(stdout).toContain('Applied the verified Tier A fix');
      expect(chatText(repo)).toContain('gpt-5.6-sol');
    },
    120_000,
  );

  it(
    'a FAILING eval downgrades Tier A, refuses --write, leaves the file alone, and exits non-zero',
    async () => {
      const repo = makeRepo({
        evalExitCode: 1,
        config: JSON.stringify({ evalCommand: 'node eval.js' }),
      });
      const before = chatText(repo);
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(exitCode).toBe(1);
      expect(stdout).toContain('NOT APPLIED (gates failed, review only)');
      expect(stdout).toContain(
        'behavioral evaluation:  failed (your eval command: node eval.js, exit 1)',
      );
      expect(stdout).toContain('your eval command failed against the patched code');
      expect(stdout).toContain('Refusing to --write the Tier A candidates that failed their gates');
      // THE POINT: a behavioral regression never reaches the working tree.
      expect(chatText(repo)).toBe(before);
      expect(chatText(repo)).toContain('gpt-4-0613');
    },
    120_000,
  );

  it(
    '--eval-command overrides the config file',
    async () => {
      // The config would pass; the flag fails. The flag must win, which is only
      // visible as a downgrade.
      const repo = makeRepo({
        evalExitCode: 0,
        config: JSON.stringify({ evalCommand: 'node eval.js' }),
      });
      writeFileSync(join(repo, 'strict-eval.js'), 'process.exit(2);\n');
      const { exitCode, stdout } = await runFixLlm([
        repo,
        '--eval-command',
        'node strict-eval.js',
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        'behavioral evaluation:  failed (your eval command: node strict-eval.js, exit 2)',
      );
    },
    120_000,
  );

  it(
    'reports the eval outcome in --json (behavioralVerification + eval object)',
    async () => {
      const repo = makeRepo({
        evalExitCode: 0,
        config: JSON.stringify({ evalCommand: 'node eval.js' }),
      });
      const { stdout } = await runFixLlm([repo, '--json']);
      const doc = JSON.parse(stdout);
      expect(doc.summary.behavioralVerification).toBe('pass');
      expect(doc.eval).toEqual({ command: 'node eval.js', exitCode: 0, status: 'pass' });
    },
    120_000,
  );

  it(
    'omits the eval object and reports not-tested when nothing was configured',
    async () => {
      const repo = makeRepo({});
      const { stdout } = await runFixLlm([repo, '--json']);
      const doc = JSON.parse(stdout);
      expect(doc.summary.behavioralVerification).toBe('not-tested');
      expect(doc.eval).toBeUndefined();
    },
    120_000,
  );

  it(
    'reports the inconclusive case in --json with a reason, and still says NOT tested',
    async () => {
      const repo = makeRepo({ config: JSON.stringify({ evalCommand: 'node hang.js', evalTimeoutMs: 1500 }) });
      writeFileSync(join(repo, 'hang.js'), 'setTimeout(() => process.exit(0), 60000);\n');
      const { exitCode, stdout } = await runFixLlm([repo, '--json']);
      const doc = JSON.parse(stdout);
      expect(exitCode).toBe(1);
      // Nothing was verified, so nothing may read as verified.
      expect(doc.summary.behavioralVerification).toBe('not-tested');
      expect(doc.eval.status).toBe('inconclusive');
      expect(doc.eval.reason).toMatch(/timed out after 1500ms/);
    },
    120_000,
  );

  it(
    'a malformed mendr.config.json is a hard error naming the file, not a silent skip',
    async () => {
      const repo = makeRepo({ config: '{ "evalCommand": }' });
      const { exitCode, stdout, stderr } = await runFixLlm([repo]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('mendr.config.json');
      // It must fail BEFORE printing a report a user could act on.
      expect(stdout).not.toContain('Tier A');
    },
    120_000,
  );
});

// THE GATE FAILS CLOSED. Every test here is the same shape: an eval command was
// CONFIGURED, it did not produce a clean pass, and --write must therefore change
// nothing. The old behavior applied the fix and exited 0, leaving one stderr
// line as the only trace -- a user who asked for behavioral verification, did
// not get it, and got the write anyway.
describe('fix-llm eval gate: fails CLOSED when a configured eval cannot run', () => {
  it(
    'a TIMED-OUT eval with --write leaves the file alone and exits non-zero',
    async () => {
      const repo = makeRepo({
        config: JSON.stringify({ evalCommand: 'node hang.js', evalTimeoutMs: 1500 }),
      });
      writeFileSync(join(repo, 'hang.js'), 'setTimeout(() => process.exit(0), 60000);\n');
      const before = chatText(repo);
      const { exitCode, stdout, stderr } = await runFixLlm([repo, '--write']);

      expect(exitCode).toBe(1);
      expect(chatText(repo)).toBe(before);
      expect(chatText(repo)).toContain('gpt-4-0613');
      expect(stdout).toContain('NOT APPLIED (gates failed, review only)');
      // Names the CASE, not just "something went wrong".
      expect(stdout).toContain('your eval command was configured but produced no verdict');
      expect(stdout).toContain('timed out after 1500ms');
      expect(stdout).toContain('mendr will not apply a fix it could not behaviorally verify');
      expect(stdout).toContain('Refusing to --write the Tier A candidates that failed their gates');
      expect(stderr).toContain('the fix is NOT applied');
    },
    120_000,
  );

  it(
    'a COMMAND-NOT-FOUND eval with --write leaves the file alone and exits non-zero',
    async () => {
      // Through a shell, a missing command is just a non-zero exit -- mendr
      // cannot tell it apart from a real regression, and does not pretend to.
      // Both block the write, which is the property that matters here.
      const repo = makeRepo({
        config: JSON.stringify({ evalCommand: 'mendr-no-such-command-xyz --run' }),
      });
      const before = chatText(repo);
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(exitCode).toBe(1);
      expect(chatText(repo)).toBe(before);
      expect(stdout).toContain('NOT APPLIED (gates failed, review only)');
      expect(stdout).toContain('Refusing to --write the Tier A candidates that failed their gates');
      expect(stdout).not.toContain('Applied the verified Tier A fix');
      // The report tells that user where to look instead of alleging a regression.
      expect(stdout).toContain('a command that could not run');
    },
    120_000,
  );

  it(
    'NOT-CONFIGURED is unchanged: --write still applies the fix on the code gates alone',
    async () => {
      // The boundary of the fail-closed rule. A repo that never asked for
      // behavioral verification is not punished for not having it.
      const repo = makeRepo({});
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Applied the verified Tier A fix');
      expect(stdout).toContain('Behavioral verification (NOT checked):');
      expect(chatText(repo)).toContain('gpt-5.6-sol');
    },
    120_000,
  );
});
