import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// END-TO-END: a secret driven through a REAL migrate run, asserted absent from
// the text the action publishes.
//
// The unit tests in src/redact/sanitize.test.ts prove the sanitizer redacts
// what it is handed. They cannot prove it is REACHED. This one runs the actual
// CLI over an actual repository and checks the actual report, because the
// defect being fixed was never a weak pattern — it was a whole output plane
// that no sanitizer was wired into:
//
//   src/cli.ts        echoed --eval-command to stderr
//   run-mendr.sh:115  captured stderr into $REPORT with 2>&1
//   run-mendr.sh:210  cat "$REPORT" into a PUBLIC pull-request body
//
// The canary sits three lines from the model id on purpose: a unified diff
// carries three lines of context, so a report that prints the diff prints the
// secret with it.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANARY = 'sk-MENDRCANARY0000000000000000000000';

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

function repoWithSecretBesideTheFinding(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-canary-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'canary-fixture', version: '1.0.0' }, null, 2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'client.ts'),
    [
      'import OpenAI from "openai";',
      '',
      `const client = new OpenAI({ apiKey: "${CANARY}" });`,
      '',
      'export async function ask(prompt: string) {',
      "  return client.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'user', content: prompt }] });",
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

async function runMigrate(dir: string, extra: string[] = []): Promise<string> {
  const { stdout, stderr } = await execa('npx', ['tsx', join(MENDR_ROOT, 'src', 'cli.ts'), 'migrate', dir, ...extra], {
    cwd: MENDR_ROOT,
    reject: false,
  });
  // The action captures BOTH streams into one file (2>&1) and publishes that
  // file, so both are in scope for this assertion.
  return `${stdout}\n${stderr}`;
}

describe('a credential never reaches the text the action publishes', () => {
  it('redacts a key sitting in the diff context of a finding', async () => {
    const out = await runMigrate(repoWithSecretBesideTheFinding());

    expect(out).not.toContain(CANARY);
    expect(out).not.toContain('MENDRCANARY');
    // The report must still be a report: redaction is not a way to pass by
    // printing nothing.
    expect(out.toLowerCase()).toMatch(/verdict|gpt-4|migration/);
  }, 180_000);

  it('redacts a key inlined in the eval command it echoes back', async () => {
    const out = await runMigrate(repoWithSecretBesideTheFinding(), [
      '--eval-command',
      `OPENAI_API_KEY=${CANARY} node -e "process.exit(0)"`,
    ]);

    // This is the exact published-secret chain: mendr echoes the eval command
    // to stderr, the action captures stderr, the action cats it into a public
    // pull-request body.
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain('MENDRCANARY');
  }, 180_000);
});
