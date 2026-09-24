import { describe, it, expect } from 'vitest';
import {
  describeGateBlock,
  gateBlocks,
  resolveGatePolicy,
  type GateEvaluation,
  type ResolvedGatePolicy,
} from './policy.js';

// The gate policy is where "we could not check this" stops being a shrug and
// becomes a decision the repo owner made. Two properties are load-bearing and
// every test below defends one of them:
//   1. DEFAULTS REPRODUCE THE OLD BEHAVIOR EXACTLY (typecheck required, tests
//      not, eval required the moment a command exists);
//   2. an inconclusive gate is never treated as a pass -- `required` decides
//      whether it BLOCKS, never what it is CALLED.
//
// The outcome words below are CheckStatus from ./status.ts, the single
// verification vocabulary: passed | failed | skipped | not_run | inconclusive.
// This file used to spell them `pass` / `fail` / `not-applicable` /
// `not-configured`; only the spellings changed here, not which outcomes block.

describe('resolveGatePolicy (defaults, and what a repo may override)', () => {
  it('reproduces the pre-policy behavior when nothing is configured', () => {
    expect(resolveGatePolicy({})).toEqual({
      typecheck: { required: true },
      tests: { required: false },
      // No command: nothing to require. `required` is false so an unconfigured
      // repo is never blocked by a gate it was never asked to set up.
      eval: { required: false },
    });
  });

  it('requires the eval gate as soon as a command exists (the fail-closed rule)', () => {
    expect(resolveGatePolicy({ evalCommand: 'npm run eval' }).eval).toEqual({
      required: true,
      command: 'npm run eval',
    });
    expect(resolveGatePolicy({ gates: { eval: { command: 'make eval' } } }).eval).toEqual({
      required: true,
      command: 'make eval',
    });
  });

  it('maps the legacy top-level evalCommand onto gates.eval.command', () => {
    // The legacy spelling must keep working forever: CI jobs in the wild set it.
    const policy = resolveGatePolicy({ evalCommand: 'pytest evals/ -q' });
    expect(policy.eval.command).toBe('pytest evals/ -q');
  });

  it('lets --eval-command beat the file (the later, more specific instruction)', () => {
    const policy = resolveGatePolicy({ evalCommand: 'npm run eval' }, 'node one-off.js');
    expect(policy.eval.command).toBe('node one-off.js');
    expect(policy.eval.required).toBe(true);
  });

  it('honors an explicit required flag, including one that cannot pass yet', () => {
    expect(resolveGatePolicy({ gates: { tests: { required: true } } }).tests.required).toBe(true);
    expect(resolveGatePolicy({ gates: { typecheck: { required: false } } }).typecheck.required).toBe(
      false,
    );
    // A repo may demand that EVERY model migration carry an eval. With no
    // command that demand is unmet, and the honest response is to block the
    // fix -- not to quietly drop the requirement.
    expect(resolveGatePolicy({ gates: { eval: { required: true } } }).eval).toEqual({
      required: true,
    });
  });

  it('turns the eval gate advisory when the repo says so', () => {
    const policy = resolveGatePolicy({
      gates: { eval: { command: 'npm run eval', required: false } },
    });
    expect(policy.eval).toEqual({ required: false, command: 'npm run eval' });
  });
});

describe('gateBlocks (what stops a fix from being Tier A)', () => {
  const DEFAULTS = resolveGatePolicy({});
  const strict: ResolvedGatePolicy = resolveGatePolicy({
    gates: { tests: { required: true } },
  });

  const evaluation = (over: Partial<GateEvaluation>): GateEvaluation => ({
    gate: 'tests',
    outcome: 'passed',
    ...over,
  });

  it('never blocks on passed, and never blocks on a gate that does not apply', () => {
    expect(gateBlocks(DEFAULTS, [evaluation({ outcome: 'passed' })])).toEqual([]);
    // What used to be spelled `not-applicable` is now `skipped`: the one
    // vocabulary folds "this gate does not exist for this language" together
    // with "we chose not to run it", because the policy owes them the same
    // answer. Neither is a weaker pass, and requiring either cannot make it
    // run, so neither may block. ("n/a" survives only on registry attribution
    // rows, for a record that does not exist -- never for a check.)
    expect(gateBlocks(strict, [evaluation({ outcome: 'skipped' })])).toEqual([]);
  });

  it('blocks on a hard FAILED whether or not the gate was required', () => {
    const [block] = gateBlocks(DEFAULTS, [evaluation({ outcome: 'failed', detail: '1 failed' })]);
    // The default policy does NOT require tests, and a suite that ran and
    // failed still blocks: no policy may wave through a negative result.
    expect(block).toEqual({ gate: 'tests', outcome: 'failed', required: false, detail: '1 failed' });
  });

  it('blocks an INCONCLUSIVE gate only where the repo required it', () => {
    const inconclusive = evaluation({ outcome: 'inconclusive', detail: 'no node_modules' });
    expect(gateBlocks(DEFAULTS, [inconclusive])).toEqual([]);
    expect(gateBlocks(strict, [inconclusive])).toEqual([
      { gate: 'tests', outcome: 'inconclusive', required: true, detail: 'no node_modules' },
    ]);
  });

  it('treats "nothing to run" (not_run) as a block for a required gate too', () => {
    // `not-configured` is now `not_run`, and it still means "there was nothing
    // to run" -- distinct from `inconclusive`, which means we tried and cannot
    // say. A required gate with no test script is not satisfied either way.
    // Reporting it as met because there was nothing to run is how "required"
    // becomes decorative.
    expect(gateBlocks(strict, [evaluation({ outcome: 'not_run' })])).toHaveLength(1);
    expect(gateBlocks(DEFAULTS, [evaluation({ outcome: 'not_run' })])).toEqual([]);
  });

  it('blocks a blind type-check by default, because typecheck is required', () => {
    // The consequence, at the policy layer, of a type-check that ran without
    // node_modules now reporting `inconclusive` instead of `passed`: typecheck
    // is required by DEFAULT, so a dependency-less checkout no longer yields
    // Tier A off a check that could not have failed. This blocking is intended.
    expect(
      gateBlocks(DEFAULTS, [
        { gate: 'typecheck', outcome: 'inconclusive', detail: 'unresolved: @anthropic-ai/sdk' },
      ]),
    ).toEqual([
      {
        gate: 'typecheck',
        outcome: 'inconclusive',
        required: true,
        detail: 'unresolved: @anthropic-ai/sdk',
      },
    ]);
  });

  it('keeps gate order, so the report names the first blocker that ran', () => {
    const blocks = gateBlocks(strict, [
      evaluation({ gate: 'typecheck', outcome: 'failed' }),
      evaluation({ gate: 'tests', outcome: 'inconclusive' }),
    ]);
    expect(blocks.map((b) => b.gate)).toEqual(['typecheck', 'tests']);
  });
});

describe('describeGateBlock (naming which gate did not pass)', () => {
  it('names the gate, the outcome, and the switch that would allow it', () => {
    const text = describeGateBlock({
      gate: 'tests',
      outcome: 'inconclusive',
      required: true,
      detail: 'repo has no installed node_modules to link -- cannot run tests',
    });
    expect(text).toContain('required gate "tests" did not pass');
    expect(text).toContain('could not run');
    expect(text).toContain('no installed node_modules');
    expect(text).toContain('"gates.tests": { "required": false }');
    // It must never read as a result: nothing ran, so nothing passed OR failed.
    expect(text).not.toMatch(/\bpassed\b|\bfailed\b/);
  });

  it('says "had nothing to run" for not_run, and keeps it distinct from inconclusive', () => {
    // `not-configured` is now `not_run`, and the sentence moved with the word:
    // "is not configured" named a missing SETTING, while not_run names a
    // missing THING TO RUN. The clause must stay different from the
    // `inconclusive` one above ("could not run"), because the two send the
    // reader to different places -- write an eval command, versus find out why
    // the one you have could not be run.
    const text = describeGateBlock({ gate: 'eval', outcome: 'not_run', required: true });
    expect(text).toContain('required gate "eval" did not pass');
    expect(text).toContain('the behavioral evaluation gate had nothing to run');
    expect(text).not.toContain('could not run');
  });

  it('keeps the eval gate\'s own sentence on a hard failure', () => {
    // What failed is the command the USER wrote; naming it (and its exit code)
    // is what sends them to the right place.
    expect(
      describeGateBlock({
        gate: 'eval',
        outcome: 'failed',
        required: true,
        detail: 'npm run eval, exit 1',
      }),
    ).toBe('your eval command failed against the patched code (npm run eval, exit 1)');
  });

  it('describes a code-gate failure as a gate failure', () => {
    expect(
      describeGateBlock({
        gate: 'typecheck',
        outcome: 'failed',
        required: true,
        detail: '2 new type errors',
      }),
    ).toBe('the type-check gate failed against the patched code: 2 new type errors');
  });
});
