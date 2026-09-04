import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// "Nothing is uploaded" is a claim about a PROCESS, so it is tested on one.
// A preload that makes every outbound network primitive throw is installed
// before mendr runs; the default audit must still complete and print a valid
// report. The control case proves the preload actually bites: the optional
// provider usage read, given a (fake) key, must fail with the preload's message.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// NODE_OPTIONS strips backslashes inside quoted arguments, so the path is
// given with forward slashes (Node accepts them on Windows too).
const PRELOAD = join(MENDR_ROOT, 'scripts', 'no-network.cjs').split(sep).join('/');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-nonet-'));
  created.push(dir);
  writeFileSync(
    join(dir, 'client.ts'),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n',
  );
  writeFileSync(join(dir, 'app.yaml'), 'model: gpt-3.5-turbo\n');
  return dir;
}

async function run(args: string[], env: Record<string, string> = {}) {
  return execa('tsx', ['src/cli.ts', ...args], {
    cwd: MENDR_ROOT,
    reject: false,
    env: { ...process.env, MENDR_UNICODE: '1', NODE_OPTIONS: `--require "${PRELOAD}"`, ...env },
  });
}

describe('the default audit needs no network — proven, not promised', () => {
  it('completes under a preload that blocks every outbound network primitive', async () => {
    const dir = repo();
    const r = await run([ 'audit', dir, '--json' ]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.conclusion).toBe('exposure_detected');
    expect(report.investigations.length).toBeGreaterThan(0);
    expect(r.stderr).not.toContain('OfflineViolation');
  }, 120_000);

  it('the human report, --install scaffolding and the GitHub issue body also complete offline', async () => {
    const dir = repo();
    const body = join(dir, 'issue.md');
    const r = await run(['audit', dir, '--issue-body', body, '--sha', 'deadbeef']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Conclusion: EXPOSURE DETECTED');
    const inst = await run(['audit', dir, '--install']);
    expect(inst.exitCode).toBe(0);
  }, 120_000);

  it('CONTROL: the optional provider usage read is blocked by the same preload', async () => {
    const dir = repo();
    const r = await run(['audit', dir, 'openai'], { MENDR_PROVIDER_KEY: 'sk-test-not-a-real-key-000000' });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain('no-network preload');
  }, 120_000);
});

describe('--offline / MENDR_OFFLINE=1 — the same guarantee from inside the process', () => {
  it('the default audit runs with --offline', async () => {
    const dir = repo();
    const r = await execa('tsx', ['src/cli.ts', 'audit', dir, '--json', '--offline'], { cwd: MENDR_ROOT, reject: false, env: { ...process.env, MENDR_UNICODE: '1' } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).conclusion).toBe('exposure_detected');
  }, 120_000);

  it('the provider read refuses under MENDR_OFFLINE=1 and names the blocked operation', async () => {
    const dir = repo();
    const r = await execa('tsx', ['src/cli.ts', 'audit', dir, 'openai'], {
      cwd: MENDR_ROOT, reject: false,
      env: { ...process.env, MENDR_UNICODE: '1', MENDR_OFFLINE: '1', MENDR_PROVIDER_KEY: 'sk-test-not-a-real-key-000000' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain('mendr --offline');
  }, 120_000);
});
