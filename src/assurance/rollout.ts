import type { WorkflowConfig, WorkflowSignals } from '../config/repoConfig.js';
import type { RecoveryPlan } from './recovery.js';

// THE ROLLOUT CHECK: DID THE MIGRATED FEATURE STAY HEALTHY AFTER THE DEPLOY?
//
// A green build cannot answer that. The only evidence is the feature's own numbers before and
// after the deploy, so this check reads exactly those, as the team reports them from its own
// dashboards (no telemetry integration yet: that waits for a design partner's real stack), and
// gives one of three verdicts:
//
//   verified      enough traffic, every signal measured stayed inside its limit
//   regression    at least one signal moved past its limit; it names which, by how much
//   inconclusive  too little traffic, or a signal the verdict needs was not measured
//
// "Not measured" is never "fine". A verified verdict lists the signals it covers, so a reader
// sees what it did not look at.

export const ROLLOUT_INPUT_SCHEMA = 'mendr-rollout-input/v1';
export const ROLLOUT_SCHEMA = 'mendr-rollout/v1';

/** One window of the feature's numbers, as read off the team's dashboards. */
export interface RolloutWindow {
  /** Calls the feature handled in the window. */
  calls?: number;
  /** Failed calls as a fraction of all calls (0.004 = 0.4%). */
  errorRate?: number;
  latencyP95Ms?: number;
  /** Provider cost per 1,000 calls, in any currency, the same in both windows. */
  costPer1k?: number;
  /** The team's own quality check: did it pass? */
  quality?: 'passed' | 'failed';
}

export interface RolloutInput {
  /** The workflow name from mendr.config.json. */
  workflow: string;
  /** When the migration was deployed (ISO time), for the record. */
  deployedAt?: string;
  before: RolloutWindow;
  after: RolloutWindow;
}

export const DEFAULT_LIMITS: Required<Omit<WorkflowSignals, 'qualityRequired'>> & { qualityRequired: boolean } = {
  errorRateMaxIncrease: 0.005,
  latencyP95MaxIncreasePct: 25,
  costPer1kMaxIncreasePct: 50,
  qualityRequired: false,
};
export const DEFAULT_MIN_CALLS = 100;

export type RolloutVerdict = 'verified' | 'regression' | 'inconclusive';
export type SignalState = 'ok' | 'regression' | 'not_measured';
export type SignalName = 'errorRate' | 'latencyP95Ms' | 'costPer1k' | 'quality';

export interface SignalResult {
  signal: SignalName;
  state: SignalState;
  before?: number | string;
  after?: number | string;
  /** One sentence: the change and the limit it was judged against. */
  detail: string;
}

export interface RolloutResult {
  schema: typeof ROLLOUT_SCHEMA;
  workflow: string;
  /** False when the workflow was not in mendr.config.json and the default limits were used. */
  configured: boolean;
  deployedAt: string | null;
  verdict: RolloutVerdict;
  /** Why the verdict is what it is, in a sentence. */
  reason: string;
  signals: SignalResult[];
  /** The recovery plan, recomputed today, when the migration artifact was given. */
  recovery?: RecoveryPlan;
  /** How the numbers were obtained, when mendr read them from telemetry: what was counted and what was not. */
  notes?: string[];
}

/** Validate a rollout input file's contents, with errors that name the field. */
export function parseRolloutInput(raw: unknown, source = 'the rollout file'): RolloutInput {
  const example = '{ "workflow": "Answer a support question", "before": { "calls": 5200, "errorRate": 0.004 }, "after": { "calls": 4100, "errorRate": 0.006 } }';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object, for example ${example}`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.workflow !== 'string' || r.workflow.trim() === '') {
    throw new Error(`${source} needs "workflow": the name of the feature, as written in mendr.config.json`);
  }
  if (r.deployedAt !== undefined && (typeof r.deployedAt !== 'string' || Number.isNaN(Date.parse(r.deployedAt)))) {
    throw new Error(`${source}: "deployedAt" must be a date and time, such as "2026-10-20T15:00:00Z"`);
  }
  return {
    workflow: r.workflow.trim(),
    ...(typeof r.deployedAt === 'string' ? { deployedAt: r.deployedAt } : {}),
    before: parseWindow(r.before, 'before', source),
    after: parseWindow(r.after, 'after', source),
  };
}

function parseWindow(v: unknown, which: 'before' | 'after', source: string): RolloutWindow {
  const label = which === 'before' ? 'the week before the deploy' : 'the time since the deploy';
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${source} needs "${which}": the feature's numbers for ${label}`);
  }
  const w = v as Record<string, unknown>;
  const out: RolloutWindow = {};
  for (const [k, val] of Object.entries(w)) {
    if (k === 'quality') {
      if (val !== 'passed' && val !== 'failed') throw new Error(`${source}: "${which}.quality" must be "passed" or "failed"`);
      out.quality = val;
      continue;
    }
    if (!['calls', 'errorRate', 'latencyP95Ms', 'costPer1k'].includes(k)) {
      throw new Error(`${source}: unknown field "${which}.${k}" (allowed: calls, errorRate, latencyP95Ms, costPer1k, quality)`);
    }
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      throw new Error(`${source}: "${which}.${k}" must be a number, 0 or more, got ${JSON.stringify(val)}`);
    }
    if (k === 'errorRate' && val > 1) {
      throw new Error(`${source}: "${which}.errorRate" is a fraction of calls (0.004 means 0.4%), so it cannot be more than 1`);
    }
    (out as Record<string, number>)[k] = val;
  }
  return out;
}

/** Judge one rollout against the workflow's limits (or the defaults when it is not configured). */
export function judgeRollout(input: RolloutInput, workflow: WorkflowConfig | undefined, recovery?: RecoveryPlan): RolloutResult {
  const limits = { ...DEFAULT_LIMITS, ...(workflow?.signals ?? {}) };
  const minCalls = workflow?.minCalls ?? DEFAULT_MIN_CALLS;
  const { before, after } = input;

  const signals: SignalResult[] = [
    rising('errorRate', before.errorRate, after.errorRate, (b, a) => a - b > limits.errorRateMaxIncrease, (b, a) =>
      `error rate ${pct(b)} → ${pct(a)} (${signedPoints(a - b)}; limit +${points(limits.errorRateMaxIncrease)})`),
    rising('latencyP95Ms', before.latencyP95Ms, after.latencyP95Ms, (b, a) => a > b * (1 + limits.latencyP95MaxIncreasePct / 100), (b, a) =>
      `p95 latency ${ms(b)} → ${ms(a)} (${change(b, a)}; limit +${limits.latencyP95MaxIncreasePct}%)`),
    rising('costPer1k', before.costPer1k, after.costPer1k, (b, a) => a > b * (1 + limits.costPer1kMaxIncreasePct / 100), (b, a) =>
      `cost per 1,000 calls ${money(b)} → ${money(a)} (${change(b, a)}; limit +${limits.costPer1kMaxIncreasePct}%)`),
    qualitySignal(after.quality, before.quality),
  ];

  const regressions = signals.filter((s) => s.state === 'regression');
  const qualityFailed = signals[3]!.state === 'regression';
  const errorRateMeasured = signals[0]!.state !== 'not_measured';
  const qualityMissing = limits.qualityRequired && signals[3]!.state === 'not_measured';
  const calls = after.calls;
  const enoughTraffic = calls !== undefined && calls >= minCalls;
  const listed = (xs: SignalResult[]): string => xs.map((s) => s.detail).join('; ');

  let verdict: RolloutVerdict;
  let reason: string;
  // The team's own quality check failing is a regression at any traffic. A number moving past its
  // limit is one only with enough calls behind it: on a handful, one failed call reads as a jump.
  if (qualityFailed || (enoughTraffic && regressions.length > 0)) {
    verdict = 'regression';
    reason = `${regressions.length} signal${regressions.length === 1 ? '' : 's'} moved past ${regressions.length === 1 ? 'its' : 'their'} limit: ${listed(regressions)}.`;
  } else if (!enoughTraffic) {
    verdict = 'inconclusive';
    reason =
      (calls === undefined
        ? 'The number of calls since the deploy was not given, so there is no telling whether the numbers mean anything.'
        : `Only ${calls} call${calls === 1 ? '' : 's'} since the deploy, fewer than the ${minCalls} this check needs to judge.`) +
      (regressions.length > 0 ? ` Watch this, though: ${listed(regressions)}.` : '');
  } else if (!errorRateMeasured) {
    verdict = 'inconclusive';
    reason = 'The error rate was not measured in both windows, and a verdict needs at least that.';
  } else if (qualityMissing) {
    verdict = 'inconclusive';
    reason = "This workflow requires the team's quality check, and no result was given for the time since the deploy.";
  } else {
    const covered = signals.filter((s) => s.state === 'ok').map((s) => SIGNAL_LABEL[s.signal]);
    const missing = signals.filter((s) => s.state === 'not_measured').map((s) => SIGNAL_LABEL[s.signal]);
    verdict = 'verified';
    reason = `${calls} calls since the deploy; ${covered.join(', ')} stayed inside ${covered.length === 1 ? 'its limit' : 'their limits'}.${missing.length ? ` Not measured, so not covered: ${missing.join(', ')}.` : ''}`;
  }

  return {
    schema: ROLLOUT_SCHEMA,
    workflow: input.workflow,
    configured: workflow !== undefined,
    deployedAt: input.deployedAt ?? null,
    verdict,
    reason,
    signals,
    ...(recovery ? { recovery } : {}),
  };
}

const SIGNAL_LABEL: Record<SignalName, string> = {
  errorRate: 'error rate',
  latencyP95Ms: 'p95 latency',
  costPer1k: 'cost per 1,000 calls',
  quality: 'your quality check',
};

function rising(
  signal: SignalName,
  b: number | undefined,
  a: number | undefined,
  worse: (b: number, a: number) => boolean,
  describe: (b: number, a: number) => string,
): SignalResult {
  if (b === undefined || a === undefined) {
    return { signal, state: 'not_measured', detail: `${SIGNAL_LABEL[signal]} was not given for both windows` };
  }
  return { signal, state: worse(b, a) ? 'regression' : 'ok', before: b, after: a, detail: describe(b, a) };
}

function qualitySignal(after: 'passed' | 'failed' | undefined, before: 'passed' | 'failed' | undefined): SignalResult {
  if (after === undefined) return { signal: 'quality', state: 'not_measured', detail: 'your quality check was not reported for the time since the deploy' };
  return {
    signal: 'quality',
    state: after === 'failed' ? 'regression' : 'ok',
    ...(before ? { before } : {}),
    after,
    detail: `your quality check ${after} after the deploy${before ? ` (it ${before} before)` : ''}`,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
function points(x: number): string {
  return `${(x * 100).toFixed(2)} points`;
}
function signedPoints(x: number): string {
  return `${x >= 0 ? '+' : '−'}${points(Math.abs(x))}`;
}
function ms(x: number): string {
  return `${Math.round(x)} ms`;
}
function money(x: number): string {
  return x.toFixed(2);
}
function change(b: number, a: number): string {
  if (b === 0) return a === 0 ? 'no change' : 'up from zero';
  const c = ((a - b) / b) * 100;
  return `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(0)}%`;
}

/** The human report. */
export function renderRollout(r: RolloutResult): string[] {
  const head: Record<RolloutVerdict, string> = {
    verified: 'VERIFIED: the feature stayed healthy after the deploy',
    regression: 'REGRESSION: the feature got worse after the deploy',
    inconclusive: 'INCONCLUSIVE: not enough evidence to say either way',
  };
  const mark: Record<SignalState, string> = { ok: '✓', regression: '✗', not_measured: '–' };
  const lines = [`mendr rollout · ${r.workflow}`, ''];
  if (!r.configured) {
    lines.push(`note: "${r.workflow}" is not in mendr.config.json, so the default limits were used.`, '');
  }
  if (r.notes?.length) {
    for (const n of r.notes) lines.push(`from telemetry: ${n}`);
    lines.push('');
  }
  lines.push(head[r.verdict], `  ${r.reason}`, '');
  for (const s of r.signals) lines.push(`  ${mark[s.state]} ${s.detail}`);
  if (r.recovery) {
    lines.push('', `If you act on this (as of ${r.recovery.asOf}):`);
    for (const o of r.recovery.options) lines.push(`  ${o.available ? '•' : '✗'} ${o.detail}`);
    for (const c of r.recovery.caveats) lines.push(`  note: ${c}`);
  }
  lines.push('', 'mendr reads the numbers you gave it. It does not deploy, roll back or change anything.');
  return lines;
}
