import type { WorkflowConfig } from '../config/repoConfig.js';
import type { CallSample } from '../runtime/evidence.js';
import type { RolloutInput, RolloutWindow } from './rollout.js';

// THE ROLLOUT MONITOR'S EYES: THE TEAM'S OWN TELEMETRY, SPLIT AT THE DEPLOY.
//
// `mendr rollout` used to need the numbers typed in. With `--from`, it reads them out of whatever
// the team can export (OpenTelemetry spans, a gateway or application log, a usage export; JSON,
// NDJSON or CSV, read by runtime/evidence.ts) and builds the two windows itself: the days before
// the deploy, and the time since.
//
// WHICH CALLS COUNT, in order of what the team told us:
//   1. the workflow's `telemetry` filter (its service name, and any exact field matches);
//   2. otherwise the migration's models: calls to the old model before the deploy, calls to the
//      new one after, which is exactly the traffic that moved;
//   3. otherwise every call in the export, said out loud, because that may include other features.
//
// It never reads prompts or answers. Quality is not in telemetry: the team's quality check result
// is passed separately.

export const DEFAULT_WINDOW_DAYS = 7;
/** Fewer latency samples than this and p95 is not computed: it would be a guess. */
export const MIN_LATENCY_SAMPLES = 20;

export interface TelemetryWindowsOptions {
  workflow: string;
  config?: WorkflowConfig;
  /** When the migration was deployed. */
  deployedAt: Date;
  windowDays?: number;
  /** The migration's swaps, to tell the moved traffic apart when no filter is configured. */
  swaps?: readonly { from: string; to: string }[];
  /** The team's quality check result for the time since the deploy, if they ran one. */
  quality?: 'passed' | 'failed';
}

export interface TelemetryWindows {
  input: RolloutInput;
  /** What was counted and what could not be read, in sentences. */
  notes: string[];
}

export function windowsFromTelemetry(samples: readonly CallSample[], opts: TelemetryWindowsOptions): TelemetryWindows {
  const notes: string[] = [];
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const deploy = opts.deployedAt.getTime();
  const span = days * 86_400_000;
  const untimed = samples.filter((s) => s.timeMs === null).length;
  if (untimed > 0) notes.push(`${untimed} row${untimed === 1 ? '' : 's'} had no readable time and ${untimed === 1 ? 'was' : 'were'} left out.`);

  const t = opts.config?.telemetry;
  const hasFilter = !!(t && (t.service || (t.match && Object.keys(t.match).length > 0)));
  const matchesFilter = (s: CallSample): boolean =>
    (!t?.service || s.service === t.service) &&
    Object.entries(t?.match ?? {}).every(([k, v]) => String(s.fields[k] ?? '') === v);

  const olds = new Set((opts.swaps ?? []).map((s) => s.from));
  const news = new Set((opts.swaps ?? []).map((s) => s.to));
  let inBefore: (s: CallSample) => boolean;
  let inAfter: (s: CallSample) => boolean;
  if (hasFilter) {
    inBefore = inAfter = matchesFilter;
    notes.push(`Counted the calls matching this workflow's telemetry filter${t?.service ? ` (service "${t.service}")` : ''}.`);
  } else if (olds.size > 0) {
    inBefore = (s) => s.model !== null && olds.has(s.model);
    inAfter = (s) => s.model !== null && news.has(s.model);
    notes.push(
      `Counted calls to ${[...olds].join(', ')} before the deploy and to ${[...news].join(', ')} after it. ` +
        'If other features call the same models, add a "telemetry" filter to this workflow in mendr.config.json.',
    );
  } else {
    inBefore = inAfter = () => true;
    notes.push('Counted every call in the export, which may include other features. Add a "telemetry" filter to this workflow, or pass --migration, to narrow it.');
  }

  const timed = samples.filter((s): s is CallSample & { timeMs: number } => s.timeMs !== null);
  const before = timed.filter((s) => s.timeMs >= deploy - span && s.timeMs < deploy && inBefore(s));
  const after = timed.filter((s) => s.timeMs >= deploy && s.timeMs < deploy + span && inAfter(s));
  const latest = after.reduce((m, s) => Math.max(m, s.timeMs), deploy);
  notes.push(
    `Before: ${days} days up to ${opts.deployedAt.toISOString()}. After: from the deploy to ${new Date(latest).toISOString()}${latest - deploy < span ? ' (the latest call in the export)' : ''}.`,
  );

  const b = summarize(before, 'before', notes);
  const a = summarize(after, 'after', notes);
  if (opts.quality) a.quality = opts.quality;
  return {
    input: { workflow: opts.workflow, deployedAt: opts.deployedAt.toISOString(), before: b, after: a },
    notes,
  };
}

function summarize(rows: readonly CallSample[], which: 'before' | 'after', notes: string[]): RolloutWindow {
  const out: RolloutWindow = {};
  const calls = rows.reduce((n, s) => n + s.requests, 0);
  out.calls = calls;
  if (calls === 0) return out;
  if (rows.every((s) => s.failuresReported !== false)) {
    out.errorRate = rows.reduce((n, s) => n + s.failures, 0) / calls;
  } else {
    notes.push(`Some rows ${which} the deploy have no usable outcome evidence, so error rate was not computed.`);
  }

  const latencies = rows.filter((s) => s.latencyMs !== null).map((s) => s.latencyMs!).sort((x, y) => x - y);
  if (latencies.length >= MIN_LATENCY_SAMPLES) {
    out.latencyP95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
  } else if (latencies.length > 0) {
    notes.push(`Only ${latencies.length} latency sample${latencies.length === 1 ? '' : 's'} ${which} the deploy, fewer than ${MIN_LATENCY_SAMPLES}, so p95 latency was not computed.`);
  }

  const costed = rows.filter((s) => s.costUsd !== null);
  if (costed.length === rows.length) {
    out.costPer1k = (costed.reduce((n, s) => n + s.costUsd!, 0) / calls) * 1000;
  } else if (costed.length > 0) {
    notes.push(`Only some rows ${which} the deploy carry a cost, so cost per 1,000 calls was not computed.`);
  }
  return out;
}
