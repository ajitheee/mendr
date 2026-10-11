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
  const r = await execa('bash', ['-c', `. "${SCRIPTS}/outcome.sh"; . "${SCRIPTS}/pr-body.sh"; ${script}`], { reject: false, windowsHide: true });
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

  it('writes the held-for-review comment with a marker line that names the count and the scope', async () => {
    const all = await sh('held_pr_comment 3 "" ""');
    expect(all.split('\n')[0]).toBe('<!-- mendr-bot:held-for-review held=3 only= -->');
    expect(all).toContain('**Mendr no longer verifies this pull request.**');
    expect(all).toContain('Mendr: 3 places in the code still use a retiring model id and need a person.');
    expect(all).toContain('Do not merge on the strength of the earlier verification');
    expect(all).toContain('Each held call is listed with its reason in the job summary of that run. `mendr audit` and `mendr fix-llm` give the evidence.');

    const gated = await sh('held_pr_comment 1 "openai/gpt-4" "https://github.com/acme/app/actions/runs/9"');
    expect(gated.split('\n')[0]).toBe('<!-- mendr-bot:held-for-review held=1 only=openai/gpt-4 -->');
    expect(gated).toContain('looked only at the approved models (openai/gpt-4)');
    expect(gated).toContain('in the job summary of that run: https://github.com/acme/app/actions/runs/9.');
  });

  it('finds the marker line among comment bodies, and only as a whole line', async () => {
    const key = '<!-- mendr-bot:held-for-review held=2 only= -->';
    const yes = (comments: string) => sh(`already_commented '${key}' "$(printf '${comments}')" && echo yes || echo no`);
    expect(await yes(`first\\n${key}\\r\\nbody`)).toBe('yes');
    expect(await yes(`${key}`)).toBe('yes');
    expect(await yes('')).toBe('no');
    // A different count, or the key quoted inside a longer line, is not the same warning.
    expect(await yes('<!-- mendr-bot:held-for-review held=3 only= -->')).toBe('no');
    expect(await yes(`> ${key}`)).toBe('no');
  });
});

describe.skipIf(!BASH)('pr-body.sh: the report under a pull request body fits GitHub\'s limit', () => {
  const LIMIT = 65_536;
  function reportOf(lines: number): string {
    return Array.from({ length: lines }, (_, i) => `  app/f${i}.py:9  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]\n    the max_tokens rule changes what this call asks for on the replacement`).join('\n') + '\n';
  }
  async function embed(report: string, used: number, url = ''): Promise<string> {
    const dir = tempDir('mendr-pr-body-');
    const file = join(dir, 'report.txt').replace(/\\/g, '/');
    writeFileSync(file, report);
    return sh(`embed_report "${file}" ${used} "${url}"`);
  }

  it('embeds a report that fits whole, and says nothing about a cut', async () => {
    const out = await embed('HELD FOR REVIEW\n  src/a.ts:1  gpt-4\n', 2_000);
    expect(out).toBe('<details><summary>Full Mendr report</summary>\n\n```\nHELD FOR REVIEW\n  src/a.ts:1  gpt-4\n```\n</details>');
  });

  it('cuts a long report at a whole line so the body stays under the limit, and says where the whole one is', async () => {
    const report = reportOf(800); // ~140 KB, well past the limit
    const used = 25_429; // the evidence block the reviewer measured at 50 held calls, plus the scaffold
    const out = await embed(report, used, 'https://github.com/acme/app/actions/runs/42');
    expect(Buffer.byteLength(out, 'utf8') + used).toBeLessThanOrEqual(LIMIT);
    expect(out.startsWith('<details><summary>Full Mendr report</summary>\n\n```\n  app/f0.py:9  gpt-3.5-turbo')).toBe(true);
    expect(out.endsWith('</details>')).toBe(true);
    expect(out).toContain('Mendr cut this report here, because GitHub does not accept a pull request description longer than 65,536 characters.');
    expect(out).toContain('is in the job summary of the run that last updated this pull request: https://github.com/acme/app/actions/runs/42');
    // Every embedded line is a whole line of the report: the cut never lands inside one.
    const fenced = out.split('```\n')[1].split('\n```')[0].split('\n');
    const whole = new Set(report.split('\n'));
    for (const line of fenced) expect(whole.has(line), line).toBe(true);
  });

  it('embeds no report text, only the sentence, when the body is already full', async () => {
    const out = await embed(reportOf(10), LIMIT);
    expect(out).toContain('Mendr cut this report here');
    expect(out).not.toContain('app/f0.py');
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
  // The --json run also writes the evidence block where `--pr-body` asks, when the test gives one.
  bin(
    'npx',
    [
      'echo "$*" >> "$NPX_LOG"',
      'case "$3" in',
      '  migrate)',
      '    prev=""',
      '    for a in "$@"; do',
      '      if [ "$prev" = "--pr-body" ] && [ -n "${PRBODY_FIXTURE:-}" ]; then cat "$PRBODY_FIXTURE" > "$a"; fi',
      '      prev="$a"',
      '    done',
      '    case " $* " in *" --json "*) cat "$ARTIFACT_FIXTURE" ;; *) cat "$REPORT_FIXTURE" ;; esac ;;',
      '  redact) cat "$4" ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'),
  );
  bin('npm', '[ "$1" = "--version" ] && echo 11.0.0; exit 0');
  // gh: every call logged; `pr list` answers with the open Mendr pull request, if any, and
  // `pr view` with the bodies of its comments. `pr create` and `pr edit` keep the body they were
  // given and refuse one over 65,536 bytes, as GitHub refuses one over 65,536 characters.
  bin(
    'gh',
    [
      'echo "$*" >> "$GH_LOG"',
      'case "$1 $2" in',
      '  "pr list") echo "${GH_OPEN_PR:-}" ;;',
      '  "pr view") printf "%s\\n" "${GH_COMMENTS:-}" ;;',
      '  "pr create" | "pr edit")',
      '    prev=""',
      '    for a in "$@"; do',
      '      if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_BODY"; fi',
      '      prev="$a"',
      '    done',
      '    if [ "$(($(wc -c < "$GH_BODY")))" -gt 65536 ]; then echo "GraphQL: Body is too long (maximum is 65536 characters) (createPullRequest)" >&2; exit 1; fi',
      '    if [ "$1 $2" = "pr create" ]; then echo "https://github.com/acme/app/pull/8"; fi ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  // git: by default nothing changed in the working tree (the nothing-applied path); GIT_DIFF_EXIT=1
  // says a verified migration was applied. Anything else is logged.
  bin('git', 'if [ "$1" = "diff" ]; then exit "${GIT_DIFF_EXIT:-0}"; fi\necho "git $*" >> "$GH_LOG"\nexit 0');
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
  /** The pull request body `gh pr create` or `gh pr edit` was given, if any. */
  body: string;
}

/**
 * Run run-mendr.sh in a temp checkout with the given artifact and human report. `prBody` is the
 * evidence block `migrate --pr-body` writes (the pull-request path only).
 */
async function runAction(artifact: unknown, report: string, env: Record<string, string> = {}, prBody?: string): Promise<Run> {
  const work = tempDir('mendr-action-run-');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  stubs(bin, !REAL_JQ);
  const files = {
    artifact: join(work, 'artifact.json'),
    report: join(work, 'report.txt'),
    prBody: join(work, 'pr-body.md'),
    outputs: join(work, 'github-output'),
    summary: join(work, 'step-summary'),
    gh: join(work, 'gh.log'),
    npx: join(work, 'npx.log'),
    body: join(work, 'gh-body.md'),
  };
  writeFileSync(files.artifact, typeof artifact === 'string' ? artifact : JSON.stringify(artifact));
  writeFileSync(files.report, report);
  if (prBody !== undefined) writeFileSync(files.prBody, prBody);
  for (const f of [files.outputs, files.summary, files.gh, files.npx, files.body]) writeFileSync(f, '');
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
      GH_BODY: posix(files.body),
      NPX_LOG: posix(files.npx),
      GH_OPEN_PR: '7',
      ...(prBody !== undefined ? { PRBODY_FIXTURE: posix(files.prBody) } : {}),
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
    body: read(files.body),
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
    // The closing comment says what was checked, and that configuration files were not.
    expect(r.gh).toMatch(
      /^pr close 7 --comment Mendr: nothing in the source code Mendr migrates \(TypeScript, JavaScript and Python\) is left to migrate or held for review, so this pull request is no longer needed; closing\. This check does not read configuration files: `mendr audit` lists a retiring model id set in one\. --delete-branch$/m,
    );
    expect(r.gh).not.toMatch(/No call or model setting/);
    expect(r.log).toContain('Mendr: nothing to migrate and nothing held for review in the source code. No PR opened. Configuration files are not part of this check');
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
    expect(r.log).toContain('Any open Mendr PR is left open.');
    expect(r.log).toContain('::warning::Mendr: 2 places in the code still use a retiring model id');
    // The job summary carries the sentence and the sanitized report with the list.
    expect(r.summary).toContain('**Mendr: 2 places in the code still use a retiring model id and need a person.');
    expect(r.summary).toContain('Held for review (2)');
    expect(r.npx).toMatch(/ redact /);
  });

  // The open pull request came from an earlier run, and its body still says Mendr verified its
  // swap. A newer release can hold the same call (v0.5.9-alpha swapped a const Opus 4.1 call
  // passing max_tokens; v0.5.10-alpha holds it), so the run says so on the pull request.
  it('says on the open Mendr pull request that Mendr no longer verifies it, and leaves it open', async () => {
    const r = await runAction(artifact('held_for_review', HELD), 'HELD FOR REVIEW\n', {
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_RUN_ID: '42',
    });
    expect(r.exitCode, r.log).toBe(0);
    expect(closed(r.gh)).toBe(false);
    expect(r.gh).toMatch(/^pr comment 7 --body <!-- mendr-bot:held-for-review held=2 only= -->$/m);
    expect(r.gh).toContain('**Mendr no longer verifies this pull request.**');
    expect(r.gh).toContain('Mendr: 2 places in the code still use a retiring model id and need a person.');
    expect(r.gh).toContain("Mendr's latest run made no verified change in this repository, so no change on this branch is verified by Mendr any more.");
    expect(r.gh).toContain('Each held call is listed with its reason in the job summary of that run: https://github.com/acme/app/actions/runs/42.');
    expect(r.log).toContain('Mendr: said on the open Mendr PR #7 that this run held its calls for review and Mendr no longer verifies it.');
  });

  it('does not say it again on a pull request that already carries the same warning', async () => {
    const said = '<!-- mendr-bot:held-for-review held=2 only= -->\r\n**Mendr no longer verifies this pull request.**';
    const r = await runAction(artifact('held_for_review', HELD), 'HELD FOR REVIEW\n', { GH_COMMENTS: `Looks good to me.\n${said}` });
    expect(r.exitCode, r.log).toBe(0);
    expect(r.gh).not.toMatch(/^pr comment /m);
    expect(r.log).toContain('the open Mendr PR #7 already says Mendr no longer verifies it; not said again.');

    // A different count is new information, so it is said.
    const again = await runAction(artifact('held_for_review', HELD.slice(0, 1)), 'HELD FOR REVIEW\n', { GH_COMMENTS: said });
    expect(again.gh).toMatch(/^pr comment 7 --body <!-- mendr-bot:held-for-review held=1 only= -->$/m);
  });

  it('on an approval-gated run, speaks only for the approved models', async () => {
    const r = await runAction(artifact('held_for_review', HELD.slice(0, 1)), 'HELD FOR REVIEW\n', { MENDR_ONLY: 'anthropic/claude-opus-4-1-20250805' });
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(closed(r.gh)).toBe(false);
    expect(r.gh).toMatch(/^pr comment 7 --body <!-- mendr-bot:held-for-review held=1 only=anthropic\/claude-opus-4-1-20250805 -->$/m);
    expect(r.gh).toContain("Mendr's latest run looked only at the approved models (anthropic/claude-opus-4-1-20250805) and migrated none of them.");
    expect(r.gh).not.toContain('no change on this branch is verified');
  });

  it('comments on nothing when no Mendr pull request is open', async () => {
    const r = await runAction(artifact('held_for_review', HELD), 'HELD FOR REVIEW\n', { GH_OPEN_PR: '' });
    expect(r.outputs).toContain('outcome=held-for-review');
    expect(r.gh).not.toMatch(/^pr comment /m);
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

  it('decides from what the real CLI emits for a held-only repository, and says so on the open pull request', async () => {
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
    expect(r.gh).toMatch(/^pr comment 7 --body <!-- mendr-bot:held-for-review held=1 only= -->$/m);
  });
});

// --- run-mendr.sh, a verified migration with many held calls ------------------------------------
//
// The human report lists every held call and is embedded under the pull request body. With 80 held
// calls beside one verified swap the body passed GitHub's 65,536-character limit, so `gh pr create`
// failed (and the run reported `pr-blocked`, blaming a repository setting) or `gh pr edit` failed
// after the branch was already force-pushed. The stubbed `gh` refuses a body over the limit as
// GitHub does.

describe.skipIf(!BASH)('run-mendr.sh when a verified migration holds many calls too', { timeout: 120_000 }, () => {
  const heldRow = (i: number) => ({
    file: `app/f${i}.py`,
    line: 9,
    column: 49,
    model: 'gpt-3.5-turbo',
    replacement: 'gpt-5.6-terra',
    code: 'param_behaviour_change',
    reason: 'the call passes max_tokens, which the max_completion_tokens rule renames on the replacement, and Python has no parameter pass',
    language: 'py',
  });
  const held = Array.from({ length: 250 }, (_, i) => heldRow(i + 1));
  const verified = {
    ...artifact('verified', held, true),
    migrations: [{ provider: 'openai', model: 'gpt-4-0613', from: 'gpt-4-0613', to: 'gpt-5.6-sol', language: 'ts', sites: 1, files: ['src/go.ts'] }],
    changedFiles: ['src/go.ts'],
    prReady: true,
  };
  // The human report: every held call, two lines each, as report.ts renders them.
  const report = [
    'mendr migrate (preview)',
    '',
    'Migration: 1 model across 1 file',
    '  gpt-4-0613 -> gpt-5.6-sol  (openai, ts, 1 site: src/go.ts)',
    '',
    `Held for review (${held.length}) — retiring model ids Mendr found and did not change, because a person has to decide:`,
    ...held.flatMap((h) => [`  ${h.file}:${h.line}  ${h.model} (replacement on record: ${h.replacement})  [${h.code}]`, `    ${h.reason}`]),
    'Run `mendr fix-llm` or `mendr audit` on this repository for the evidence behind each one.',
    '',
  ].join('\n');
  // The evidence block, at the size measured with 50 held calls listed (PR_BODY_MAX_SKIPPED).
  const evidence = ['**Swaps**', '- `gpt-4-0613` → `gpt-5.6-sol`', '', '**Left alone (250)**', ...held.slice(0, 50).map((h) => `- \`${h.file}:${h.line}\` \`${h.model}\` (\`${h.code}\`) — ${h.reason}`)].join('\n').padEnd(25_000, ' ') + '\n';
  const env = { GIT_DIFF_EXIT: '1', MENDR_BASE: 'main', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42' };

  it('opens its pull request: the report under the body is cut to fit, and the job summary keeps all of it', async () => {
    expect(report.length + evidence.length).toBeGreaterThan(65_536);
    const r = await runAction(verified, report, { ...env, GH_OPEN_PR: '' }, evidence);
    expect(r.exitCode, r.log).toBe(0);
    expect(r.outputs).toContain('outcome=migration-proposed');
    expect(r.outputs).toContain('pr_url=https://github.com/acme/app/pull/8');
    expect(r.outputs).not.toContain('pr-blocked');
    expect(r.gh).toMatch(/^pr create /m);
    expect(Buffer.byteLength(r.body, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(r.body).toContain('<!-- mendr-bot:llm-migration -->');
    expect(r.body).toContain('**Left alone (250)**');
    expect(r.body).toContain('Mendr cut this report here, because GitHub does not accept a pull request description longer than 65,536 characters.');
    expect(r.body).toContain('https://github.com/acme/app/actions/runs/42');
    expect(r.body.trimEnd().endsWith('</details>')).toBe(true);
    expect(r.body).not.toContain('app/f250.py:9');
    expect(r.summary).toContain('  app/f250.py:9  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]');
  });

  it('updates an open Mendr pull request the same way', async () => {
    const r = await runAction(verified, report, { ...env, GH_OPEN_PR: 'https://github.com/acme/app/pull/7' }, evidence);
    expect(r.exitCode, r.log).toBe(0);
    expect(r.outputs).toContain('outcome=migration-proposed');
    expect(r.outputs).toContain('pr_url=https://github.com/acme/app/pull/7');
    expect(r.gh).toMatch(/^pr edit https:\/\/github\.com\/acme\/app\/pull\/7 --body-file /m);
    expect(Buffer.byteLength(r.body, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(r.body).toContain('Mendr cut this report here');
  });

  it('embeds a report that fits whole, as before', async () => {
    const small = { ...verified, skipped: held.slice(0, 2) };
    const shortReport = report.split('\n').slice(0, 10).join('\n') + '\n';
    const r = await runAction(small, shortReport, { ...env, GH_OPEN_PR: '' }, '**Swaps**\n- `gpt-4-0613` → `gpt-5.6-sol`\n');
    expect(r.exitCode, r.log).toBe(0);
    expect(r.body).toContain(`<details><summary>Full Mendr report</summary>\n\n\`\`\`\n${shortReport}\`\`\`\n</details>`);
    expect(r.body).not.toContain('Mendr cut this report here');
  });
});
