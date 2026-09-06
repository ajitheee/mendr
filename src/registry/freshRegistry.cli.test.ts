import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistryPath } from '../usage/llmRegistry.js';
import { buildManifest, canonicalJson, signManifest } from './manifest.js';

// THE FRESHNESS CONTRACT, END TO END through the real CLI. The unit tests cover
// loadRegistryWithFreshness; this proves what a customer's CI actually sees:
//   * a registry of unknown age turns a zero-finding scan INCONCLUSIVE (exit 3),
//     wears ✗ in the coverage rows, and is explained under "limits of this run";
//   * a registry proven fresh by a signature the run trusts lets "no exposure"
//     stand (exit 0);
//   * exposure still wins over a stale registry — stale knowledge can prove a
//     problem, never the absence of one;
//   * a requested refresh that cannot happen degrades to the bundled registry,
//     says why on stderr, and never crashes the audit.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRELOAD = join(MENDR_ROOT, 'scripts', 'no-network.cjs').split(sep).join('/');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function cleanRepo(): string {
  const dir = tmp('mendr-fresh-clean-');
  writeFileSync(join(dir, 'index.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
  return dir;
}

function exposedRepo(): string {
  const dir = tmp('mendr-fresh-exposed-');
  writeFileSync(
    join(dir, 'client.ts'),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n',
  );
  return dir;
}

/** The bundled registry copied to a directory, optionally with a manifest signed by a fresh throwaway key. */
function registryDir(sign: { publishedAt: string } | null): { file: string; keysFile: string } {
  const dir = tmp('mendr-fresh-reg-');
  const bytes = readFileSync(resolveRegistryPath());
  const file = join(dir, 'llm-deprecations.json');
  writeFileSync(file, bytes);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keysFile = join(dir, 'trusted-keys.pem');
  writeFileSync(keysFile, publicKey.export({ type: 'spki', format: 'pem' }) as string);
  if (sign) {
    const manifestBytes = Buffer.from(
      canonicalJson(buildManifest(bytes, { publishedAt: sign.publishedAt, sourceCommit: 'c'.repeat(40), entryCount: JSON.parse(bytes.toString('utf8')).length })),
    );
    writeFileSync(join(dir, 'manifest.json'), manifestBytes);
    writeFileSync(join(dir, 'manifest.sig'), signManifest(manifestBytes, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string));
  }
  return { file, keysFile };
}

async function audit(args: string[], env: Record<string, string> = {}) {
  const r = await execa('tsx', ['src/cli.ts', 'audit', ...args], { cwd: MENDR_ROOT, reject: false, env: { ...process.env, MENDR_UNICODE: '1', ...env } });
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
}

describe('registry freshness through the real CLI', () => {
  it('an operator registry of unknown age (unsigned MENDR_REGISTRY_FILE) makes a zero-finding scan INCONCLUSIVE: exit 3, ✗ row, explained', async () => {
    const { file } = registryDir(null);
    const repo = cleanRepo();
    const j = await audit([repo, '--json'], { MENDR_REGISTRY_FILE: file });
    expect(j.exitCode).toBe(3);
    const report = JSON.parse(j.stdout);
    expect(report.conclusion).toBe('inconclusive');
    expect(report.coverage.registry).toMatchObject({ source: 'file', publishedAt: null, ageDays: -1, freshness: 'stale' });
    expect(report.coverage.registry.reason).toMatch(/unknown age/);

    const h = await audit([repo], { MENDR_REGISTRY_FILE: file });
    expect(h.exitCode).toBe(3);
    expect(h.stdout).toMatch(/✗ Registry:.*file undated \(STALE age unknown, max 14\) → inconclusive/);
    expect(h.stdout).toContain('Conclusion: INCONCLUSIVE');
    expect(h.stdout).toMatch(/unknown age/); // the limits-of-this-run line carries the reason
  }, 180_000);

  it('a registry proven fresh by a signature the run trusts lets "no exposure" stand: exit 0', async () => {
    const { file, keysFile } = registryDir({ publishedAt: new Date().toISOString() });
    const j = await audit([cleanRepo(), '--json'], { MENDR_REGISTRY_FILE: file, MENDR_REGISTRY_TRUSTED_KEYS_FILE: keysFile });
    expect(j.exitCode).toBe(0);
    const report = JSON.parse(j.stdout);
    expect(report.conclusion).toBe('no_exposure_in_completed_surfaces');
    expect(report.coverage.registry).toMatchObject({ source: 'file', freshness: 'fresh', maxAgeDays: 14 });
    expect(report.coverage.registry.version).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(report.coverage.registry.reason).toBeUndefined();
  }, 180_000);

  it('exposure still wins over a stale registry (stale knowledge can prove a problem, never its absence)', async () => {
    const { file } = registryDir(null);
    const j = await audit([exposedRepo(), '--json'], { MENDR_REGISTRY_FILE: file });
    expect(j.exitCode).toBe(0); // exposure exits 0 by default (monitoring); the registry grade does not change that
    const report = JSON.parse(j.stdout);
    expect(report.conclusion).toBe('exposure_detected');
    expect(report.coverage.registry.freshness).toBe('stale');
  }, 180_000);

  it('a requested refresh that cannot happen (no network) degrades to the bundled registry, says why, and completes', async () => {
    const { keysFile } = registryDir(null); // a trusted key, so the fetch is really attempted — and blocked
    const j = await audit([cleanRepo(), '--json', '--refresh-registry'], {
      MENDR_REGISTRY_TRUSTED_KEYS_FILE: keysFile,
      MENDR_REGISTRY_MAX_AGE_DAYS: '100000', // the bundled copy counts as fresh here, whatever the calendar says
      NODE_OPTIONS: `--require "${PRELOAD}"`,
    });
    expect(j.exitCode).toBe(0);
    const report = JSON.parse(j.stdout);
    expect(report.conclusion).toBe('no_exposure_in_completed_surfaces');
    expect(report.coverage.registry).toMatchObject({ source: 'bundled', freshness: 'fresh' });
    expect(report.coverage.registry.refresh.requested).toBe(true);
    expect(report.coverage.registry.refresh.ok).toBe(false);
    expect(report.coverage.registry.refresh.error).toMatch(/manifest\.json: .*no-network preload/);
    expect(j.stderr).toContain('registry refresh not applied');
    expect(j.stderr).not.toMatch(/at .*\.ts:\d+/); // a disclosed failure, not a stack trace
  }, 180_000);

  it('--offline wins over a requested refresh: no network call, the reason names offline', async () => {
    const { keysFile } = registryDir(null);
    const j = await audit([cleanRepo(), '--json', '--refresh-registry', '--offline'], { MENDR_REGISTRY_TRUSTED_KEYS_FILE: keysFile, MENDR_REGISTRY_MAX_AGE_DAYS: '100000' });
    expect(j.exitCode).toBe(0);
    expect(JSON.parse(j.stdout).coverage.registry.refresh.error).toMatch(/offline/);
  }, 180_000);
});
