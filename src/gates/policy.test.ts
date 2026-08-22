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
    outcome: 'pass',
    ...over,
  });

  it('never blocks on pass, and never blocks on a gate that does not apply', () => {
    expect(gateBlocks(DEFAULTS, [evaluation({ outcome: 'pass' })])).toEqual([]);
    // n/a is not a weaker pass -- it is "this gate does not exist for this
    // language", so requiring it cannot make it run and must not block.
    expect(gateBlocks(strict, [evaluation({ outcome: 'not-applicable' })])).toEqual([]);
  });

  it('blocks on a hard FAIL whether or not the gate was required', () => {
    const [block] = gateBlocks(DEFAULTS, [evaluation({ outcome: 'fail', detail: '1 failed' })]);
    // The default policy does NOT require tests, and a suite that ran and
    // failed still blocks: no policy may wave through a negative result.
    expect(block).toEqual({ gate: 'tests', outcome: 'fail', required: false, detail: '1 failed' });
  });

  it('blocks an INCONCLUSIVE gate only where the repo required it', () => {
    const inconclusive = evaluation({ outcome: 'inconclusive', detail: 'no node_modules' });
    expect(gateBlocks(DEFAULTS, [inconclusive])).toEqual([]);
    expect(gateBlocks(strict, [inconclusive])).toEqual([
      { gate: 'tests', outcome: 'inconclusive', required: true, detail: 'no node_modules' },
    ]);
  });

  it('treats "nothing to run" as a block for a required gate too', () => {
    // A required gate with no test script is not satisfied. Reporting it as
    // met because there was nothing to run is how "required" becomes decorative.
    expect(gateBlocks(strict, [evaluation({ outcome: 'not-configured' })])).toHaveLength(1);
    expect(gateBlocks(DEFAULTS, [evaluation({ outcome: 'not-configured' })])).toEqual([]);
  });

  it('keeps gate order, so the report names the first blocker that ran', () => {
    const blocks = gateBlocks(strict, [
      evaluation({ gate: 'typecheck', outcome: 'fail' }),
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

  it('says "is not configured" when there was nothing to run', () => {
    const text = describeGateBlock({ gate: 'eval', outcome: 'not-configured', required: true });
    expect(text).toContain('required gate "eval" did not pass');
    expect(text).toContain('the behavioral evaluation gate is not configured');
  });

  it('keeps the eval gate\'s own sentence on a hard failure', () => {
    // What failed is the command the USER wrote; naming it (and its exit code)
    // is what sends them to the right place.
    expect(
      describeGateBlock({
        gate: 'eval',
        outcome: 'fail',
        required: true,
        detail: 'npm run eval, exit 1',
      }),
    ).toBe('your eval command failed against the patched code (npm run eval, exit 1)');
  });

  it('describes a code-gate failure as a gate failure', () => {
    expect(
      describeGateBlock({
        gate: 'typecheck',
        outcome: 'fail',
        required: true,
        detail: '2 new type errors',
      }),
    ).toBe('the type-check gate failed against the patched code: 2 new type errors');
  });
});
