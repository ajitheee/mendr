import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistryPath } from './llmRegistry.js';

// The Provider SDKs row through the real `mendr audit`. What is proven here is what the
// design promises and a reader of the code could miss: the row is HUMAN REPORT ONLY. It
// cannot move the conclusion or the exit code (not even with --fail-on-exposure), and none
// of it reaches --json — the report the Action posts to the App.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EXPOSED_SOURCE =
  'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n';
const LOCK = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: { '': { name: 'app', dependencies: { openai: '^4.20.0' } }, 'node_modules/openai': { version: '4.24.7' } },
});

const CLEAN_SOURCE = 'export const add = (a: number, b: number): number => a + b;\n';

function fixture(withLock: string | null, source = EXPOSED_SOURCE): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-locked-cli-'));
  created.push(dir);
  writeFileSync(join(dir, 'client.ts'), source);
  if (withLock !== null) writeFileSync(join(dir, 'package-lock.json'), withLock);
  return dir;
}

async function audit(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = await execa('tsx', ['src/cli.ts', 'audit', dir, '--offline', ...args], {
    cwd: MENDR_ROOT,
    reject: false,
    env: { ...process.env, ...env },
  });
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
}
const conclusion = (out: string): string | undefined => out.split('\n').find((l) => l.startsWith('Conclusion:'));

describe('the Provider SDKs row through the real CLI', () => {
  it('shows the locked SDK and its resolution in the human report', async () => {
    const r = await audit(fixture(LOCK));
    expect(r.stdout).toMatch(/Provider SDKs:\s+1 declared by the root project in package-lock\.json/);
    expect(r.stdout).toContain('openai 4.24.7');
    expect(r.stdout).toContain('newer major lines seen');
  }, 180_000);

  it('never changes the conclusion or the exit code, even with --fail-on-exposure', async () => {
    for (const args of [[], ['--fail-on-exposure']]) {
      const without = await audit(fixture(null), args);
      const withLock = await audit(fixture(LOCK), args);
      expect(conclusion(withLock.stdout)).toBe(conclusion(without.stdout));
      expect(withLock.exitCode).toBe(without.exitCode);
    }
  }, 180_000);

  it('puts nothing about SDKs into --json', async () => {
    const r = await audit(fixture(LOCK), ['--json']);
    const json = JSON.parse(r.stdout);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/Provider SDKs|lockedSdks|newer major|4\.24\.7/);
  }, 180_000);

  // An operator registry file overrides the DEPRECATION registry only. The SDK release record
  // always comes from the copy bundled with this build — nothing verifies a record's
  // signature on read yet, so a record found beside an override must not be trusted.
  it('reads the SDK release record from the bundled copy, even beside a registry override', async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'mendr-locked-reg-'));
    created.push(regDir);
    copyFileSync(resolveRegistryPath(), join(regDir, 'llm-deprecations.json'));
    writeFileSync(
      join(regDir, 'sdk-releases.json'),
      JSON.stringify({ schema: 'mendr-sdk-releases/v1', fetchedAt: '2026-09-18T00:00:00Z', sources: [], packages: [], count: 0 }),
    );
    const r = await audit(fixture(LOCK), [], { MENDR_REGISTRY_FILE: join(regDir, 'llm-deprecations.json') });
    expect(r.stdout).toContain('newer major lines seen');
    expect(r.stdout).not.toContain('is not one of the 0 SDK packages');
  }, 180_000);

  // Today's behaviour, pinned: the configuration scan already reads package-lock.json and
  // fails closed on malformed JSON, so a repo with no exposure is INCONCLUSIVE (exposure,
  // when present, still wins). The SDK row adds its own ✗ and changes nothing else.
  it('leaves a malformed lockfile to the configuration scan, which still fails closed', async () => {
    const r = await audit(fixture('{ not json', CLEAN_SOURCE));
    expect(conclusion(r.stdout)).toMatch(/INCONCLUSIVE/);
    expect(r.stdout).toMatch(/Provider SDKs:\s+package-lock\.json could not be read \(not valid JSON\)/);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------
// PLANE 2, SLICE 2 — the job-summary section the reusable audit workflow turns on with
// MENDR_JOB_SUMMARY. It is appended AFTER the JSON is complete, so the JSON the App
// receives, and the exit code, must be byte-for-byte what they were without it.

// generatedAt and the registry's age (rounded to 0.1 day) move between two back-to-back runs.
const WITHOUT_TIME = (json: string): string =>
  json.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "-"').replace(/"ageDays": [-0-9.]+/g, '"ageDays": -');

function summaryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-summary-'));
  created.push(dir);
  return join(dir, 'step-summary.md');
}

describe('the Provider SDKs section in the Actions job summary', () => {
  it('is appended to GITHUB_STEP_SUMMARY and changes nothing in the JSON or the exit code', async () => {
    for (const args of [['--json'], ['--json', '--fail-on-exposure']]) {
      // One repo for both runs: the JSON names the repo directory.
      const repoDir = fixture(LOCK);
      const file = summaryFile();
      const plain = await audit(repoDir, args);
      const withSummary = await audit(repoDir, args, { MENDR_JOB_SUMMARY: 'on', GITHUB_STEP_SUMMARY: file });
      expect(WITHOUT_TIME(withSummary.stdout)).toBe(WITHOUT_TIME(plain.stdout));
      expect(withSummary.exitCode).toBe(plain.exitCode);
      const md = readFileSync(file, 'utf8');
      expect(md).toContain('### Mendr — provider SDKs (information only)');
      expect(md).toContain('openai 4.24.7');
      expect(md).not.toMatch(/[✓○✗]/);
    }
  }, 180_000);

  it('writes nothing unless the workflow turns it on', async () => {
    const file = summaryFile();
    await audit(fixture(LOCK), ['--json'], { GITHUB_STEP_SUMMARY: file });
    expect(existsSync(file)).toBe(false);
  }, 180_000);

  // Only the --json path the Action runs writes it; the human report already has the row.
  it('is not written by the human report', async () => {
    const file = summaryFile();
    await audit(fixture(LOCK), [], { MENDR_JOB_SUMMARY: 'on', GITHUB_STEP_SUMMARY: file });
    expect(existsSync(file)).toBe(false);
  }, 180_000);

  // A failure costs the section, never the audit: same JSON, same exit code, one stderr line.
  it('survives an unwritable summary file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-summary-dir-'));
    created.push(dir);
    const repoDir = fixture(LOCK);
    const plain = await audit(repoDir, ['--json']);
    const broken = await audit(repoDir, ['--json'], { MENDR_JOB_SUMMARY: 'on', GITHUB_STEP_SUMMARY: dir });
    expect(WITHOUT_TIME(broken.stdout)).toBe(WITHOUT_TIME(plain.stdout));
    expect(broken.exitCode).toBe(plain.exitCode);
    expect(broken.stderr).toContain('job summary not written');
  }, 180_000);
});

// The reusable workflow turns the section on in the audit step's env, and leaves that
// step's run block — which holds the only upload to Mendr — exactly as it was.
describe('the reusable audit workflow', () => {
  const yml = readFileSync(join(MENDR_ROOT, '.github', 'workflows', 'reusable-audit.yml'), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Audit and send findings to Mendr'));
  const envBlock = step.slice(0, step.indexOf('run: |'));
  const runBlock = step.slice(step.indexOf('run: |'));

  it("sets MENDR_JOB_SUMMARY: 'on' in the audit step's env", () => {
    // A real entry at the env block's indentation: a commented-out or mis-indented key
    // would turn the section off, or break the workflow, and must fail here.
    expect(envBlock).toMatch(/^ {10}MENDR_JOB_SUMMARY: 'on'\r?$/m);
  });

  it('does not touch the run block that sends the audit to Mendr', () => {
    expect(runBlock).not.toMatch(/GITHUB_STEP_SUMMARY|MENDR_JOB_SUMMARY/);
  });
});

// ---------------------------------------------------------------------------------------
// PLANE 2, SLICE 3 — the Python SDKs row (root requirements*.txt). Human report only: it
// cannot move the conclusion or the exit code, and none of it reaches --json or the job summary.

const PY_EXPOSED = 'from openai import OpenAI\nclient = OpenAI()\nclient.chat.completions.create(model="gpt-4", messages=[])\n';

function pyFixture(requirements: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-pyreq-cli-'));
  created.push(dir);
  writeFileSync(join(dir, 'app.py'), PY_EXPOSED);
  if (requirements !== null) writeFileSync(join(dir, 'requirements.txt'), requirements);
  return dir;
}

describe('the Python SDKs row through the real CLI', () => {
  it('shows a pinned SDK in the human report', async () => {
    const r = await audit(pyFixture('openai==1.40.6\n'));
    expect(r.stdout).toMatch(/Python SDKs:\s+1 listed in the root requirements\*\.txt/);
    expect(r.stdout).toContain('openai 1.40.6 (requirements.txt)');
  }, 180_000);

  it('never changes the conclusion or the exit code', async () => {
    for (const args of [[], ['--fail-on-exposure']]) {
      const without = await audit(pyFixture(null), args);
      const withPins = await audit(pyFixture('openai==1.40.6\n'), args);
      expect(conclusion(withPins.stdout)).toBe(conclusion(without.stdout));
      expect(withPins.exitCode).toBe(without.exitCode);
    }
  }, 180_000);

  it('puts nothing about Python SDKs into --json or the job summary', async () => {
    const file = summaryFile();
    const r = await audit(pyFixture('openai==1.40.6\n'), ['--json'], { MENDR_JOB_SUMMARY: 'on', GITHUB_STEP_SUMMARY: file });
    expect(JSON.stringify(JSON.parse(r.stdout))).not.toMatch(/Python SDKs|1\.40\.6/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/Python SDKs|1\.40\.6/);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------
// PLANE 2, SLICE 4 — the root uv.lock, in the same human-only Python row.

const UV_LOCK = [
  'version = 1',
  'revision = 3',
  'requires-python = ">=3.11"',
  '',
  '[[package]]',
  'name = "app"',
  'version = "0.1.0"',
  'source = { editable = "." }',
  'dependencies = [',
  '    { name = "openai" },',
  ']',
  '',
  '[[package]]',
  'name = "openai"',
  'version = "2.29.0"',
  'source = { registry = "https://pypi.org/simple" }',
  '',
].join('\n');

function uvFixture(withLock: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-uv-cli-'));
  created.push(dir);
  writeFileSync(join(dir, 'app.py'), PY_EXPOSED);
  if (withLock) writeFileSync(join(dir, 'uv.lock'), UV_LOCK);
  return dir;
}

describe('the uv.lock part of the Python SDKs row', () => {
  it('shows the locked SDK in the human report', async () => {
    const r = await audit(uvFixture(true));
    expect(r.stdout).toMatch(/Python SDKs:\s+1 listed in uv\.lock/);
    expect(r.stdout).toContain('openai 2.29.0 (uv.lock)');
  }, 180_000);

  it('never changes the conclusion or the exit code', async () => {
    for (const args of [[], ['--fail-on-exposure']]) {
      const without = await audit(uvFixture(false), args);
      const withLock = await audit(uvFixture(true), args);
      expect(conclusion(withLock.stdout)).toBe(conclusion(without.stdout));
      expect(withLock.exitCode).toBe(without.exitCode);
    }
  }, 180_000);

  it('puts nothing about uv.lock into --json or the job summary', async () => {
    const file = summaryFile();
    const r = await audit(uvFixture(true), ['--json'], { MENDR_JOB_SUMMARY: 'on', GITHUB_STEP_SUMMARY: file });
    expect(JSON.stringify(JSON.parse(r.stdout))).not.toMatch(/uv\.lock|2\.29\.0/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/Python SDKs|2\.29\.0/);
  }, 180_000);
});
