import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// THE RUN FOOTER, END TO END.
//
//   mode: LOOK
//   unique occurrences: 4
//   files modified: 0
//
// Three facts the report used to make a reader assemble for themselves. `mode`
// is intent and `files modified` is outcome, and they are two lines precisely
// so a refused write can say `WRITE` and `0` at the same time. The middle line
// is only worth printing if it RECONCILES with the tier counts above it, so the
// identity `unique occurrences == tierA + tierB + tierC` is asserted here
// against what the CLI actually prints, not against a unit fixture.

const MENDR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
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

function repoDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'footer-fixture' }, null, 2));
  mkdirSync(join(dir, 'src'));
  return dir;
}

/** One verified Tier A swap in one file. */
function makeTierARepo(): { dir: string; file: string } {
  const dir = repoDir('mendr-footer-a-');
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
  return { dir, file };
}

/**
 * Every tier at once, PLUS a param transform — the one class of Tier A site
 * that is deliberately absent from the occurrence list (its key would be a
 * param name in the model-id key space), and therefore the one that could make
 * the printed count irreconcilable with the tier counts.
 */
function makeMixedRepo(): string {
  const dir = repoDir('mendr-footer-mixed-');
  writeFileSync(
    join(dir, 'src', 'chat.ts'),
    [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export async function chat() {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      'export async function reason() {',
      "  return client.chat.completions.create({ model: 'o3', max_tokens: 10 });",
      '}',
      // Tier B (a deployment key IN A CALL) and Tier C (a data literal), so all
      // three tiers and the param sites are in one count.
      'export async function azure() {',
      "  return client.getChatCompletions({ deployment: 'gpt-4-32k', messages: [] });",
      '}',
      'export const table = { legacy: "gpt-4-0314" };',
      '',
    ].join('\n'),
  );
  return dir;
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

/** The three tier numbers the `Found:` block printed. */
function foundCounts(stdout: string): { tierA: number; tierB: number; tierC: number } {
  const m = stdout.match(/Found: (\d+) tier A[\s\S]*?(\d+) tier B[\s\S]*?(\d+) tier C/);
  expect(m, 'the Found block must print all three tiers').toBeTruthy();
  return { tierA: Number(m![1]), tierB: Number(m![2]), tierC: Number(m![3]) };
}

/** The number on the `unique occurrences:` line. */
function printedOccurrences(stdout: string): number {
  const m = stdout.match(/^unique occurrences: (\d+)/m);
  expect(m, 'the footer must print a unique-occurrence count').toBeTruthy();
  return Number(m![1]);
}

describe('the run footer', () => {
  it(
    'says LOOK and zero files modified on a run without --write',
    async () => {
      const { dir, file } = makeTierARepo();
      const before = readFileSync(file, 'utf8');
      const { stdout } = await runFixLlm([dir]);

      expect(stdout).toContain('mode: LOOK');
      expect(stdout).toContain('files modified: 0');
      // The claim is checkable: the file really is untouched.
      expect(readFileSync(file, 'utf8')).toBe(before);
      // ...and the run block sits ABOVE the registry block, so the footer reads
      // run-facts first, then provenance.
      expect(stdout.indexOf('mode: LOOK')).toBeLessThan(stdout.indexOf('registry: '));
    },
    120_000,
  );

  it(
    'says WRITE and counts the files it actually wrote',
    async () => {
      const { dir, file } = makeTierARepo();
      const { exitCode, stdout } = await runFixLlm([dir, '--write']);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('mode: WRITE');
      expect(stdout).toContain('files modified: 1');
      expect(readFileSync(file, 'utf8')).toContain('gpt-5.6-sol');
    },
    120_000,
  );

  // THE CASE THE TWO LINES EXIST FOR. `--write` was passed, so the mode is
  // WRITE; the write was refused, so the count is 0. Neither line is bent to
  // cover for the other, and the refusal message still explains why.
  it(
    'still says WRITE over a refused write, and reports zero files modified',
    async () => {
      const { dir, file } = makeTierARepo();
      chmodSync(file, 0o444);
      const { exitCode, stdout, stderr } = await runFixLlm([dir, '--write']);

      expect(stdout).toContain('mode: WRITE');
      expect(stdout).toContain('files modified: 0');
      expect(stdout).not.toContain('files modified: 1');
      expect(stderr).toContain('--write aborted');
      expect(exitCode).toBe(1);
      expect(readFileSync(file, 'utf8')).toContain('gpt-4-0613');
    },
    120_000,
  );

  // `--write --skip-gates` writes nothing by design. The mode still reports
  // what was asked for; the outcome line reports what happened.
  it(
    'reports the intent even when the flags make a write impossible',
    async () => {
      const { dir, file } = makeTierARepo();
      const { stdout } = await runFixLlm([dir, '--write', '--skip-gates']);
      expect(stdout).toContain('mode: WRITE');
      expect(stdout).toContain('files modified: 0');
      expect(readFileSync(file, 'utf8')).toContain('gpt-4-0613');
    },
    120_000,
  );

  // THE IDENTITY, against a real scan: the printed occurrence count equals the
  // three printed tier counts, on a repo that has all three tiers AND a param
  // transform (the sites that sit outside the model-id key space).
  it(
    'prints an occurrence count that equals tier A + tier B + tier C',
    async () => {
      const dir = makeMixedRepo();
      const { stdout } = await runFixLlm([dir, '--skip-gates']);
      const counts = foundCounts(stdout);
      expect(counts.tierA).toBeGreaterThan(0);
      expect(counts.tierB).toBeGreaterThan(0);
      expect(printedOccurrences(stdout)).toBe(counts.tierA + counts.tierB + counts.tierC);
      // The param transform is named rather than silently folded in, so the
      // total can be decomposed by the reader who wants to check it.
      expect(stdout).toContain('unique occurrences: 4 (3 model-id + 1 param transform)');
      // And the count never prints as a number nobody can check.
      expect(stdout).not.toContain('does NOT reconcile');
    },
    120_000,
  );

  it(
    'holds the same identity on a repo where nothing is auto-fixable',
    async () => {
      const dir = repoDir('mendr-footer-data-');
      writeFileSync(
        join(dir, 'src', 'chat.ts'),
        ['export const catalog = { a: "gpt-4-0314", b: "gpt-4-32k" };', ''].join('\n'),
      );
      const { stdout } = await runFixLlm([dir]);
      const counts = foundCounts(stdout);
      expect(printedOccurrences(stdout)).toBe(counts.tierA + counts.tierB + counts.tierC);
    },
    120_000,
  );

  it(
    'carries the same three facts in --json',
    async () => {
      const { dir, file } = makeTierARepo();
      const { stdout } = await runFixLlm([dir, '--write', '--json']);
      const report = JSON.parse(stdout) as {
        summary: {
          tierA: number;
          tierB: number;
          tierC: number;
          mode: string;
          uniqueOccurrences: number;
          filesModified: number;
        };
        write: { filesWritten: number };
      };

      expect(report.summary.mode).toBe('WRITE');
      expect(report.summary.filesModified).toBe(1);
      // `filesModified` is the write RESULT, not a second tally of it.
      expect(report.summary.filesModified).toBe(report.write.filesWritten);
      expect(report.summary.uniqueOccurrences).toBe(
        report.summary.tierA + report.summary.tierB + report.summary.tierC,
      );
      expect(readFileSync(file, 'utf8')).toContain('gpt-5.6-sol');
    },
    120_000,
  );

  it(
    'reports LOOK and zero in --json for a read-only run',
    async () => {
      const dir = makeMixedRepo();
      const { stdout } = await runFixLlm([dir, '--skip-gates', '--json']);
      const report = JSON.parse(stdout) as {
        summary: { mode: string; filesModified: number; uniqueOccurrences: number };
      };
      expect(report.summary.mode).toBe('LOOK');
      expect(report.summary.filesModified).toBe(0);
      expect(report.summary.uniqueOccurrences).toBeGreaterThan(0);
    },
    120_000,
  );

  // ONE REPORT MUST NOT CONTRADICT ITSELF. The Tier A block renders BEFORE the
  // write is attempted, so it used to print `will apply with --write` on a run
  // where --write had ALREADY been passed and refused -- three lines above
  // `write refused, working tree unchanged` and `files modified: 0`.
  it(
    'never promises a future --write in a report that already refused one',
    async () => {
      const { dir, file } = makeTierARepo();
      chmodSync(file, 0o444);
      const { stdout } = await runFixLlm([dir, '--write']);

      expect(stdout).toContain('mode: WRITE');
      expect(stdout).toContain('files modified: 0');
      expect(stdout).toContain('write refused');
      // The contradiction, gone.
      expect(stdout).not.toContain('will apply with --write');
      // Flattened, because the row wraps at the same column every other row does.
      expect(stdout.replace(/\s+/g, ' ')).toContain(
        'classification: tier A -- auto-fixable; see Summary for whether it was applied',
      );
    },
    120_000,
  );

  // The same row, on the run that SUCCEEDED: still no future-tense promise,
  // because by the time a reader sees it the patch is already on disk.
  it(
    'points at the Summary rather than predicting, on a successful --write',
    async () => {
      const { dir, file } = makeTierARepo();
      const { stdout } = await runFixLlm([dir, '--write']);

      expect(stdout).toContain('files modified: 1');
      expect(stdout).not.toContain('will apply with --write');
      expect(readFileSync(file, 'utf8')).toContain('gpt-5.6-sol');
    },
    120_000,
  );

  // ...and LOOK keeps it, because there the sentence is simply true.
  it(
    'keeps the forward statement on a LOOK run',
    async () => {
      const { dir } = makeTierARepo();
      const { stdout } = await runFixLlm([dir]);
      expect(stdout).toContain('mode: LOOK');
      expect(stdout).toContain('will apply with --write');
    },
    120_000,
  );

  // THE OVERCLAIM A SINGLE FILE CAN REFUTE: the same literal in a `model:`
  // argument and under a `deployment:` key. The first is auto-patched AS a
  // model id; the second used to be described as "not a model id" by the same
  // run, from the same registry record.
  it(
    'never denies a literal is a model id while patching that same literal',
    async () => {
      const dir = repoDir('mendr-footer-deploy-');
      writeFileSync(
        join(dir, 'src', 'chat.ts'),
        [
          'import OpenAI from "openai";',
          'const client = new OpenAI();',
          'export async function call() {',
          "  return client.chat.completions.create({ model: 'gpt-4-32k', messages: [] });",
          '}',
          'export async function azure() {',
          "  return client.getChatCompletions({ deployment: 'gpt-4-32k', messages: [] });",
          '}',
          '',
        ].join('\n'),
      );
      const { stdout } = await runFixLlm([dir, '--skip-gates']);

      // Both positions are reported in one run...
      expect(stdout).toContain('platform_blocked');
      // ...and the usage row names the KEY that was checked, not the value.
      expect(stdout).toContain('usage verdict:         unverified -- sits under a deployment key,');
      expect(stdout).not.toContain('not a model id');
      expect(stdout).not.toContain('platform alias,');
    },
    120_000,
  );

  it(
    'prints the run block on a clean repo too, where every number is zero',
    async () => {
      const dir = repoDir('mendr-footer-clean-');
      writeFileSync(join(dir, 'src', 'chat.ts'), 'export const x = 1;\n');
      const { stdout } = await runFixLlm([dir, '--json']);
      const report = JSON.parse(stdout) as {
        summary: { mode: string; uniqueOccurrences: number; filesModified: number };
      };
      expect(report.summary).toMatchObject({
        mode: 'LOOK',
        uniqueOccurrences: 0,
        filesModified: 0,
      });
    },
    120_000,
  );
});
