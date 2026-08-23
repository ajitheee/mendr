import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// A FILESYSTEM WRITE FAILURE MUST NOT CRASH.
//
// A user ran `mendr watch .` from C:\Windows\System32 and got a raw Node stack
// trace (EPERM on mkdir '.mendr'). Every other mendr command exits with one
// friendly `mendr: ...` line; the watch write paths must too — a wrong or
// unwritable directory is a routine mistake, not an internal error.
//
// Reproduced portably (no permissions games): put a FILE exactly where mendr
// needs to create a directory, so mkdir fails on every OS. The CLI runs from
// source through tsx — the same entry point `mendr` ships.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function runWatch(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'watch', ...args], {
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

/** stderr must never contain a raw Node stack frame. */
function assertNoStackTrace(stderr: string): void {
  expect(stderr).not.toMatch(/^\s+at .+\(/m);
  expect(stderr).not.toContain('node:fs');
}

describe('mendr watch survives a filesystem write failure', () => {
  it(
    'warns and still prints the summary when .mendr/exposure.json cannot be written',
    async () => {
      const dir = tempRepo('mendr-watch-wfail-');
      writeFileSync(
        join(dir, 'app.ts'),
        'export const c = create({ model: "gpt-4-0613", messages: [] });\n',
      );
      // A FILE where the `.mendr` directory must go: mkdir will fail.
      writeFileSync(join(dir, '.mendr'), 'not a directory');

      const { exitCode, stdout, stderr } = await runWatch([dir]);

      // The scan succeeded, so the summary still prints and the run is not fatal.
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Mendr Watch');
      expect(stdout).toContain('gpt-4-0613');
      // The failure is a friendly one-liner, not a crash.
      expect(stderr).toContain('could not write');
      expect(stderr).toContain('.mendr/exposure.json');
      assertNoStackTrace(stderr);
    },
    120_000,
  );

  it(
    'exits 1 with a friendly line when --install cannot create the workflow dir',
    async () => {
      const dir = tempRepo('mendr-watch-ifail-');
      // A FILE where `.github` must go: mkdir .github/workflows will fail.
      writeFileSync(join(dir, '.github'), 'not a directory');

      const { exitCode, stderr } = await runWatch([dir, '--install']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not scaffold the watch workflow');
      expect(stderr).toContain('project directory you can write to');
      assertNoStackTrace(stderr);
    },
    120_000,
  );
});
