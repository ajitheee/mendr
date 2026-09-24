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
//
// HOW DEFECT 2's FIX CHANGED THESE TESTS. It is no longer a detail string on a
// `passed` row. A type-check that ran BLIND is now `inconclusive` — the STATE
// carries it, because a detail is dropped downstream (the PR-body row
// suppressed it, the App discarded it) and a state cannot be. The typecheck
// gate is `required` by default, so `inconclusive` now BLOCKS Tier A on a
// checkout with no node_modules. That is the intended outcome: install
// dependencies and re-run to earn the pass.
//
// That interacts with defect 1, so the two are now asserted apart. The scope
// question ("is the located file in the gated project?") is asserted on a
// fixture whose policy does not require the typecheck gate, so a block about
// missing DEPENDENCIES cannot masquerade as a block about missing SCOPE. The
// dependency question gets its own tests below.

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
 *
 * @param typecheckRequired the target repo's `gates.typecheck.required`.
 *   `true` is mendr's default and is left unwritten. `false` is written as a
 *   real `mendr.config.json`, which is the only way to reach the Tier A
 *   surfaces at all on a checkout with no node_modules now that a blind
 *   type-check is `inconclusive`.
 */
function makeMonorepo(typecheckRequired = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-gated-scope-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'monorepo-fixture' }, null, 2));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'esnext', strict: true }, include: ['src'] }, null, 2),
  );
  if (!typecheckRequired) {
    writeFileSync(
      join(dir, 'mendr.config.json'),
      JSON.stringify({ gates: { typecheck: { required: false } } }, null, 2),
    );
  }

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

// One CLI run per POLICY, shared by the tests that read it. Each run is a real
// subprocess over a real project load; there are only two distinct runs here
// and re-spawning per assertion-group bought nothing.
const runs = new Map<boolean, Promise<string>>();
function gatedRun(typecheckRequired: boolean): Promise<string> {
  let run = runs.get(typecheckRequired);
  if (!run) {
    run = runFixLlm(makeMonorepo(typecheckRequired));
    runs.set(typecheckRequired, run);
  }
  return run;
}

describe('the gated pass judges the file the locator actually found', () => {
  it('patches a finding outside the root tsconfig instead of blaming a gate', async () => {
    // `typecheck.required: false`, so the blind type-check reports
    // `inconclusive` without blocking. Every remaining gate is satisfied, which
    // makes this the clean test of defect 1: if the disposition is a gate
    // failure here, it is the phantom gate failure, not a dependency one.
    const out = await gatedRun(false);

    // The patch exists: the located file was unioned into the gated project.
    // These two are the mechanical proof, and the regression guard — if the
    // union broke, the located file would not be in the project, the codemod
    // would change nothing, and there would be no diff to find.
    expect(out).toContain('server/src/interpreter.ts');
    expect(out).toContain("-  return client.chat.completions.create({ model: 'gpt-4-0613'");

    // And the disposition says what happened. "downgraded -- gates failed" is
    // the exact sentence this test exists to keep out of a run where no gate
    // objected.
    expect(out).toContain('ready to apply');
    expect(out).not.toContain('downgraded -- gates failed');
  }, 120_000);

  it('reports a type-check that ran blind as inconclusive, never as passed', async () => {
    // `openai` is imported and not installed — the shallow-clone condition.
    //
    // BEHAVIOUR CHANGE. This asserted `type-check: passed` with the unresolved
    // packages named in the row's detail. The row now says `inconclusive`: the
    // check ran to completion and found no new errors because the SDK types
    // that would reject a bad model id were never loaded, so nothing could have
    // failed it. The check ran; the part of it that mattered did not, and only
    // a STATE survives the renderers that drop details.
    const out = await gatedRun(true);

    expect(out).toMatch(/type-check:\s+inconclusive/);
    expect(out).not.toMatch(/type-check:\s+passed/);

    // The packages are still named. Moving the fact into the state was meant to
    // make it undroppable, not to replace it with a bare word.
    expect(out).toContain('not installed in this checkout');
    expect(out).toContain('openai');
    expect(out).toContain('their types were not checked');
  }, 120_000);

  it('blocks Tier A on a dependency-less checkout, and names the gate and the reason', async () => {
    // BEHAVIOUR CHANGE, and the point of the one above. `typecheck` is
    // `required` by default, so `inconclusive` blocks: a shallow clone with no
    // node_modules does not earn a VERIFIED Tier A. Install dependencies and
    // re-run to earn it, or set `gates.typecheck.required: false` to accept the
    // risk (the test above this one does exactly that).
    const out = await gatedRun(true);

    expect(out).toContain('Tier A candidate -> NOT APPLIED (gates failed, review only)');
    expect(out).not.toContain('(VERIFIED)');

    // The reason defect 1 was a defect was not the downgrade — it was the
    // downgrade blaming a gate that had never run. A block is allowed to happen
    // here, so what this asserts instead is ATTRIBUTION: which gate, what it
    // returned, why, and how to change the policy.
    expect(out).toContain('required gate "typecheck" did not pass');
    expect(out).toContain('the type-check gate could not run');
    expect(out).toContain('1 package not installed in this checkout (openai)');
    expect(out).toContain('"gates.typecheck": { "required": false }');

    // `inconclusive` is not a rejection, and the block message must not read as
    // one: nothing objected to this patch.
    expect(out).not.toContain('the type-check gate failed against the patched code');
  }, 120_000);

  it('does not call a blind type-check "passes" in the one-line verdict', async () => {
    // SUSPECTED REGRESSION — LEFT FAILING DELIBERATELY. Do not "fix" this by
    // relaxing the assertion; it is asserting the rule the new vocabulary was
    // built to enforce (src/gates/status.ts: a check is never reported as
    // passed unless it actually ran).
    //
    // This is the assertion the old `type-check: passed` test ended with, and
    // its reason is unchanged: the one-line verdict is the part that gets
    // skimmed, quoted and pasted into a pull request, so it carries the same
    // limit as the gate row. It no longer does. On this path the gate row says
    //
    //     type-check:  inconclusive (ran without the types that would reject a
    //                  bad model id -- 1 package not installed ...)
    //
    // and thirty lines later the verdict says
    //
    //     Tier A: 1 model-id swap (...) (verified: type-check passes; 1 package
    //             unresolved -- their types were not checked)
    //
    // under a heading reading `(VERIFIED)`. The caveat survived; the word
    // "passes" survived with it, and the two disagree. The verdict line and the
    // heading are still derived from `tsTier === 'A'` rather than from the
    // typecheck gate's state, so V1-V5 corrected the row and left the sentence
    // that quotes the row claiming a pass for an `inconclusive` check.
    //
    // Reachable whenever a repo sets `gates.typecheck.required: false`, which
    // is the setting mendr's own block message recommends. The fix belongs in
    // src/cli.ts, not here.
    const out = await gatedRun(false);

    expect(out).toMatch(/type-check:\s+inconclusive/);
    expect(out).not.toMatch(/verified: type-check passes/);
  }, 120_000);
});
