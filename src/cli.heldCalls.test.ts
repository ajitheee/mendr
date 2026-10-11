import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// HELD CALLS, END TO END: audit, fix-llm and migrate name the same calls, with the same codes.
//
// v0.5.10-alpha's known issue: `migrate` listed only TypeScript blocked replacements and Azure
// aliases under `skipped`, so a repository whose only findings were held calls read
// "NO MIGRATION — no verified Tier-A swap was found." and the Action reported it clean. migrate now
// takes the Tier B streams fix-llm reports (report/heldCalls.ts) and their codes from
// classifyOccurrenceTier, which audit uses. This suite runs all three on one repository holding
// one occurrence of each kind, on the bundled registry, and pins that they agree line by line.
// Hermetic: temp-dir fixture, `fix-llm --skip-gates`, `migrate --skip-verify`, `audit --offline`.

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
  const dir = mkdtempSync(join(tmpdir(), 'mendr-held-calls-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'held-calls' }, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const result = await execa('tsx', ['src/cli.ts', command, ...args], {
    cwd: MENDR_ROOT,
    preferLocal: true,
    reject: false,
    windowsHide: true,
    env: { ...process.env, MENDR_REGISTRY_MAX_AGE_DAYS: '100000' },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '' };
}

const HELD_TS = [
  "import OpenAI from 'openai';", //                                                  1
  "import Anthropic from '@anthropic-ai/sdk';", //                                     2
  '', //                                                                               3
  'const openai = new OpenAI();', //                                                   4
  'const anthropic = new Anthropic();', //                                             5
  "const MODEL = 'claude-opus-4-1-20250805';", //                                      6  coupled_param_unverified
  '', //                                                                               7
  'export async function ask(prompt: string) {', //                                    8
  "  return anthropic.messages.create({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });",
  '}', //                                                                              10
  '', //                                                                               11
  'export async function tuned(prompt: string) {', //                                  12
  "  return openai.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc', messages: [{ role: 'user', content: prompt }] });", // 13 surface_capped
  '}', //                                                                              14
  '', //                                                                               15
  'export async function picture(prompt: string) {', //                                16
  "  return openai.images.generate({ model: 'dall-e-3', prompt });", //                17 replacement_unverified
  '}', //                                                                              18
  '', //                                                                               19
  'type ChatModel = string;', //                                                       20
  'export async function cast(prompt: string) {', //                                   21
  "  return openai.chat.completions.create({ model: 'gpt-4-0613' as ChatModel, messages: [{ role: 'user', content: prompt }] });", // 22 type_cast_masked
  '}', //                                                                              23
  '', //                                                                               24
  "export const DEFAULTS = { model: 'gpt-4-0613' };", //                               25 usage_unverified
  '',
].join('\n');

const HELD_PY = [
  'from openai import OpenAI', //                                                      1
  '', //                                                                               2
  'client = OpenAI()', //                                                              3
  '', //                                                                               4
  'DEFAULT_MODEL = "gpt-4-0613"', //                                                   5 usage_unverified
  '', //                                                                               6
  '', //                                                                               7
  'def title(p):', //                                                                  8
  '    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)', // 9 param_behaviour_change
  '',
].join('\n');

const EXPECTED: [string, number, string][] = [
  ['app/llm.py', 5, 'usage_unverified'],
  ['app/llm.py', 9, 'param_behaviour_change'],
  ['src/held.ts', 13, 'surface_capped'],
  ['src/held.ts', 17, 'replacement_unverified'],
  ['src/held.ts', 22, 'type_cast_masked'],
  ['src/held.ts', 25, 'usage_unverified'],
  ['src/held.ts', 6, 'coupled_param_unverified'],
];
const sorted = (rows: [string, number, string][]) => [...rows].sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));

describe('a repository whose only findings are held calls', () => {
  it('gets the same held calls, with the same reason codes, from audit, fix-llm and migrate', async () => {
    const dir = repo({ 'src/held.ts': HELD_TS, 'app/llm.py': HELD_PY });

    const fix = JSON.parse((await run('fix-llm', [dir, '--skip-gates', '--json'])).stdout) as {
      tierA: unknown[];
      tierB: { file: string; line: number; modelId: string; reason: string }[];
    };
    const migrate = JSON.parse((await run('migrate', [dir, '--skip-verify', '--json'])).stdout) as {
      migrated: boolean;
      verification: { verdict: string };
      skipped: { file: string; line: number; model: string; code: string; reason: string }[];
    };
    const audit = JSON.parse((await run('audit', [dir, '--offline', '--json'])).stdout) as {
      investigations: { locations: { selectors: { file: string; line: number; tier: string; reason: string | null }[] } }[];
    };

    const fromFix = fix.tierB.map((b): [string, number, string] => [b.file, b.line, b.reason]);
    const fromMigrate = migrate.skipped.map((s): [string, number, string] => [s.file, s.line, s.code]);
    const fromAudit = audit.investigations
      .flatMap((i) => i.locations.selectors)
      .filter((l) => l.tier === 'B')
      .map((l): [string, number, string] => [l.file, l.line, l.reason ?? '']);

    expect(sorted(fromFix)).toEqual(sorted(EXPECTED));
    expect(sorted(fromMigrate)).toEqual(sorted(EXPECTED));
    expect(sorted(fromAudit)).toEqual(sorted(EXPECTED));
    // fix-llm and migrate both print the id as written (a fine-tune included).
    expect(migrate.skipped.map((s) => `${s.file}:${s.line} ${s.model}`).sort()).toEqual(fix.tierB.map((b) => `${b.file}:${b.line} ${b.modelId}`).sort());

    // Nothing was a swap, so nothing migrated, and the run is not the clean outcome.
    expect(fix.tierA).toEqual([]);
    expect(migrate.migrated).toBe(false);
    expect(migrate.verification.verdict).toBe('held_for_review');
  }, 240_000);

  it('prints HELD FOR REVIEW and each held call, never NO MIGRATION', async () => {
    const dir = repo({ 'src/held.ts': HELD_TS, 'app/llm.py': HELD_PY });
    const { exitCode, stdout } = await run('migrate', [dir, '--skip-verify']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('HELD FOR REVIEW — nothing was migrated, and this repository is not clean: every retiring model id found needs a person (listed below).');
    expect(stdout).toContain('Nothing could be migrated automatically: 7 places in the code use a retiring model id that Mendr held for a person to review');
    expect(stdout).toContain('Held for review (7)');
    expect(stdout).toContain('  src/held.ts:6  claude-opus-4-1-20250805 (replacement on record: claude-opus-4-8)  [coupled_param_unverified]');
    expect(stdout).toContain('  app/llm.py:9  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]');
    // The fine-tune's own sentence: why it is never swapped.
    expect(stdout).toContain("would drop the customer's training");
    expect(stdout).not.toContain('NO MIGRATION');
  }, 120_000);
});
