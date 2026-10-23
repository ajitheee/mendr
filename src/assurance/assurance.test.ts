import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../config/repoConfig.js';
import { linkWorkflows, matchPath } from './workflows.js';
import { recoveryPlan } from './recovery.js';
import { judgeRollout, parseRolloutInput, renderRollout, type RolloutInput } from './rollout.js';
import { appendOutcome, outcomeRecord } from './outcome.js';

// The assurance half of a migration: which feature it touches, what to do if it goes wrong, and
// whether the feature stayed healthy after the deploy. Every verdict here is computed from data
// the team supplied; nothing is inferred, and "not measured" never reads as "fine".

const SUPPORT: WorkflowConfig = { name: 'Answer a support question', paths: ['src/support/**', 'src/ai.ts'] };

describe('matchPath', () => {
  it.each([
    ['src/support/**', 'src/support/reply.ts', true],
    ['src/support/**', 'src/support/deep/x.ts', true],
    ['src/support/**', 'src/supporting.ts', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/ai.ts', 'src/ai.ts', true],
    ['src/ai.ts', 'src/ai.tsx', false],
    ['src/support', 'src/support/reply.ts', true],
    ['./src/ai.ts', 'src\\ai.ts', true],
  ])('%s matches %s: %s', (pattern, path, expected) => {
    expect(matchPath(pattern, path)).toBe(expected);
  });
});

describe('linkWorkflows', () => {
  it('joins each changed file to the features that own it, and names the ones nobody owns', () => {
    const links = linkWorkflows([SUPPORT, { name: 'Summarise a ticket', paths: ['src/tickets/**'] }], ['src/ai.ts', 'scripts/backfill.ts']);
    expect(links.affected).toEqual([{ name: 'Answer a support question', files: ['src/ai.ts'] }]);
    expect(links.unlinked).toEqual(['scripts/backfill.ts']);
  });
});

describe('recoveryPlan', () => {
  const swap = { from: 'gpt-4-0613', to: 'gpt-5.6-sol', shutdownDate: '2026-10-23' };

  it('offers a revert before the shutdown date, and says when it stops working', () => {
    const plan = recoveryPlan([swap], new Date('2026-10-15T12:00:00Z'));
    expect(plan.asOf).toBe('2026-10-15');
    expect(plan.options[0]).toMatchObject({ kind: 'revert', available: true });
    expect(plan.options[0]!.detail).toContain('until 2026-10-23');
  });

  it('refuses a revert justified only by the schedule on and after the announced date', () => {
    for (const day of ['2026-10-23T08:00:00Z', '2026-11-02T08:00:00Z']) {
      const revert = recoveryPlan([swap], new Date(day)).options[0]!;
      expect(revert.available).toBe(false);
      expect(revert.detail).toContain('`gpt-4-0613` reached its announced retirement date 2026-10-23');
    }
  });

  it('dates the revert window by the earliest shutdown when several models move', () => {
    const plan = recoveryPlan([swap, { from: 'o3-mini', to: 'gpt-5.6-sol', shutdownDate: '2026-10-20' }], new Date('2026-10-15T00:00:00Z'));
    expect(plan.options[0]!.detail).toContain('until 2026-10-20');
  });

  it('never picks a substitute model, and says why', () => {
    const other = recoveryPlan([swap], new Date('2026-10-15T00:00:00Z')).options.find((o) => o.kind === 'other_model')!;
    expect(other.detail).toMatch(/your decision/);
  });
});

describe('parseRolloutInput', () => {
  it('names the field that is wrong, in a sentence', () => {
    expect(() => parseRolloutInput({ before: {}, after: {} })).toThrow(/needs "workflow"/);
    expect(() => parseRolloutInput({ workflow: 'x', before: { errorRate: 4 }, after: {} })).toThrow(
      /"before.errorRate" is a fraction of calls \(0.004 means 0.4%\)/,
    );
    expect(() => parseRolloutInput({ workflow: 'x', before: {}, after: { p95: 1 } })).toThrow(/unknown field "after.p95"/);
    expect(() => parseRolloutInput({ workflow: 'x', before: {} })).toThrow(/needs "after"/);
  });
});

describe('judgeRollout', () => {
  const base = (after: RolloutInput['after']): RolloutInput => ({
    workflow: SUPPORT.name,
    before: { calls: 5200, errorRate: 0.004, latencyP95Ms: 1800, costPer1k: 2.1 },
    after,
  });

  it('verifies a healthy rollout and lists what it did not measure', () => {
    const r = judgeRollout(base({ calls: 4100, errorRate: 0.005, latencyP95Ms: 1900, costPer1k: 2.4 }), SUPPORT);
    expect(r.verdict).toBe('verified');
    expect(r.reason).toContain('Not measured, so not covered: your quality check');
  });

  it('calls a regression and says which signal, by how much, against which limit', () => {
    const r = judgeRollout(base({ calls: 4100, errorRate: 0.005, latencyP95Ms: 2600, costPer1k: 2.2 }), SUPPORT);
    expect(r.verdict).toBe('regression');
    expect(r.reason).toContain('p95 latency 1800 ms → 2600 ms (+44%; limit +25%)');
  });

  it('uses the workflow’s own limits over the defaults', () => {
    const strict: WorkflowConfig = { ...SUPPORT, signals: { latencyP95MaxIncreasePct: 5 } };
    expect(judgeRollout(base({ calls: 4100, errorRate: 0.004, latencyP95Ms: 1900 }), strict).verdict).toBe('regression');
    expect(judgeRollout(base({ calls: 4100, errorRate: 0.004, latencyP95Ms: 1900 }), SUPPORT).verdict).toBe('verified');
  });

  it('is inconclusive on too little traffic, and still says what to watch', () => {
    const r = judgeRollout(base({ calls: 12, errorRate: 0.083 }), SUPPORT);
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toContain('Only 12 calls since the deploy, fewer than the 100');
    expect(r.reason).toContain('Watch this, though: error rate 0.40% → 8.30%');
  });

  it('is inconclusive without the error rate, whatever else looks fine', () => {
    const r = judgeRollout({ workflow: 'x', before: { calls: 900, latencyP95Ms: 100 }, after: { calls: 900, latencyP95Ms: 100 } }, undefined);
    expect(r.verdict).toBe('inconclusive');
    expect(r.configured).toBe(false);
  });

  it('treats a failed quality check as a regression even on a handful of calls', () => {
    expect(judgeRollout(base({ calls: 3, errorRate: 0.004, quality: 'failed' }), SUPPORT).verdict).toBe('regression');
  });

  it('is inconclusive when the workflow requires the quality check and none was reported', () => {
    const r = judgeRollout(base({ calls: 4100, errorRate: 0.004 }), { ...SUPPORT, signals: { qualityRequired: true } });
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toMatch(/requires the team's quality check/);
  });

  it('prints today’s recovery plan with a regression', () => {
    const recovery = recoveryPlan([{ from: 'gpt-4-0613', to: 'gpt-5.6-sol', shutdownDate: '2026-10-23' }], new Date('2026-10-30T00:00:00Z'));
    const text = renderRollout(judgeRollout(base({ calls: 4100, errorRate: 0.03 }), SUPPORT, recovery)).join('\n');
    expect(text).toContain('REGRESSION');
    expect(text).toContain('✗ Do not revert');
  });
});

describe('outcome records', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('appends one JSON line per migration, with the decision and the rollout verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-outcome-'));
    dirs.push(dir);
    const file = join(dir, '.mendr', 'outcomes.jsonl');
    const rollout = judgeRollout(
      { workflow: SUPPORT.name, before: { calls: 900, errorRate: 0.01 }, after: { calls: 900, errorRate: 0.01 } },
      SUPPORT,
    );
    appendOutcome(file, outcomeRecord(rollout, null, 'merged', 'kept the prompt as it was', new Date('2026-10-21T00:00:00Z')));
    appendOutcome(file, outcomeRecord(rollout, null, null, null, new Date('2026-10-22T00:00:00Z')));
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ schema: 'mendr-outcome/v1', workflow: SUPPORT.name, decision: 'merged', rollout: { verdict: 'verified' } });
  });
});
