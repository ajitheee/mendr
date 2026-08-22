import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `mendr evidence` is where a finding SENDS the reader, so the argument the
// finding prints has to be one this command accepts. It now prints an entryId;
// the bare model id is what people typed for months and will keep typing. Both
// resolve, or the pointer is broken.
//
// Hermetic: reads the shipped registry, makes no network call, writes nothing.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function evidence(id: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'evidence', id], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

describe('mendr evidence', () => {
  it('resolves an entryId -- the id findings actually print', async () => {
    const { exitCode, stdout } = await evidence('google.gemini-2.0-flash.retirement-undated');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('google: gemini-2.0-flash -> gemini-3.6-flash');
    expect(stdout).toContain('registry entry: google.gemini-2.0-flash.retirement-undated');
  }, 60_000);

  it('still resolves the bare model id', async () => {
    const { exitCode, stdout } = await evidence('gemini-2.0-flash');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('google: gemini-2.0-flash -> gemini-3.6-flash');
    // Even when asked by model id, it prints the record's stable id, so the
    // reader learns the name to use next time.
    expect(stdout).toContain('registry entry: google.gemini-2.0-flash.retirement-undated');
  }, 60_000);

  it('shows the four fields the gate reads, and says the prose is not one of them', async () => {
    const { stdout } = await evidence('google.gemini-2.0-flash.retirement-undated');
    expect(stdout).toContain('verification : quarantined');
    expect(stdout).toContain('official source confirmed : yes');
    expect(stdout).toContain('replacement confirmed     : yes');
    expect(stdout).toContain('auto-apply allowed        : NO');
    expect(stdout).toContain('engine gate  : HELD');
    expect(stdout).toContain('quarantined  : stamped "verified" while its own recorded research');
    expect(stdout).toContain('reasons (documentation only -- the gate reads the fields above):');
  }, 60_000);

  it('reports PASS on a record that clears the whole conjunction', async () => {
    const { stdout } = await evidence('openai.gpt-4.retirement-2026-10-23');
    expect(stdout).toContain('auto-apply allowed        : yes');
    expect(stdout).toContain('engine gate  : PASS -- eligible for a Tier A automatic patch');
  }, 60_000);

  it('exits 2 on an unknown id, naming both forms it accepts', async () => {
    const { exitCode, stderr } = await evidence('not-a-model');
    expect(exitCode).toBe(2);
    expect(stderr).toContain('expected an entryId');
    expect(stderr).toContain('or a deprecated model id');
  }, 60_000);
});
