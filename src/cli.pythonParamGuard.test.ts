import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// THE PYTHON PARAMETER GUARD, END TO END: audit, watch and fix-llm say the same thing about one call.
//
// v0.5.9-alpha's known issue: a Python call passing a parameter the replacement's rules change or
// do not cover was a Tier A swap, with the parameter kept. The guard lives in the scanner and the
// three commands read it through classifyOccurrenceTier; this suite pins that they agree, line by
// line, on the bundled registry. Hermetic: temp-dir fixture, `fix-llm --skip-gates`,
// `audit --offline`, `watch --no-exposure-file`, all run from source through tsx.

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
  const dir = mkdtempSync(join(tmpdir(), 'mendr-py-param-guard-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'py-param-guard' }, null, 2));
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

/** Three calls: two the guard holds, one it leaves as a Tier A swap. */
const LLM_PY = [
  'from openai import OpenAI', //                                                    1
  'from anthropic import Anthropic', //                                              2
  '', //                                                                             3
  'client = OpenAI()', //                                                            4
  'anthropic_client = Anthropic()', //                                               5
  '', //                                                                             6
  'def title(p):', //                                                                7
  '    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)', // 8
  '', //                                                                             9
  'def ask(m):', //                                                                  10
  '    params = {"temperature": 0.7}', //                                            11
  '    return anthropic_client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, messages=m, **params)', // 12
  '', //                                                                             13
  'def summarize(m):', //                                                            14
  '    return anthropic_client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=1024, temperature=0.7, messages=m)', // 15
  '',
].join('\n');

/**
 * A review finding on the guard: `self.model` was held by the call on `self.judge.model` (line 13),
 * which never takes it, and the sentence named that call. v0.5.9-alpha swapped it as Tier A, and
 * so must this guard: neither call that takes `self.model` passes a parameter it holds for.
 */
const BOT_PY = [
  'from openai import OpenAI', //                                                    1
  'client = OpenAI()', //                                                            2
  '', //                                                                             3
  'class Bot:', //                                                                   4
  '    def __init__(self, judge):', //                                               5
  '        self.model = "gpt-3.5-turbo"', //                                         6
  '        self.judge = judge', //                                                   7
  '', //                                                                             8
  '    def run(self, p):', //                                                        9
  '        return client.chat.completions.create(model=self.model, messages=p)', //  10
  '', //                                                                             11
  '    def grade(self, p):', //                                                      12
  '        return client.chat.completions.create(model=self.judge.model, messages=p, temperature=0)', // 13
  '',
].join('\n');

describe('a Python call the parameter guard holds', () => {
  it('gets the same tier and reason code from fix-llm, audit and watch, and is not swapped', async () => {
    const dir = repo({ 'app/llm.py': LLM_PY, 'app/bot.py': BOT_PY });

    const fix = JSON.parse((await run('fix-llm', [dir, '--skip-gates', '--json'])).stdout) as {
      tierA: { file: string; from: string; to: string }[];
      tierB: { file: string; line: number; modelId: string; reason: string }[];
    };
    expect(fix.tierB.map((f) => [f.file, f.line, f.modelId, f.reason])).toEqual(
      expect.arrayContaining([
        ['app/llm.py', 8, 'gpt-3.5-turbo', 'param_behaviour_change'],
        ['app/llm.py', 12, 'claude-opus-4-1-20250805', 'coupled_param_unverified'],
      ]),
    );
    expect(fix.tierB).toHaveLength(2);
    // The Sonnet call is swapped: claude-sonnet-4-6 is in no rule's family. So is self.model in
    // bot.py: the temperature=0 call on line 13 reads self.judge.model, not this value.
    expect(fix.tierA.map((a) => [a.file, a.from, a.to])).toEqual(
      expect.arrayContaining([
        ['app/llm.py', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'],
        ['app/bot.py', 'gpt-3.5-turbo', 'gpt-5.6-terra'],
      ]),
    );
    expect(fix.tierA).toHaveLength(2);

    const audit = JSON.parse((await run('audit', [dir, '--offline', '--json'])).stdout) as {
      investigations: { locations: { selectors: { file: string; line: number; tier: string; reason: string | null }[] } }[];
    };
    const at = (line: number, file = 'app/llm.py') =>
      audit.investigations.flatMap((i) => i.locations.selectors).find((l) => l.file === file && l.line === line);
    expect(at(8)).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    expect(at(12)).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(at(15)).toMatchObject({ tier: 'A' });
    expect(at(6, 'app/bot.py')).toMatchObject({ tier: 'A' });

    const watch = JSON.parse((await run('watch', [dir, '--no-exposure-file', '--json'])).stdout) as {
      models: { id: string; locations: { file: string; line: number; tier: string; reason?: string }[] }[];
    };
    const loc = (id: string, file = 'app/llm.py') => watch.models.find((m) => m.id === id)?.locations.find((l) => l.file === file);
    expect(loc('gpt-3.5-turbo')).toMatchObject({ line: 8, tier: 'B', reason: 'param_behaviour_change' });
    expect(loc('claude-opus-4-1-20250805')).toMatchObject({ line: 12, tier: 'B', reason: 'coupled_param_unverified' });
    expect(loc('claude-3-5-sonnet-20241022')).toMatchObject({ line: 15, tier: 'A' });
    expect(loc('gpt-3.5-turbo', 'app/bot.py')).toMatchObject({ line: 6, tier: 'A' });

    // The human report prints the guard's own sentence under the held call, and never names the
    // self.judge.model call as one that takes bot.py's value.
    const human = await run('fix-llm', [dir, '--skip-gates']);
    expect(human.stdout).toContain('`max_tokens` becomes `max_completion_tokens`');
    expect(human.stdout).not.toContain('the call on line 13 of this file');
  }, 240_000);
});
