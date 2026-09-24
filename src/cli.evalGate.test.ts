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
// Hermetic: the fixture repo is a small TypeScript project in the OS temp dir
// whose "evaluation" is a `node eval.js` script with a hard-coded exit code. No
// network, no model call, and the only "dependency" is a hand-written `openai`
// declaration written by makeRepo (see installOpenAITypes for why it has to
// exist). The CLI is run from source through tsx (the same entry point `mendr`
// ships).

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

/**
 * A hermetic stand-in for an installed `openai` package: just enough for the
 * type-check gate to RESOLVE the import and check the call site.
 *
 * `model: string` is deliberate, and it matches the real SDK, which types the
 * field as a named union widened with `(string & {})` — so the stub does not
 * make the gate stricter than the genuine article, only present.
 */
function installOpenAITypes(dir: string): void {
  const pkg = join(dir, 'node_modules', 'openai');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'openai', version: '4.0.0', main: 'index.js', types: 'index.d.ts' }, null, 2),
  );
  writeFileSync(
    join(pkg, 'index.d.ts'),
    [
      'declare class OpenAI {',
      '  chat: {',
      '    completions: {',
      '      create(body: { model: string; messages: unknown[] }): Promise<unknown>;',
      '    };',
      '  };',
      '}',
      'export default OpenAI;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(pkg, 'index.js'), 'module.exports = class OpenAI {};\n');
}

/**
 * A fixture repo with one live deprecated model arg and the given eval exit code.
 *
 * WHY THIS FIXTURE INSTALLS TYPES. A type-check that ran with the SDK
 * unresolved is now `inconclusive`, never `passed`: the argument it would have
 * rejected was `any`, so nothing could have failed. The type-check gate is
 * required by default, so a dependency-less fixture no longer gets past the
 * CODE gates — and the eval gate runs ONLY after they pass, which means it
 * would never run at all here. The stub is how the fixture earns a real
 * type-check pass and puts the eval gate back in charge of the tier, which is
 * the whole subject of this file. `noTypes: true` asks for the blind case
 * on purpose; exactly one test below wants it.
 */
function makeRepo(opts: { evalExitCode?: number; config?: string; noTypes?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-evalgate-'));
  created.push(dir);
  // No "test" script: the test gate reports `not_run` — there is nothing to run
  // — which does not block Tier A, so the eval gate is the only thing deciding
  // the tier here.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'evalgate-fixture' }, null, 2));
  if (!opts.noTypes) installOpenAITypes(dir);
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
      // WORDING: the row word for "there was nothing to run" is `not run`.
      // "not configured" was a second spelling of it and is gone.
      expect(stdout).toContain('behavioral evaluation:  not run');
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
      // WORDING: the machine surface carries the same word as the report —
      // `passed`, not `pass`. One vocabulary, every surface.
      expect(doc.summary.behavioralVerification).toBe('passed');
      expect(doc.eval).toEqual({ command: 'node eval.js', exitCode: 0, status: 'passed' });
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
    'NOT RUN (no eval configured) is unchanged: --write still applies the fix on the code gates alone',
    async () => {
      // The boundary of the fail-closed rule. A repo that never asked for
      // behavioral verification is not punished for not having it. `not_run`
      // means there was nothing to run, which is exactly why it does not
      // block — unlike `inconclusive`, which means mendr tried and cannot say.
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

// BEHAVIOUR CHANGE, and the reason every other fixture in this file installs
// types: a type-check that ran with the SDK unresolved is `inconclusive`, not
// `passed`, because the model argument it would have rejected was `any`. The
// type-check gate is required by default, so a dependency-less checkout does
// not clear the CODE gates — and the eval gate runs only after they do.
//
// The interaction is worth its own test, because the eval-gate row in that
// situation is a claim about a run that never happened, and the previous
// vocabulary had no way to say so: "not configured" over a repo whose config
// names an eval command sent the reader to configure what they already had.
describe('fix-llm eval gate: a blind type-check stops the eval from running at all', () => {
  it(
    'a dependency-less checkout is inconclusive, never starts the eval, and writes nothing',
    async () => {
      const repo = makeRepo({
        evalExitCode: 0,
        config: JSON.stringify({ evalCommand: 'node eval.js' }),
        noTypes: true,
      });
      const before = chatText(repo);
      const { exitCode, stdout } = await runFixLlm([repo, '--write']);

      expect(exitCode).toBe(1);
      // The blocker is the type-check, and it still NAMES what it could not see
      // -- the state now carries what a detail string used to, and a state
      // cannot be dropped by a downstream renderer.
      expect(stdout).toContain('type-check:             inconclusive');
      expect(stdout).toContain('1 package not installed in this checkout (openai)');
      expect(stdout).not.toContain('type-check:             passed');
      // ...so the eval never started, and the row says THAT rather than
      // implying the user failed to configure one.
      expect(stdout).toContain('behavioral evaluation:  inconclusive');
      expect(stdout).toContain('the code gates above did not pass, so mendr never ran your eval');
      expect(stdout).not.toContain('behavioral evaluation:  passed');
      expect(stdout).not.toContain('behavioral evaluation:  not run');
      // THE POINT: an unverified fix never reaches the working tree.
      expect(chatText(repo)).toBe(before);
      expect(chatText(repo)).toContain('gpt-4-0613');
    },
    120_000,
  );
});
