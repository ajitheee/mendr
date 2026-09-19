import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout };
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
