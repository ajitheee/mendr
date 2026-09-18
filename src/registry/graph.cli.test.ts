import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistryPath } from '../usage/llmRegistry.js';

// `mendr resolve` through the real CLI, against the SHIPPED records. Only facts a refresh
// cannot change are asserted: PyPI openai major 1 was first seen on 2023-09-29 whatever
// ships later, and a stale record still reports newer majors (as a floor).
//
// The routing is the part worth spawning for: SDK specs are recognised BEFORE anything
// canonicalizes the argument ('npm:openai@^0.28' would become 'npm'), and they never load
// the model registry.

const MENDR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function mendrResolve(args: string[]) {
  const r = await execa('tsx', ['src/cli.ts', 'resolve', ...args], { cwd: MENDR_ROOT, reject: false });
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
}

describe('mendr resolve through the real CLI', () => {
  it('walks a PyPI SDK major forward through the shipped release record', async () => {
    const r = await mendrResolve(['pypi:openai@0.28.1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('pypi:openai@0 -> pypi:openai@1');
    expect(r.stdout).toContain('sdk_newer_majors');
    expect(r.stdout).toContain('1 (2023-09-29)');
    expect(r.stdout).toContain('pre-releases included');
  }, 180_000);

  it('refuses a spec that could span majors, with a usage error rather than an answer', async () => {
    const r = await mendrResolve(['npm:openai@latest']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('cannot read one major version');
    expect(r.stdout).toBe('');
  }, 180_000);

  it('answers an SDK question even when the model registry beside it is broken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-resolve-sdk-'));
    created.push(dir);
    writeFileSync(join(dir, 'llm-deprecations.json'), '{ not json');
    copyFileSync(join(dirname(resolveRegistryPath()), 'sdk-releases.json'), join(dir, 'sdk-releases.json'));
    const r = await mendrResolve(['npm:openai@^4.28.0', '--registry', join(dir, 'llm-deprecations.json')]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('npm:openai@4 -> npm:openai@5');
  }, 180_000);

  it('still sends a model id down the model path', async () => {
    const r = await mendrResolve(['gpt-4-0613']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith('gpt-4-0613 -> ')).toBe(true);
    expect(r.stdout).not.toContain('sdk_');
  }, 180_000);
});
