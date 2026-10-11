import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// THE ACTION'S DECISION, RUN AS SHELL.
//
// v0.5.10-alpha's known issue, the half that did the damage: when `migrate` changed nothing,
// run-mendr.sh read `no_migration` as clean, CLOSED an open Mendr pull request with "no deprecated
// model ids remain", and reported `clean` to the App, even when every retiring id in the
// repository had been held for a person. The decision now lives in mendr-action/scripts/outcome.sh
// and reads the artifact's held count; only a count of exactly zero is clean.
//
// Two layers:
//   1. outcome.sh's functions, sourced on their own (bash only);
//   2. run-mendr.sh itself, end to end, with `npx`, `npm`, `gh` and `git` replaced by stubs that
//      record what they were asked to do, so the test can see whether a pull request was closed.
//      One case feeds it the artifact and report the real CLI produces for a held-only repository.
//
// jq: the script needs it, and GitHub's runners have it. Where it is missing (a Windows machine
// with Git Bash, say) a stand-in that answers only the filters this path uses is put on PATH; an
// unknown filter fails loudly, so a new filter in the script cannot pass here by accident.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(MENDR_ROOT, 'mendr-action', 'scripts').replace(/\\/g, '/');

/** A POSIX bash we can drive: Git Bash on Windows, never WSL's (its paths are not ours). */
function bashUsable(): boolean {
  try {
    const uname = execFileSync('bash', ['-c', 'uname -s'], { encoding: 'utf8', windowsHide: true }).trim();
    return process.platform !== 'win32' || !/^Linux/.test(uname);
  } catch {
    return false;
  }
}
const BASH = bashUsable();

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

async function sh(script: string): Promise<string> {
  const r = await execa('bash', ['-c', `. "${SCRIPTS}/outcome.sh"; ${script}`], { reject: false, windowsHide: true });
  expect(r.exitCode, r.stderr).toBe(0);
  return r.stdout;
}

describe.skipIf(!BASH)('outcome.sh: what a run that applied nothing means', () => {
  it('is clean only for no_migration with a held count of exactly zero', async () => {
    expect(await sh('nothing_applied_outcome no_migration 0')).toBe('clean');
    expect(await sh('nothing_applied_outcome no_migration 00')).toBe('clean');
    expect(await sh('nothing_applied_outcome no_migration 2')).toBe('held-for-review');
    // An unreadable count is never read as zero.
    expect(await sh('nothing_applied_outcome no_migration unknown')).toBe('held-for-review');
    expect(await sh('nothing_applied_outcome no_migration ""')).toBe('held-for-review');
    expect(await sh('nothing_applied_outcome no_migration -1')).toBe('held-for-review');
  });

  it('is held-for-review for the held verdict, whatever the count says', async () => {
    expect(await sh('nothing_applied_outcome held_for_review 3')).toBe('held-for-review');
    expect(await sh('nothing_applied_outcome held_for_review 0')).toBe('held-for-review');
  });

  it('is not-verified for anything else, as before', async () => {
    for (const v of ['inconclusive', 'failed', 'verified', 'null', '']) {
      expect(await sh(`nothing_applied_outcome "${v}" 0`)).toBe('not-verified');
    }
  });

  it('lets only an unrestricted run close a pull request as resolved', async () => {
    expect(await sh('may_close_as_resolved "" && echo yes || echo no')).toBe('yes');
    expect(await sh('may_close_as_resolved "openai/gpt-4" && echo yes || echo no')).toBe('no');
  });

  it('says how many places need a person, in a plain sentence', async () => {
    expect(await sh('held_sentence 1')).toBe(
      'Mendr: 1 place in the code still uses a retiring model id and needs a person. It was held for review, not migrated, so this repository is not clean.',
    );
    expect(await sh('held_sentence 7')).toContain('Mendr: 7 places in the code still use a retiring model id and need a person.');
    expect(await sh('held_sentence unknown')).toContain('the number could not be read');
  });
});

// --- run-mendr.sh, end to end, with stubs -------------------------------------------------------

/** The jq filters run-mendr.sh uses on the nothing-applied path, answered in JS. */
const JQ_STAND_IN = `
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2).filter((a) => a !== '-r' && a !== '-e');
const [filter, file] = args;
let doc;
try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { process.exit(2); }
const v = doc && doc.verification;
const answers = {
  '.': () => JSON.stringify(doc),
  '.verification.verdict': () => String(v?.verdict ?? null),
  'if (.skipped | type) == "array" then (.skipped | length) else "unknown" end': () => (Array.isArray(doc.skipped) ? String(doc.skipped.length) : 'unknown'),
  '.verification | "\\\\(.typeCheck.status) \\\\(.build.status) \\\\(.tests.status) \\\\(.eval.status)"': () => [v.typeCheck.status, v.build.status, v.tests.status, v.eval.status].join(' '),
};
const answer = answers[filter];
if (!answer) { process.stderr.write('jq stand-in: unsupported filter ' + filter + '\\n'); process.exit(5); }
process.stdout.write(answer() + '\\n');
`;

function stubs(dir: string, needJq: boolean): void {
  const bin = (name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  // npx: `npx --yes <spec> migrate . [...]` prints the prepared report or artifact; `redact <file>`
  // prints the file. Every call is logged, so the test can see the sanitizer ran.
  bin(
    'npx',
    [
      'echo "$*" >> "$NPX_LOG"',
      'case "$3" in',
      '  migrate) case " $* " in *" --json "*) cat "$ARTIFACT_FIXTURE" ;; *) cat "$REPORT_FIXTURE" ;; esac ;;',
      '  redact) cat "$4" ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'),
  );
  bin('npm', '[ "$1" = "--version" ] && echo 11.0.0; exit 0');
  // gh: every call logged; `pr list` answers with the open Mendr pull request, if any.
  bin('gh', 'echo "$*" >> "$GH_LOG"\nif [ "$1 $2" = "pr list" ]; then echo "${GH_OPEN_PR:-}"; fi\nexit 0');
  // git: nothing changed in the working tree (the nothing-applied path); anything else is logged.
  bin('git', 'if [ "$1" = "diff" ]; then exit 0; fi\necho "git $*" >> "$GH_LOG"\nexit 0');
  if (needJq) {
    writeFileSync(join(dir, 'jq-stand-in.mjs'), JQ_STAND_IN);
    bin('jq', 'exec node "$(dirname "$0")/jq-stand-in.mjs" "$@"');
  }
}

function hasRealJq(): boolean {
  if (!BASH) return false;
  try {
    execFileSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const REAL_JQ = hasRealJq();

interface Run {
  exitCode: number;
  log: string;
  outputs: string;
  summary: string;
  gh: string;
  npx: string;
}

/** Run run-mendr.sh in a temp checkout with the given artifact and human report. */
async function runAction(artifact: unknown, report: string, env: Record<string, string> = {}): Promise<Run> {
  const work = tempDir('mendr-action-run-');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  stubs(bin, !REAL_JQ);
  const files = {
    artifact: join(work, 'artifact.json'),
    report: join(work, 'report.txt'),
    outputs: join(work, 'github-output'),
    summary: join(work, 'step-summary'),
    gh: join(work, 'gh.log'),
    npx: join(work, 'npx.log'),
  };
  writeFileSync(files.artifact, typeof artifact === 'string' ? artifact : JSON.stringify(artifact));
  writeFileSync(files.report, report);
  for (const f of [files.outputs, files.summary, files.gh, files.npx]) writeFileSync(f, '');
  const checkout = join(work, 'checkout');
  mkdirSync(checkout);

  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.toUpperCase() === 'PATH' || k.startsWith('MENDR_') || k.startsWith('GITHUB_') || k.startsWith('ACTIONS_')) continue;
    base[k] = v;
  }
  const posix = (p: string) => p.replace(/\\/g, '/');
  const r = await execa('bash', [`${SCRIPTS}/run-mendr.sh`], {
    cwd: checkout,
    reject: false,
    windowsHide: true,
    extendEnv: false,
    env: {
      ...base,
      PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      GITHUB_OUTPUT: posix(files.outputs),
      GITHUB_STEP_SUMMARY: posix(files.summary),
      GITHUB_ACTION_PATH: posix(join(MENDR_ROOT, 'mendr-action')),
      MENDR_SPEC: 'mendr@test',
      MENDR_BRANCH: 'mendr/deprecated-model-ids',
      MENDR_LABELS: '',
      ARTIFACT_FIXTURE: posix(files.artifact),
      REPORT_FIXTURE: posix(files.report),
      GH_LOG: posix(files.gh),
      NPX_LOG: posix(files.npx),
      GH_OPEN_PR: '7',
      ...env,
    },
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return {
    exitCode: r.exitCode ?? -1,
    log: `${r.stdout}\n${r.stderr}`,
    outputs: read(files.outputs),
    summary: read(files.summary),
    gh: read(files.gh),
    npx: read(files.npx),
  };
}

const gates = { typeCheck: { status: 'not_run' }, build: { status: 'not_run' }, tests: { status: 'not_run' }, eval: { status: 'not_run' } };
function artifact(verdict: string, skipped: unknown, migrated = false): Record<string, unknown> {
  return {
    schema: 'mendr-migration/v1',
    generatedBy: 'mendr',
    repo: 'acme',
    generatedAt: '2026-10-10T00:00:00Z',
    sha: null,
    migrated,
    migrations: [],
    paramTransforms: [],
    skipped,
    changedFiles: [],
    diff: '',
    verification: { ...gates, behavioralTested: false, verdict },
    prReady: false,
    notes: [],
  };
}
const HELD = [
  { file: 'src/ask.ts', line: 3, column: 15, model: 'claude-opus-4-1-20250805', replacement: 'claude-opus-4-8', code: 'coupled_param_unverified', reason: 'held', language: 'ts' },
  { file: 'app/llm.py', line: 9, column: 49, model: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', code: 'param_behaviour_change', reason: 'held', language: 'py' },
];
const closed = (gh: string) => /^pr close /m.test(gh);

describe.skipIf(!BASH)('run-mendr.sh when the migration changed nothing', { timeout: 120_000 }, () => {
  it('closes the open Mendr pull request only when nothing was migrated and nothing was held', async () => {
    const r = await runAction(artifact('no_migration', []), 'NO MIGRATION\n');
    expect(r.exitCode, r.log).toBe(0);
    expect(r.outputs).toContain('outcome=clean');
    expect(r.gh).toMatch(/^pr close 7 --comment Mendr: nothing is left to migrate or review\. No call or model setting in the code uses a retiring model id; closing\. --delete-branch$/m);
    expect(r.log).toContain('Mendr: nothing to migrate and nothing held for review. No PR opened.');
    // The report was published only after it went through `mendr redact`.
    expect(r.npx).toMatch(/ redact /);
  });

  it('reports held-for-review, leaves the pull request open, and says how many places need a person', async () => {
    const r = await runAction(artifact('held_for_review', HELD), 'HELD FOR REVIEW\n\nHeld for review (2)\n  src/ask.ts:3 ...\n');
    expect(r.exitCode, r.log).toBe(0);
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(r.outputs).not.toContain('outcome=clean');
    expect(closed(r.gh)).toBe(false);
    expect(r.log).not.toContain('no deprecated model ids remain');
    expect(r.log).toContain('Mendr: 2 places in the code still use a retiring model id and need a person.');
    expect(r.log).toContain('Any open Mendr PR is left as it is.');
    expect(r.log).toContain('::warning::Mendr: 2 places in the code still use a retiring model id');
    // The job summary carries the sentence and the sanitized report with the list.
    expect(r.summary).toContain('**Mendr: 2 places in the code still use a retiring model id and need a person.');
    expect(r.summary).toContain('Held for review (2)');
    expect(r.npx).toMatch(/ redact /);
  });

  it('never reads an older artifact that says no_migration over held calls as clean', async () => {
    const r = await runAction(artifact('no_migration', HELD.slice(0, 1)), 'NO MIGRATION\n');
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(closed(r.gh)).toBe(false);
    expect(r.log).toContain('Mendr: 1 place in the code still uses a retiring model id and needs a person.');
  });

  it('never reads a held list it cannot count as clean', async () => {
    const r = await runAction(artifact('no_migration', 'n/a'), 'NO MIGRATION\n');
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(closed(r.gh)).toBe(false);
    expect(r.summary).toContain('the number could not be read');
  });

  it('does not close a pull request on an approval-gated run, which looked only at the approved models', async () => {
    const r = await runAction(artifact('no_migration', []), 'NO MIGRATION\n', { MENDR_ONLY: 'openai/gpt-4' });
    expect(r.outputs).toContain('outcome=clean');
    expect(closed(r.gh)).toBe(false);
    expect(r.log).toContain('nothing to migrate for the approved models (openai/gpt-4)');
  });

  it('leaves everything alone when a migration did not verify, as before', async () => {
    const r = await runAction(artifact('inconclusive', [], true), 'INCONCLUSIVE\n');
    expect(r.outputs).toContain('outcome=not-verified');
    expect(closed(r.gh)).toBe(false);
  });

  it('decides from what the real CLI emits for a held-only repository', async () => {
    const repo = tempDir('mendr-action-held-repo-');
    writeFileSync(join(repo, 'package.json'), '{"name":"held"}');
    mkdirSync(join(repo, 'app'));
    writeFileSync(
      join(repo, 'app', 'llm.py'),
      'from openai import OpenAI\nclient = OpenAI()\n\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n',
    );
    const cli = (args: string[]) =>
      execa('tsx', ['src/cli.ts', 'migrate', repo, '--skip-verify', ...args], {
        cwd: MENDR_ROOT,
        preferLocal: true,
        reject: false,
        windowsHide: true,
        env: { ...process.env, MENDR_REGISTRY_MAX_AGE_DAYS: '100000' },
      });
    const json = await cli(['--json']);
    const human = await cli([]);
    expect(JSON.parse(json.stdout).verification.verdict).toBe('held_for_review');

    const r = await runAction(json.stdout, human.stdout);
    expect(r.exitCode, r.log).toBe(0);
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(closed(r.gh)).toBe(false);
    expect(r.summary).toContain('**Mendr: 1 place in the code still uses a retiring model id and needs a person.');
    expect(r.summary).toContain('app/llm.py:5  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]');
  });
});
