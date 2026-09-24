import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// The GATED path's view of the repository, end to end.
//
// Two defects found by running the shipped build against real repositories,
// both of which made mendr describe work it had not done:
//
//   1. The gated pass re-loads the repo through its own tsconfig, and a
//      monorepo root config routinely compiles ONE package of several.
//      getmaxun/maxun declares `include: ["src"]`, its retiring model id lives
//      in `server/`, and the gated project therefore held no such file. The
//      codemod changed nothing, and the summary's residual bucket announced
//      `1 downgraded -- gates failed` — naming a gate that had never run. The
//      one confirmed auto-fixable finding mendr had on a real repository was
//      reported as a gate failure.
//
//   2. `fix-llm <url>` shallow-clones without installing dependencies, so the
//      SDK whose types would reject a bad model id is unresolved and the
//      argument is `any`. The gate passed because nothing could fail it, and
//      printed a bare "passed" — which reads as "the SDK accepts this id".
//
// Both fixtures are the real shapes, minimised.

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

/**
 * The maxun shape: a root tsconfig that compiles only the frontend, and the
 * retiring id sitting in a sibling package the config never mentions.
 */
function makeMonorepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-gated-scope-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'monorepo-fixture' }, null, 2));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'esnext', strict: true }, include: ['src'] }, null, 2),
  );

  // The half the tsconfig DOES compile, so the project loads and the fallback
  // glob loader never kicks in — that is what makes the omission silent.
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const APP = "frontend";\n');

  // The half it does not: a live, swap-safe model argument.
  mkdirSync(join(dir, 'server', 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'server', 'src', 'interpreter.ts'),
    [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export async function interpret() {',
      "  return client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });",
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

async function runFixLlm(dir: string): Promise<string> {
  const { stdout, stderr } = await execa(
    'npx',
    ['tsx', join(MENDR_ROOT, 'src', 'cli.ts'), 'fix-llm', dir],
    { cwd: MENDR_ROOT, reject: false },
  );
  return `${stdout}\n${stderr}`;
}

describe('the gated pass judges the file the locator actually found', () => {
  it('patches a finding outside the root tsconfig instead of blaming a gate', async () => {
    const out = await runFixLlm(makeMonorepo());

    // The patch exists: the located file was unioned into the gated project.
    expect(out).toContain('server/src/interpreter.ts');
    expect(out).toContain("-  return client.chat.completions.create({ model: 'gpt-4-0613'");

    // And the disposition says what happened. "downgraded -- gates failed" is
    // the exact sentence this test exists to keep out of a run where every
    // gate passed.
    expect(out).toContain('ready to apply');
    expect(out).not.toContain('downgraded -- gates failed');
  }, 120_000);

  it('names the packages the type-check could not see instead of a bare pass', async () => {
    // `openai` is imported and not installed — the shallow-clone condition.
    const out = await runFixLlm(makeMonorepo());

    expect(out).toMatch(/type-check:\s+passed/);
    expect(out).toContain('not installed in this checkout');
    expect(out).toContain('openai');
    expect(out).toContain('their types were not checked');

    // The one-line verdict is the part that gets skimmed, quoted and pasted
    // into a pull request, so it carries the same limit as the gate row.
    expect(out).toMatch(
      /\(verified: type-check passes[^)]*1 package unresolved -- their types were not checked\)/,
    );
  }, 120_000);
});
