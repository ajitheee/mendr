import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// CROSS-PACKAGE SCHEMA COMPATIBILITY.
//
// The scanner (this package) emits `mendr audit --json`; the App (app/) consumes
// it through validateReport + sanitizeReport. These are two packages that ship
// and change independently, so this test wires them together: it runs the REAL
// scanner and feeds its REAL output to the App's REAL validator. If either side
// changes the schema incompatibly — the scanner renames a field, or the App
// tightens a rule — this test fails, and the build (npm test in CI) blocks the
// release. It imports the App's validator directly (a pure module: only redact),
// so it needs no app dependencies.

import { validateReport, sanitizeReport, countDecisions, SCHEMA } from '../../app/src/ingest/validate.js';
import { migrationWorkflowPresent } from '../../app/src/ingest/migration.js';

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo exercising every decision the App must accept: patch, review, informational, and a test-only ref. */
function sampleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-compat-'));
  created.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'client.ts'),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n',
  );
  writeFileSync(join(dir, 'config.env'), 'OPENAI_MODEL=gpt-4\n');
  writeFileSync(join(dir, 'src', 'app.test.ts'), 'test("x", async () => { const m = "gpt-3.5-turbo"; return m; });\n');
  return dir;
}

async function auditJson(dir: string): Promise<string> {
  const r = await execa('tsx', ['src/cli.ts', 'audit', dir, '--json'], {
    cwd: MENDR_ROOT,
    reject: false,
    env: { ...process.env, MENDR_UNICODE: '1' },
  });
  expect(r.exitCode).toBe(0);
  return r.stdout;
}

describe('scanner JSON validates against the App consumer', () => {
  it('the scanner emits the schema version the App expects', async () => {
    const report = JSON.parse(await auditJson(sampleRepo()));
    expect(report.schema).toBe(SCHEMA); // a bump on either side without the other fails here
  }, 120_000);

  it('real audit output passes the App\'s validateReport unchanged', async () => {
    const raw = await auditJson(sampleRepo());
    const v = validateReport(raw, 4 * 1024 * 1024);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(`App rejected scanner output: ${v.message}`);
  }, 120_000);

  it('the App can sanitize it, count its decisions, and read the fields it renders', async () => {
    const raw = await auditJson(sampleRepo());
    const v = validateReport(raw, 4 * 1024 * 1024);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const report = sanitizeReport(v.report);
    // conclusion is one the App knows; decisions count without throwing.
    expect(['exposure_detected', 'no_exposure_in_completed_surfaces', 'inconclusive', 'audit_failed']).toContain(report.conclusion);
    const counts = countDecisions(report);
    expect(counts.patch + counts.review + counts.informational).toBe(report.investigations.length);
    // the fields the App's check run + finding page read must be present.
    const patch = report.investigations.find((i) => i.decision === 'patch');
    expect(patch).toBeDefined();
    const loc = patch!.locations.selectors[0]!;
    expect(typeof loc.file).toBe('string');
    expect(Number.isInteger(loc.line)).toBe(true);
    expect(patch!.retirementEvidence?.replacement).toBeTruthy();
    expect(typeof patch!.nextAction === 'string' || patch!.nextAction === null).toBe(true);
    // The App decides which "Prepare migration for review" step to offer from
    // this field; the sample repo carries no mendr-migrate.yml.
    expect(migrationWorkflowPresent(report)).toBe(false);
  }, 120_000);
});
