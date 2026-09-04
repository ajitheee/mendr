import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// THE ABORTED WRITE, END TO END.
//
// `--write` is all-or-nothing: if any target fails pre-flight (a read-only
// file, a file an editor holds a lock on, content that drifted since the scan),
// NOTHING is written. That part worked. What did not was the report — the
// Summary block was computed from the INTENT to write and printed BEFORE the
// write ran, so a run that changed zero files still announced:
//
//     Summary: tier A 3 (3 auto-fixed), ...
//
// Exit code and one stderr line were the only signals that the headline number
// was false, and `--json` carried no signal at all. This is the path a customer
// hits the first time a file is read-only or open in an editor with a lock, so
// the first thing they would ever see mendr say would be a lie about their
// working tree.
//
// Hermetic: a temp-dir fixture with one deprecated model arg, made read-only.
// The CLI runs from source through tsx — the same entry point `mendr` ships.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      // Restore write permission first, or the read-only fixture blocks its
      // own teardown on Windows.
      chmodSync(join(dir, 'src', 'chat.ts'), 0o666);
    } catch {
      /* best effort */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** One verified Tier A swap in one file, which is then made read-only. */
function makeReadOnlyRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-writerefusal-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'write-refusal' }, null, 2));
  mkdirSync(join(dir, 'src'));
  const file = join(dir, 'src', 'chat.ts');
  writeFileSync(
    file,
    [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export async function chat() {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  // Read-only ATTRIBUTE on Windows, permission bits on POSIX. Either way the
  // atomic write's pre-flight refuses the whole batch.
  chmodSync(file, 0o444);
  return { dir, file };
}

async function runFixLlm(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

describe('fix-llm --write against a file it cannot write', () => {
  it(
    'never claims an auto-fix for a write that was refused',
    async () => {
      const { dir, file } = makeReadOnlyRepo();
      const before = readFileSync(file, 'utf8');
      const { exitCode, stdout, stderr } = await runFixLlm([dir, '--write']);

      // (1) THE HEADLINE NUMBER. Zero files changed, so zero auto-fixed.
      expect(stdout).toContain('0 auto-fixed');
      expect(stdout).not.toContain('1 auto-fixed');
      // ...and the slot that DID move says write, not gates: the diff was fine.
      expect(stdout).toContain('not written -- write refused, working tree unchanged');
      expect(stdout).not.toContain('Applied the verified Tier A fix');

      // (2) THE WORKING TREE. Untouched, byte for byte.
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readFileSync(file, 'utf8')).toContain('gpt-4-0613');

      // (3) The existing signals still fire — this fix adds to them.
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--write aborted');
      expect(stderr).toContain('not writable');
      expect(stderr).toContain('no files were changed.');
    },
    120_000,
  );

  it(
    'records the refusal in --json, where stderr is not the document',
    async () => {
      const { dir, file } = makeReadOnlyRepo();
      const { exitCode, stdout } = await runFixLlm([dir, '--write', '--json']);
      const report = JSON.parse(stdout) as {
        summary: { tierA: number };
        write: { attempted: boolean; applied: boolean; filesWritten: number; reason: string | null };
      };

      // A machine consumer reading `summary.tierA` alone would conclude a fix
      // landed. This field is what makes that unambiguous.
      expect(report.write.attempted).toBe(true);
      expect(report.write.applied).toBe(false);
      expect(report.write.filesWritten).toBe(0);
      expect(report.write.reason).toContain('not writable');
      expect(exitCode).toBe(1);
      expect(readFileSync(file, 'utf8')).toContain('gpt-4-0613');
    },
    120_000,
  );

  it(
    'reports a SUCCESSFUL write in the same field, so the two are told apart',
    async () => {
      // The other half of the property: `applied: true` has to mean something,
      // or a consumer learns to ignore the field.
      const { dir, file } = makeReadOnlyRepo();
      chmodSync(file, 0o666);
      const { exitCode, stdout } = await runFixLlm([dir, '--write', '--json']);
      const report = JSON.parse(stdout) as {
        write: { attempted: boolean; applied: boolean; filesWritten: number; reason: string | null };
      };

      expect(exitCode).toBe(0);
      expect(report.write).toEqual({
        attempted: true,
        applied: true,
        filesWritten: 1,
        reason: null,
      });
      expect(readFileSync(file, 'utf8')).toContain('gpt-5.6-sol');
    },
    120_000,
  );

  it(
    'a read-only run that never asked to write reports no attempt at all',
    async () => {
      const { dir } = makeReadOnlyRepo();
      const { stdout } = await runFixLlm([dir, '--json']);
      const report = JSON.parse(stdout) as {
        write: { attempted: boolean; applied: boolean; reason: string | null };
      };
      expect(report.write).toEqual({
        attempted: false,
        applied: false,
        filesWritten: 0,
        reason: null,
      });
    },
    120_000,
  );
});
