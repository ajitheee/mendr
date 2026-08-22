import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveRegistryPath } from './usage/llmRegistry.js';

// `mendr validate-registry`, end to end. The unit tests in
// registry/validateRegistry.test.ts prove the RULES; this proves the PROCESS
// CONTRACT that CI depends on — exit 0 with a summary line on a clean registry,
// exit 1 with the offending record named on a broken one. A validator that
// finds problems and exits 0 is a validator nobody notices is broken.
//
// Hermetic: no network, and the corrupted registries are temp copies. The
// shipped file is only ever READ.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function validate(
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'validate-registry', ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A temp copy of the SHIPPED registry with `mutate` applied to one record.
 * Copying rather than editing in place is not politeness: a test that corrupts
 * the real registry and restores it in a finally block leaves the repo broken
 * the moment the run is interrupted.
 */
function corruptedRegistry(
  deprecated: string,
  mutate: (record: Record<string, unknown>) => void,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-validate-'));
  created.push(dir);
  const raw = JSON.parse(readFileSync(resolveRegistryPath(), 'utf8')) as Record<string, unknown>[];
  const record = raw.find((e) => e.kind === 'model_id' && e.deprecated === deprecated);
  if (!record) throw new Error(`fixture error: no registry record for "${deprecated}"`);
  mutate(record);
  const path = join(dir, 'llm-deprecations.json');
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}

describe('mendr validate-registry', () => {
  it('passes on the shipped registry, and says how many records it checked', async () => {
    const { exitCode, stdout } = await validate();
    expect(stdout).toContain('registry OK: 0 violations across 106 model_id records.');
    expect(exitCode).toBe(0);
  }, 60_000);

  it('fails, and names the record, when a verified stamp loses one of its proofs', async () => {
    const path = corruptedRegistry('gpt-4', (record) => {
      (record.verification as Record<string, unknown>).replacementConfirmed = false;
    });
    const { exitCode, stdout } = await validate(['--registry', path]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('registry INVALID: 1 violation(s)');
    expect(stdout).toContain('openai.gpt-4.retirement-2026-10-23');
    expect(stdout).toContain('[verified_without_replacement_confirmation]');
    expect(stdout).toContain('summary: 1 violation(s) across 106 model_id records');
  }, 60_000);

  it('fails when a record is switched on under a non-verified status', async () => {
    const path = corruptedRegistry('gemini-2.0-flash', (record) => {
      (record.verification as Record<string, unknown>).autoApplyAllowed = true;
    });
    const { exitCode, stdout } = await validate(['--registry', path]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('[auto_apply_without_verified_status]');
    // ...and the PROSE LINT fires on the same record, because the caveat that
    // quarantined it is still sitting in `reasons` under a switched-on record.
    // That is the whole shape of the original defect.
    expect(stdout).toContain('[caveat_over_auto_apply]');
  }, 60_000);

  it('fails a quarantine that no longer says what has to be resolved', async () => {
    const path = corruptedRegistry('gemini-2.0-flash', (record) => {
      (record.verification as Record<string, unknown>).quarantineReason = null;
    });
    const { exitCode, stdout } = await validate(['--registry', path]);
    expect(exitCode).toBe(1);
    // The LOADER rejects this one before the rule set is even reached — a
    // quarantine with no cause is malformed data, not merely a policy breach —
    // and the command still exits non-zero, which is the contract CI holds.
    expect(stdout + '').not.toContain('registry OK');
  }, 60_000);

  it('fails a hand-edited entryId', async () => {
    const path = corruptedRegistry('gpt-4', (record) => {
      record.entryId = 'openai.gpt-4.the-big-one';
    });
    const { exitCode, stdout } = await validate(['--registry', path]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('[entry_id_mismatch]');
  }, 60_000);
});
