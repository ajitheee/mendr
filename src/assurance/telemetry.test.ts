import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readTelemetryRows, toCallSample, type CallSample } from '../runtime/evidence.js';
import { judgeRollout } from './rollout.js';
import { windowsFromTelemetry } from './telemetry.js';
import type { WorkflowConfig } from '../config/repoConfig.js';

// The rollout monitor reads the team's own telemetry export and builds the before and after
// windows itself. These tests use synthetic exports in the shapes runtime/evidence.ts reads.

const DEPLOY = new Date('2026-10-20T15:00:00Z');
const H = 3_600_000;

function sample(over: Partial<CallSample> & { timeMs: number }): CallSample {
  return { model: null, service: null, requests: 1, failures: 0, latencyMs: null, costUsd: null, fields: {}, ...over };
}

/** n calls, spread over the hours before (negative) or after (positive) the deploy. */
function calls(n: number, side: -1 | 1, over: (i: number) => Partial<CallSample>): CallSample[] {
  return Array.from({ length: n }, (_, i) => sample({ timeMs: DEPLOY.getTime() + side * ((i % 48) + 1) * H, ...over(i) }));
}

describe('toCallSample', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads an OpenTelemetry span: time and latency from its nanoseconds, model and service from its attributes, an error status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-otel-'));
    dirs.push(dir);
    const file = join(dir, 'spans.json');
    writeFileSync(
      file,
      JSON.stringify({
        spans: [
          {
            startTimeUnixNano: '1792509600000000000',
            endTimeUnixNano: '1792509601250000000',
            attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-5.6-sol' } }, { key: 'status', value: { stringValue: 'error' } }],
            resource: { attributes: { 'service.name': 'support-api' } },
          },
        ],
      }),
    );
    const [s] = readTelemetryRows(file).map(toCallSample);
    expect(s).toMatchObject({ timeMs: 1792509600000, latencyMs: 1250, model: 'gpt-5.6-sol', service: 'support-api', failures: 1, requests: 1 });
  });

  it('reads a CSV log row with a timestamp, a latency in ms and a cost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-csv-'));
    dirs.push(dir);
    const file = join(dir, 'log.csv');
    writeFileSync(file, 'timestamp,model,latency_ms,status_code,cost_usd\n2026-10-20T16:00:00Z,gpt-5.6-sol,980,200,0.002\n');
    const [s] = readTelemetryRows(file).map(toCallSample);
    expect(s).toMatchObject({ timeMs: Date.parse('2026-10-20T16:00:00Z'), model: 'gpt-5.6-sol', latencyMs: 980, failures: 0, costUsd: 0.002 });
  });
});

describe('windowsFromTelemetry', () => {
  const SWAPS = [{ from: 'gpt-4-0613', to: 'gpt-5.6-sol' }];
  const healthyBefore = calls(400, -1, (i) => ({ model: 'gpt-4-0613', latencyMs: 1000 + (i % 10) * 10, failures: i % 200 === 0 ? 1 : 0, costUsd: 0.002 }));

  it('splits the moved traffic at the deploy and computes the numbers the verdict needs', () => {
    const after = calls(300, 1, (i) => ({ model: 'gpt-5.6-sol', latencyMs: 1600 + (i % 10) * 10, failures: 0, costUsd: 0.003 }));
    const { input, notes } = windowsFromTelemetry([...healthyBefore, ...after], { workflow: 'Answer', deployedAt: DEPLOY, swaps: SWAPS });
    expect(input.before).toMatchObject({ calls: 400, errorRate: 0.005, latencyP95Ms: 1090 });
    expect(input.before.costPer1k).toBeCloseTo(2);
    expect(input.after).toMatchObject({ calls: 300, errorRate: 0, latencyP95Ms: 1690 });
    expect(notes[0]).toContain('Counted calls to gpt-4-0613 before the deploy and to gpt-5.6-sol after it');
    const verdict = judgeRollout(input, undefined);
    expect(verdict.verdict).toBe('regression');
    expect(verdict.reason).toContain('p95 latency 1090 ms → 1690 ms');
  });

  it('uses the workflow’s telemetry filter over the model split', () => {
    const config: WorkflowConfig = { name: 'Answer', paths: ['src'], telemetry: { service: 'support-api', match: { 'http.route': '/answer' } } };
    const mine = (i: number): Partial<CallSample> => ({ model: 'gpt-5.6-sol', service: 'support-api', fields: { 'http.route': '/answer' }, latencyMs: 900 + i });
    const other = (): Partial<CallSample> => ({ model: 'gpt-5.6-sol', service: 'billing-api', fields: {}, latencyMs: 9000 });
    const samples = [...calls(150, -1, mine), ...calls(150, 1, mine), ...calls(80, 1, other)];
    const { input, notes } = windowsFromTelemetry(samples, { workflow: 'Answer', config, deployedAt: DEPLOY, swaps: SWAPS });
    expect(input.after.calls).toBe(150);
    expect(notes[0]).toContain('matching this workflow\'s telemetry filter (service "support-api")');
  });

  it('counts everything when nothing narrows it, and says so', () => {
    const { input, notes } = windowsFromTelemetry(calls(10, 1, () => ({ model: 'x' })), { workflow: 'Answer', deployedAt: DEPLOY });
    expect(input.after.calls).toBe(10);
    expect(notes[0]).toMatch(/Counted every call in the export, which may include other features/);
  });

  it('leaves out what it cannot read, and says what it did not compute', () => {
    const samples = [
      sample({ timeMs: null as unknown as number, model: 'gpt-5.6-sol' }),
      ...calls(5, 1, () => ({ model: 'gpt-5.6-sol', latencyMs: 500 })),
      ...calls(4, 1, (i) => ({ model: 'gpt-5.6-sol', costUsd: i === 0 ? 0.01 : null })),
    ];
    const { input, notes } = windowsFromTelemetry(samples, { workflow: 'Answer', deployedAt: DEPLOY, swaps: SWAPS });
    expect(input.after.latencyP95Ms).toBeUndefined();
    expect(input.after.costPer1k).toBeUndefined();
    expect(notes.join(' ')).toContain('1 row had no readable time and was left out');
    expect(notes.join(' ')).toContain('Only 5 latency samples after the deploy, fewer than 20');
    expect(notes.join(' ')).toContain('Only some rows after the deploy carry a cost');
  });

  it('carries the team’s quality result into the after window', () => {
    const { input } = windowsFromTelemetry(calls(3, 1, () => ({ model: 'gpt-5.6-sol' })), { workflow: 'Answer', deployedAt: DEPLOY, swaps: SWAPS, quality: 'failed' });
    expect(input.after.quality).toBe('failed');
    expect(judgeRollout(input, undefined).verdict).toBe('regression');
  });
});
