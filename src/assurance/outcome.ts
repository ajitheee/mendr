import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MigrationResult } from '../migrate/migrate.js';
import type { RolloutResult } from './rollout.js';

// THE OUTCOME RECORD: ONE MIGRATION, FROM PROVIDER CHANGE TO PRODUCTION RESULT.
//
// Nothing learns from migrations yet, and nothing should until there are real ones to learn from.
// What can be built now is the record a later step would need: what changed, what was proven
// before the pull request, what the person decided, and what happened after the deploy. One JSON
// line per migration, appended to a file the team keeps in its own repository. mendr sends it
// nowhere.

export const OUTCOME_SCHEMA = 'mendr-outcome/v1';

export type HumanDecision = 'merged' | 'edited' | 'closed';
export const HUMAN_DECISIONS: readonly HumanDecision[] = ['merged', 'edited', 'closed'];

export interface OutcomeRecord {
  schema: typeof OUTCOME_SCHEMA;
  recordedAt: string;
  workflow: string;
  migration: {
    swaps: { from: string; to: string; shutdownDate: string | null }[];
    changedFiles: string[];
    checks: Record<string, string>;
    verdict: string;
  } | null;
  decision: HumanDecision | null;
  /** Anything the person wants kept with the case, such as why they edited the pull request. */
  note: string | null;
  rollout: { verdict: string; deployedAt: string | null; signals: { signal: string; state: string }[] };
}

export function outcomeRecord(
  rollout: RolloutResult,
  migration: MigrationResult | null,
  decision: HumanDecision | null,
  note: string | null,
  now: Date,
): OutcomeRecord {
  return {
    schema: OUTCOME_SCHEMA,
    recordedAt: now.toISOString(),
    workflow: rollout.workflow,
    migration: migration
      ? {
          swaps: migration.migrations.map((m) => ({ from: m.from, to: m.to, shutdownDate: m.evidence?.shutdownDate ?? null })),
          changedFiles: migration.changedFiles,
          checks: Object.fromEntries(
            Object.entries(migration.verification)
              .filter(([, v]) => typeof v === 'object' && v !== null && 'status' in v)
              .map(([k, v]) => [k, (v as { status: string }).status]),
          ),
          verdict: migration.verification.verdict,
        }
      : null,
    decision,
    note,
    rollout: {
      verdict: rollout.verdict,
      deployedAt: rollout.deployedAt,
      signals: rollout.signals.map((s) => ({ signal: s.signal, state: s.state })),
    },
  };
}

/** Append one record as a JSON line, creating the file and its folder if needed. */
export function appendOutcome(path: string, record: OutcomeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
