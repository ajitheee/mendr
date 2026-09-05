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
const EOL_LF = String.fromCharCode(10);

function sampleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-cli-'));
  created.push(dir);
  // The canonical Tier-A shape: a first-party SDK client resolved IN THIS FILE,
  // called inside a function. (A bare `openai.…create()` at module level with an
  // undeclared receiver is exactly what external validation found being promoted
  // to PATCH ELIGIBLE, and is now capped at review.)
  writeFileSync(
    join(dir, 'client.ts'),
    'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function ask() {\n' +
      '  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n' +
      '}\n',
  );
  mkdirSync(join(dir, 'svc'), { recursive: true });
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(dir, 'svc', `handler${i}.go`), 'package svc\n');
  }
  return dir;
}

async function runAudit(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // The canonical report is UTF-8; a captured stdout on Windows would otherwise
  // (correctly) switch to ASCII. Pin the glyph form so assertions are stable.
  const result = await execa('tsx', ['src/cli.ts', 'audit', ...args], {
    cwd: MENDR_ROOT,
    reject: false,
    env: { ...process.env, MENDR_UNICODE: '1', ...env },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

describe('audit CLI — JavaScript source is analyzed, not reported as a gap', () => {
  const jsDirs: string[] = [];
  afterEach(() => { for (const d of jsDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('a JavaScript-only repo reports exposure with jsFiles counted, not "inconclusive"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-js-'));
    jsDirs.push(dir);
    writeFileSync(
      join(dir, 'client.mjs'),
      'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask(t) {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n',
    );
    writeFileSync(join(dir, 'util.js'), 'export const HELLO = "world";\n');
    const { stdout, exitCode } = await runAudit([dir, '--json']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.conclusion).toBe('exposure_detected');
    expect(report.coverage.source.jsFiles).toBeGreaterThanOrEqual(2);
    expect(report.coverage.source.tsFiles).toBe(0);
    const inv = report.investigations.find((i: { model: string }) => i.model === 'gpt-4');
    expect(inv).toBeDefined();
    expect(['patch', 'review']).toContain(inv.decision);
    expect(inv.locations.selectors.some((l: { file: string }) => l.file.endsWith('client.mjs'))).toBe(true);
    // JavaScript must not be named as an unanalyzed language.
    expect((report.coverage.source.unanalyzedLanguages || []).some((l: string) => l.startsWith('JavaScript'))).toBe(false);
  }, 120_000);

  it('the human report names the JS file count in the coverage matrix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-js2-'));
    jsDirs.push(dir);
    writeFileSync(
      join(dir, 'a.js'),
      'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4" });\n}\n',
    );
    const { stdout, exitCode } = await runAudit([dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\d+ JS/);
  }, 120_000);
});

describe('audit CLI — test files are scanned as test-only references, never migrated', () => {
  const trDirs: string[] = [];
  afterEach(() => { for (const d of trDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('a retiring id in a test file is informational (test_fixture, Tier C, not patch-eligible)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-tr-'));
    trDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'import OpenAI from "openai";\nconst c = new OpenAI();\nexport async function a(){ return c.chat.completions.create({ model: "gpt-4", messages: [] }); }\n');
    writeFileSync(join(dir, 'src', 'app.test.ts'), 'import OpenAI from "openai";\nconst c = new OpenAI();\ntest("x", async () => { await c.chat.completions.create({ model: "gpt-3.5-turbo", messages: [] }); });\n');
    const { stdout, exitCode } = await runAudit([dir, '--json']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    const prod = report.investigations.find((i: { model: string }) => i.model === 'gpt-4');
    const test = report.investigations.find((i: { model: string }) => i.model === 'gpt-3.5-turbo');
    // production id is patch-eligible; the test-file id is informational only
    expect(prod.decision).toBe('patch');
    expect(test.decision).toBe('monitor');
    const testLoc = [...test.locations.selectors, ...test.locations.catalog][0];
    expect(testLoc.role).toBe('test_fixture');
    expect(testLoc.tier).toBe('C');
    expect(testLoc.patchEligible).toBe(false);
    // it lives in catalog (informational), never as a selector
    expect(test.locations.selectors.length).toBe(0);
  }, 120_000);
});

describe('audit CLI — deterministic exit codes (a broken scan never reads as clean)', () => {
  const exDirs: string[] = [];
  afterEach(() => { for (const d of exDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-exit-'));
    exDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
    return dir;
  }
  const CALL = 'import OpenAI from "openai";\nconst c = new OpenAI();\nexport async function a(){ return c.chat.completions.create({ model: "gpt-4", messages: [] }); }\n';

  it('clean and exposure both exit 0 by default (monitoring stays green)', async () => {
    expect((await runAudit([repo({ 'y.ts': 'export const x = 1;\n' })])).exitCode).toBe(0);
    expect((await runAudit([repo({ 'x.ts': CALL })])).exitCode).toBe(0);
  }, 120_000);

  it('--fail-on-exposure makes exposure exit 1 (opt-in CI gate)', async () => {
    expect((await runAudit([repo({ 'x.ts': CALL }), '--fail-on-exposure'])).exitCode).toBe(1);
    // clean still exits 0 even with the flag
    expect((await runAudit([repo({ 'y.ts': 'export const x = 1;\n' }), '--fail-on-exposure'])).exitCode).toBe(0);
  }, 120_000);

  it('an inconclusive scan exits 3, never 0 (not mistaken for clean/resolved)', async () => {
    // --skip-source: the audit cannot conclude anything.
    expect((await runAudit([repo({ 'x.ts': CALL }), '--skip-source'])).exitCode).toBe(3);
    // a repo mendr cannot analyze (Go only) is inconclusive, not clean.
    expect((await runAudit([repo({ 'main.go': 'package main\n' })])).exitCode).toBe(3);
  }, 120_000);
});

describe('audit CLI — reader tie-back (config env-var read proven in code)', () => {
  const tbDirs: string[] = [];
  afterEach(() => { for (const d of tbDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('proves the tie-back when code reads the env-var config selector, and reports the reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-tb-'));
    tbDirs.push(dir);
    // A committed env selector setting a retiring id, and code that reads that
    // exact env var and passes it as the model argument.
    writeFileSync(join(dir, 'config.env'), 'PORT=3000\nOPENAI_MODEL=gpt-4\n');
    writeFileSync(
      join(dir, 'client.ts'),
      'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  const model = process.env.OPENAI_MODEL ?? "gpt-4";\n  return client.chat.completions.create({ model, messages: [] });\n}\n',
    );
    const { stdout, exitCode } = await runAudit([dir, '--json']);
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.coverage.readerTieBack.proven).toBe(true);
    const inv = report.investigations.find((i: { model: string }) => i.model === 'gpt-4');
    expect(inv.verification.readerTieBackProven).toBe(true);
    const configLoc = inv.locations.selectors.find((l: { surface: string }) => l.surface === 'config');
    expect(configLoc.readerTieBack.proven).toBe(true);
    expect(configLoc.readerTieBack.readers[0].via).toContain('process.env.OPENAI_MODEL');
    expect(configLoc.readerTieBack.readers[0].file).toMatch(/client\.ts$/);

    // The human report shows the proven tie-back with the reader location.
    const human = await runAudit([dir]);
    expect(human.stdout).toMatch(/Reader tie-back: proven — read in code at .*client\.ts:4/);
  }, 120_000);

  it('leaves the tie-back unproven when no code reads the env var', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-tb2-'));
    tbDirs.push(dir);
    writeFileSync(join(dir, 'config.env'), 'OPENAI_MODEL=gpt-4\n');
    writeFileSync(join(dir, 'unrelated.ts'), 'export const x = 1;\n');
    const { stdout } = await runAudit([dir, '--json']);
    const report = JSON.parse(stdout);
    expect(report.coverage.readerTieBack.proven).toBe(false);
    const inv = report.investigations.find((i: { model: string }) => i.model === 'gpt-4');
    if (inv) expect(inv.verification.readerTieBackProven).toBe(false);
  }, 120_000);
});

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

// The product promise: never claim more than the evidence proves.
describe('audit CLI — claim discipline (release-copy corrections)', () => {
  it('calls a located call site VERIFIED DIRECT PROVIDER, never "proven production"', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir]);
    expect(stdout).toContain('verified direct provider call site');
    // Source analysis cannot prove production executes anything.
    expect(stdout).not.toContain('proven production call site');
  }, 120_000);

  it('states plainly that production usage was not measured', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir]);
    expect(stdout).toContain('Production usage was not measured.');
  }, 120_000);

  it('renders a patch decision as ELIGIBILITY with no change applied', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir]);
    expect(stdout).toContain('Decision: PATCH ELIGIBLE');
    expect(stdout).toContain('Status: No change applied');
    // The next action names the command and the exact line it would rewrite,
    // and never implies a proposal already exists.
    expect(stdout).toContain('Next action: run `mendr fix-llm <path>` to print the verified diff for client.ts:4');
    expect(stdout).toContain('Only Tier-A lines are rewritten.');
    // The bare lowercase form would read as "mendr patched it".
    expect(stdout).not.toMatch(/^Decision: patch$/m);
  }, 120_000);

  it('JSON keeps decision:"patch" but states patchEligible/patchApplied/productionUsage', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir, '--json']);
    const inv = JSON.parse(stdout).investigations.find((i: { decision: string }) => i.decision === 'patch');
    expect(inv).toBeDefined();
    expect(inv.decision).toBe('patch'); // compatibility
    expect(inv.patchEligible).toBe(true);
    expect(inv.patchApplied).toBe(false); // ALWAYS false — the audit applies nothing
    expect(inv.productionUsage).toBe('not_measured');
    expect(inv.productionUsageDetail.measured).toBe(false); // detail preserved
  }, 120_000);

  it('JSON carries the evidence a UI needs: repo, timestamp, next action, a limited snippet and a line hash per location', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir, '--json']);
    const report = JSON.parse(stdout);
    expect(typeof report.repo).toBe('string');
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const inv = report.investigations.find((i: { decision: string }) => i.decision === 'patch');
    expect(inv.nextAction).toContain('mendr fix-llm <path>');
    const loc = inv.locations.selectors[0];
    expect(loc.disposition).toBe('patch');
    expect(loc.patchEligible).toBe(true);
    // A few lines of context around the reported line, never the file; the
    // reported line is inside the window and its hash is stable.
    expect(loc.snippet.startLine).toBeGreaterThan(0);
    expect(loc.snippet.startLine).toBeLessThanOrEqual(loc.line);
    expect(loc.snippet.lines.length).toBeLessThanOrEqual(7);
    expect(loc.snippet.lines[loc.line - loc.snippet.startLine]).toContain('gpt-4');
    expect(loc.lineHash).toMatch(/^[0-9a-f]{16}$/);
  }, 120_000);

  it('JSON snippets pass through the same secret redaction as the issue body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-audit-cli-'));
    created.push(dir);
    // A key on the line right after a model literal: it lands inside the ±3-line
    // snippet window and must never leave the machine intact, even in JSON.
    writeFileSync(
      join(dir, 'client.ts'),
      [
        'import OpenAI from "openai";',
        'const client = new OpenAI();',
        'export async function ask() {',
        '  return client.chat.completions.create({ model: "gpt-4", messages: [] });',
        '}',
        'const leaked = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
        'process.env.OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123";',
        '',
      ].join(EOL_LF),
    );
    const { stdout } = await runAudit([dir, '--json']);
    expect(stdout).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(stdout).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    const report = JSON.parse(stdout);
    const loc = report.investigations.find((i: { decision: string }) => i.decision === 'patch').locations.selectors[0];
    const snippet = loc.snippet.lines.join(EOL_LF);
    expect(snippet).toContain('gpt-4');
    expect(snippet).toContain('REDACTED');
  }, 120_000);

  it('never reports patchApplied true for any finding', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir, '--json']);
    for (const inv of JSON.parse(stdout).investigations) {
      expect(inv.patchApplied).toBe(false);
    }
  }, 120_000);

  it('marks configuration NOT APPLICABLE (○) when no supported config files exist', async () => {
    const dir = sampleRepo(); // has .ts and .go only — no config files
    const { stdout } = await runAudit([dir, '--json']);
    expect(JSON.parse(stdout).coverage.config.filesScanned).toBe(0);
    const human = await runAudit([dir]);
    expect(human.stdout).toContain('○ Configuration:     not applicable — no supported configuration files found');
    // A tick is reserved for a surface that actually scanned something.
    expect(human.stdout).not.toContain('✓ Configuration:     0 files scanned');
  }, 120_000);

  it('still ticks configuration when real config files were scanned', async () => {
    const dir = sampleRepo();
    writeFileSync(join(dir, 'app.yaml'), 'model: gpt-4\n');
    const { stdout } = await runAudit([dir]);
    expect(stdout).toMatch(/✓ Configuration:\s+1 files scanned/);
  }, 120_000);
});

// The bug this suite exists for: mendr scanned its own saved report, read the
// model ids inside its own findings as runtime selectors, and reported 75 false
// exposures. Generated output must never become input.
describe('audit CLI — no recursive self-detection', () => {
  it('REPEATABILITY: saving mendr JSON inside the repo does not change the next run', async () => {
    const dir = sampleRepo();
    const first = JSON.parse((await runAudit([dir, '--json'])).stdout);

    // Save mendr's own output INTO the scanned repository, at the root — no
    // directory rule can save us here; only the generatedBy marker can.
    writeFileSync(join(dir, 'mendr-report.json'), JSON.stringify(first, null, 2));
    const second = JSON.parse((await runAudit([dir, '--json'])).stdout);

    expect(second.investigations.length).toBe(first.investigations.length);
    expect(second.conclusion).toBe(first.conclusion);
    expect(second.investigations.map((i: { model: string; decision: string }) => `${i.model}:${i.decision}`))
      .toEqual(first.investigations.map((i: { model: string; decision: string }) => `${i.model}:${i.decision}`));
  }, 240_000);

  it('stamps generatedBy on its own JSON so it can be recognised anywhere', async () => {
    const dir = sampleRepo();
    const { stdout } = await runAudit([dir, '--json']);
    expect(JSON.parse(stdout).generatedBy).toBe('mendr');
  }, 120_000);

  it('ignores a mendr report even when renamed and placed at the repo root', async () => {
    const dir = sampleRepo();
    const report = JSON.parse((await runAudit([dir, '--json'])).stdout);
    const before = report.investigations.length;
    // Rename it to something innocuous — the marker, not the path, must save us.
    writeFileSync(join(dir, 'app-config.json'), JSON.stringify(report));
    const after = JSON.parse((await runAudit([dir, '--json'])).stdout);
    expect(after.investigations.length).toBe(before);
  }, 240_000);

  it('never treats generated-artifact directories as configuration', async () => {
    const dir = sampleRepo();
    for (const d of ['test-results', 'coverage', 'playwright-report', '.mendr']) {
      mkdirSync(join(dir, d), { recursive: true });
      // A file that WOULD look like a live selector if it were real config.
      writeFileSync(join(dir, d, 'out.yaml'), 'model: gpt-3.5-turbo\n');
    }
    const { stdout } = await runAudit([dir, '--json']);
    const json = JSON.parse(stdout);
    const files = json.investigations.flatMap((i: { locations: { selectors: { file: string }[]; catalog: { file: string }[] } }) =>
      [...i.locations.selectors, ...i.locations.catalog].map((l) => l.file));
    for (const d of ['test-results', 'coverage', 'playwright-report', '.mendr']) {
      expect(files.some((f: string) => f.startsWith(`${d}/`)), `${d} must not be scanned`).toBe(false);
    }
  }, 180_000);

  it('a catalog-only repo concludes NO EXPOSURE, not EXPOSURE DETECTED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-catalog-'));
    created.push(dir);
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    // A vendored catalog naming many deprecated ids — data, not a dependency.
    const ids = ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-32k', 'claude-2.1', 'claude-1',
      'gemini-pro', 'gemini-1.5-pro', 'text-davinci-003', 'dall-e-2'];
    writeFileSync(join(dir, 'catalog.yaml'), ids.map((m) => `${m}:\n  model: ${m}\n`).join(''));
    const { stdout } = await runAudit([dir, '--json']);
    const json = JSON.parse(stdout);
    expect(json.conclusion).toBe('no_exposure_in_completed_surfaces');
    expect(json.investigations.every((i: { decision: string }) => i.decision === 'monitor')).toBe(true);

    const human = await runAudit([dir]);
    expect(human.stdout).toContain('NO EXPOSURE IN COMPLETED SURFACES');
    expect(human.stdout).toContain('We found no retiring AI dependencies in use.');
    // Informational records must NOT be called retiring dependencies.
    expect(human.stdout).not.toMatch(/We found (?!no )\w+ retiring AI dependenc/);
  }, 180_000);

  it('says "Monitor provider status" when a record has no dated deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-undated-'));
    created.push(dir);
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'models.yaml'), 'supported:\n  - o1-mini\n'); // undated in the registry
    const { stdout } = await runAudit([dir]);
    if (stdout.includes('no dated deadline')) {
      expect(stdout).toContain('Next action: Monitor provider status');
      expect(stdout).not.toContain('Next action: Track until the retirement date');
    }
  }, 120_000);
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
