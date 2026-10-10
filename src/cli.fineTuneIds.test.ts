import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// OPENAI FINE-TUNED MODEL IDS WRITTEN IN SOURCE CODE, END TO END.
//
// v0.5.9-alpha's known issue: a repository whose only calls use `ft:…` ids audited as no
// exposure, and `fix-llm` printed "Nothing to fix", although OpenAI stops serving those
// fine-tunes on 2026-10-23. The unit suites (usage/fineTuneScan.test.ts, python/fineTuneScan.test.ts)
// pin the classification; this one pins that `fix-llm`, `audit` and `watch` report the same
// thing about the same lines, and that nothing is ever swapped.
//
// Hermetic: temp-dir fixtures written for this suite, `fix-llm --skip-gates` (no type-check, no
// tests, no network), `audit --offline`, `watch --no-exposure-file`, all run from source via tsx.

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

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-fine-tune-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fine-tunes' }, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa('tsx', ['src/cli.ts', command, ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
    env: { ...process.env, MENDR_REGISTRY_MAX_AGE_DAYS: '100000' },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/** The three shapes from the known issue: two TypeScript calls and one Python call. */
const CHAT_TS = [
  "import OpenAI from 'openai';",
  'const client = new OpenAI();',
  'export async function run(messages: any[]) {',
  "  await client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc', messages, max_tokens: 20 });",
  "  await client.completions.create({ model: 'ft:babbage-002:acme::9abc', prompt: 'hi' });",
  '}',
  '',
].join('\n');

const TUNE_PY = [
  'from openai import OpenAI',
  'client = OpenAI()',
  '',
  'def run(messages):',
  '    return client.chat.completions.create(model="ft:gpt-4-0613:acme::abc123", messages=messages)',
  '',
].join('\n');

interface TierBRow {
  file: string;
  line: number;
  modelId: string;
  entryId?: string;
  reason: string;
  replacementVerdict: string;
}

describe('fine-tuned model ids in source code', () => {
  it('fix-llm lists each one as held for review, with its own row, and swaps nothing', async () => {
    const dir = repo({ 'src/chat.ts': CHAT_TS, 'svc/tune.py': TUNE_PY });

    const { stdout } = await run('fix-llm', [dir, '--skip-gates', '--json']);
    const report = JSON.parse(stdout) as { tierA: unknown[]; tierB: TierBRow[]; summary: { tierC: number } };
    expect(report.tierA).toEqual([]);
    expect(report.summary.tierC).toBe(0);
    expect(report.tierB.map((f) => [f.file, f.line, f.modelId, f.entryId, f.reason, f.replacementVerdict])).toEqual([
      ['src/chat.ts', 4, 'ft:gpt-3.5-turbo-0125:acme::9abc', 'openai.ft-gpt-3.5-turbo.retirement-2026-10-23', 'surface_capped', 'quarantined'],
      ['src/chat.ts', 5, 'ft:babbage-002:acme::9abc', 'openai.ft-babbage-002.retirement-2026-10-23', 'surface_capped', 'quarantined'],
      ['svc/tune.py', 5, 'ft:gpt-4-0613:acme::abc123', 'openai.ft-gpt-4.retirement-2026-10-23', 'surface_capped', 'quarantined'],
    ]);

    const human = await run('fix-llm', [dir, '--skip-gates']);
    expect(human.stdout).not.toContain('Nothing to fix');
    expect(human.stdout).toContain(
      "ft:gpt-3.5-turbo-0125:acme::9abc is a fine-tune of gpt-3.5-turbo-0125, so mendr never swaps it",
    );
    expect(human.stdout).toContain("would drop the customer's training");

    // --write changes nothing: the ids stay, and the held call's own max_tokens is not renamed.
    await run('fix-llm', [dir, '--skip-gates', '--write']);
    expect(readFileSync(join(dir, 'src/chat.ts'), 'utf8')).toBe(CHAT_TS);
    expect(readFileSync(join(dir, 'svc/tune.py'), 'utf8')).toBe(TUNE_PY);
  }, 240_000);

  it('audit counts them as exposure, on the same lines, and says why they are never swapped', async () => {
    const dir = repo({ 'src/chat.ts': CHAT_TS, 'svc/tune.py': TUNE_PY });
    const { stdout } = await run('audit', [dir, '--offline', '--json']);
    const report = JSON.parse(stdout) as {
      conclusion: string;
      investigations: {
        model: string;
        decision: string;
        reason: string;
        locations: { selectors: { file: string; line: number; tier: string; reason: string | null }[] };
      }[];
    };
    expect(report.conclusion).toBe('exposure_detected');
    const rows = report.investigations
      .flatMap((i) => i.locations.selectors.map((s) => [i.model, i.decision, s.file, s.line, s.tier, s.reason]))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(rows).toEqual([
      ['ft-babbage-002', 'review', 'src/chat.ts', 5, 'B', 'surface_capped'],
      ['ft-gpt-3.5-turbo', 'review', 'src/chat.ts', 4, 'B', 'surface_capped'],
      ['ft-gpt-4', 'review', 'svc/tune.py', 5, 'B', 'surface_capped'],
    ]);
    for (const inv of report.investigations) {
      expect(inv.reason).toContain("would drop the customer's training");
      expect(inv.reason).not.toContain('not traced to a provider request');
    }

    const human = await run('audit', [dir, '--offline']);
    expect(human.stdout).toContain('EXPOSURE DETECTED');
    expect(human.stdout).toContain('fine-tuned models that mendr never swaps');
    expect(human.stdout).not.toContain('could not be traced to a provider request');
  }, 240_000);

  it('watch puts each one under review, in the same tier and on the same lines', async () => {
    const dir = repo({ 'src/chat.ts': CHAT_TS, 'svc/tune.py': TUNE_PY });
    const { stdout } = await run('watch', [dir, '--no-exposure-file', '--json']);
    const report = JSON.parse(stdout) as {
      models: { id: string; disposition: string; locations: { file: string; line: number; tier: string; reason?: string }[] }[];
    };
    expect(
      report.models
        .flatMap((m) => m.locations.map((l) => [m.id, m.disposition, l.file, l.line, l.tier, l.reason]))
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['ft-babbage-002', 'review_required', 'src/chat.ts', 5, 'B', 'surface_capped'],
      ['ft-gpt-3.5-turbo', 'review_required', 'src/chat.ts', 4, 'B', 'surface_capped'],
      ['ft-gpt-4', 'review_required', 'svc/tune.py', 5, 'B', 'surface_capped'],
    ]);
  }, 240_000);
});

describe('strings that only contain a fine-tune id', () => {
  it('are not findings in fix-llm or audit', async () => {
    const dir = repo({
      'src/notes.ts': [
        "import OpenAI from 'openai';",
        'const client = new OpenAI();',
        'export async function run(messages: any[], base: string) {',
        "  console.log('trained ft:gpt-3.5-turbo-0125:acme::9abc last week');",
        '  await client.chat.completions.create({ model: `ft:${base}:acme::9abc`, messages });',
        "  await client.chat.completions.create({ model: 'ft:gpt-4o-2024-08-06:acme::9abc', messages });",
        '}',
        '',
      ].join('\n'),
      'svc/notes.py': [
        'from openai import OpenAI',
        'client = OpenAI()',
        '',
        'def run(messages, base):',
        '    print("trained ft:gpt-4-0613:acme::abc123 last week")',
        '    return client.chat.completions.create(model=f"ft:{base}:acme::abc123", messages=messages)',
        '',
      ].join('\n'),
    });
    const fix = await run('fix-llm', [dir, '--skip-gates']);
    expect(fix.stdout).toContain('Nothing to fix');

    const { stdout } = await run('audit', [dir, '--offline', '--json']);
    const report = JSON.parse(stdout) as { conclusion: string; investigations: unknown[] };
    expect(report.investigations).toEqual([]);
    expect(report.conclusion).not.toBe('exposure_detected');
  }, 240_000);
});
