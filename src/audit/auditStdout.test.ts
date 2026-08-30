import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// THE `audit` CLI CONTRACT, END TO END.
//
// The unit tests cover renderAuditIssue's RETURN VALUE; this suite runs the REAL
// CLI and asserts what actually reaches stdout — the guarantees a design partner
// and the shipped GitHub workflow both depend on:
//   * the JSON carries every issue counter the workflow reads (including
//     carriedCount, which the workflow needs to distinguish "not re-checked" from
//     "resolved")
//   * no credential is required for a full audit
//   * runtime usage reads "not measured" when nothing is connected
//   * unsupported languages appear in the coverage report
//   * no false clean: a skipped surface can never be closable
//
// A stale build or a wiring regression between the renderer and the CLI fails
// HERE, not in a customer's CI.

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

/** A repo with a live gpt-4 call site in TS, plus Go files we cannot analyze. */
function sampleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-cli-'));
  created.push(dir);
  writeFileSync(join(dir, 'client.ts'), 'export const r = await openai.chat.completions.create({ model: "gpt-4" });\n');
  mkdirSync(join(dir, 'svc'), { recursive: true });
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(dir, 'svc', `handler${i}.go`), 'package svc\n');
  }
  return dir;
}

async function runAudit(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', 'audit', ...args], {
    cwd: MENDR_ROOT,
    reject: false,
    env: { ...process.env, ...env },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

describe('audit CLI — the JSON contract the GitHub workflow depends on', () => {
  it('carries every issue counter, including carriedCount', async () => {
    const dir = sampleRepo();
    const { stdout, exitCode } = await runAudit([dir, '--sha', 'abc1234', '--json']);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.schema).toBe('mendr-audit/v3');
    expect(json.issue).toBeDefined();
    // The workflow reads openCount and closable; carriedCount is what lets a
    // reader tell "not re-checked" apart from "resolved".
    for (const field of ['openCount', 'newCount', 'resolvedCount', 'carriedCount', 'closable']) {
      expect(json.issue, `issue.${field} must be present`).toHaveProperty(field);
    }
    expect(typeof json.issue.carriedCount).toBe('number');
    expect(json.sha).toBe('abc1234');
  }, 120_000);

  it('reports carriedCount > 0 when a surface did not complete, and stays non-closable', async () => {
    const dir = sampleRepo();
    const prior = join(dir, 'prior.md');
    const first = await runAudit([dir, '--sha', 'aaa', '--issue-body', prior, '--json']);
    expect(JSON.parse(first.stdout).issue.openCount).toBeGreaterThan(0);

    // Skip the source scan: the previously-found code findings cannot be re-checked.
    const second = await runAudit([dir, '--skip-source', '--sha', 'bbb', '--previous-body', prior, '--json']);
    const json = JSON.parse(second.stdout).issue;
    expect(json.carriedCount).toBeGreaterThan(0);
    expect(json.resolvedCount).toBe(0); // never falsely resolved
    expect(json.closable).toBe(false); // and never closable
  }, 180_000);
});

describe('audit CLI — release guarantees', () => {
  it('needs NO credentials: a full audit runs with every provider key unset', async () => {
    const dir = sampleRepo();
    const { exitCode, stdout } = await runAudit([dir], {
      MENDR_PROVIDER_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Audit coverage');
    expect(stdout).toContain('EXPOSURE DETECTED');
  }, 120_000);

  it('says runtime usage is NOT MEASURED when nothing is connected', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir]);
    expect(stdout).toContain('○ Runtime usage:');
    expect(stdout).toContain('not measured');
  }, 120_000);

  it('discloses unsupported languages present in the repo', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir, '--json']);
    const json = JSON.parse(stdout);
    expect(json.coverage.source.unanalyzedLanguages.join(' ')).toContain('Go');
  }, 120_000);

  it('cannot reach a clean conclusion when a surface was skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-empty-'));
    created.push(dir);
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    const { stdout } = await runAudit([dir, '--skip-source', '--json']);
    const json = JSON.parse(stdout);
    expect(json.conclusion).toBe('inconclusive');
    expect(json.conclusion).not.toBe('clean');
  }, 120_000);

  it('never prints a provider key that is present in the environment', async () => {
    const dir = sampleRepo();
    const { stdout, stderr } = await runAudit([dir, '--json'], {
      MENDR_PROVIDER_KEY: 'sk-admin-SUPERSECRETVALUE123456',
    });
    expect(stdout).not.toContain('SUPERSECRETVALUE');
    expect(stderr).not.toContain('SUPERSECRETVALUE');
  }, 120_000);
});
