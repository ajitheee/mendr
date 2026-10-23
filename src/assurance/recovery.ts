// IF THE MIGRATION GOES WRONG: WHAT CAN THE TEAM ACTUALLY DO?
//
// The usual answer, "revert the pull request", is only true while the old model still answers.
// On and after its announced shutdown date a revert is no longer an option justified by the
// schedule. A date is not an observation that every endpoint has stopped answering. The plan uses dates,
// at the moment it is read: the migration artifact computes it when the pull request is planned,
// and the rollout check computes it again on the day a regression is found.
//
// mendr recommends; a person decides. It never picks a substitute model: choosing one trades cost,
// latency and output quality, which is the team's call.

/** The facts a recovery plan needs from one swap: what moved where, and when the old one stops. */
export interface RecoverySwap {
  from: string;
  to: string;
  /** ISO date the old model shuts down, or null when no date is announced. */
  shutdownDate: string | null;
}

export type RecoveryKind = 'revert' | 'fix_forward' | 'other_model';

export interface RecoveryOption {
  kind: RecoveryKind;
  available: boolean;
  /** One sentence a person can act on. */
  detail: string;
}

export interface RecoveryPlan {
  /** The date the plan was computed for (YYYY-MM-DD). It changes when the shutdown date passes. */
  asOf: string;
  options: RecoveryOption[];
  caveats: string[];
}

/** The recovery options for a migration, as of `now`. */
export function recoveryPlan(swaps: readonly RecoverySwap[], now: Date): RecoveryPlan {
  const asOf = now.toISOString().slice(0, 10);
  const dated = swaps.filter((s) => s.shutdownDate).sort((a, b) => a.shutdownDate!.localeCompare(b.shutdownDate!));
  const first = dated[0];
  const gone = dated.filter((s) => s.shutdownDate!.slice(0, 10) <= asOf);
  const unknown = swaps.filter((s) => !s.shutdownDate);
  const olds = [...new Set(swaps.map((s) => s.from))].map((m) => `\`${m}\``).join(', ');
  const news = [...new Set(swaps.map((s) => s.to))].map((m) => `\`${m}\``).join(', ');

  let revert: RecoveryOption;
  if (gone.length > 0) {
    const g = gone.map((s) => `\`${s.from}\` reached its announced retirement date ${s.shutdownDate!.slice(0, 10)}`).join('; ');
    revert = {
      kind: 'revert',
      available: false,
      detail: `Do not revert on schedule evidence: ${g}. Current endpoint accessibility is not established by a date-only notice.`,
    };
  } else if (unknown.length > 0 || swaps.length === 0) {
    revert = {
      kind: 'revert',
      available: false,
      detail: 'Revert availability is not established: a shutdown date is unknown or no model swaps were supplied. Verify the old model before relying on a revert.',
    };
  } else if (first) {
    revert = {
      kind: 'revert',
      available: true,
      detail: `A code revert would send calls back to ${olds}, within the announced schedule window until ${first.shutdownDate!.slice(0, 10)}. Verify current accessibility and workload behavior before relying on it.`,
    };
  } else {
    revert = {
      kind: 'revert',
      available: false,
      detail: 'Revert availability is not established by the supplied schedule.',
    };
  }

  return {
    asOf,
    options: [
      revert,
      {
        kind: 'fix_forward',
        available: true,
        detail: `Keep ${news} and fix forward in a new pull request: adjust the prompt or the request's parameters.`,
      },
      {
        kind: 'other_model',
        available: true,
        detail: 'Move the affected calls to a different current model. Which one is your decision: it changes cost, latency and answers, so mendr does not choose it.',
      },
    ],
    caveats: [
      'Current model accessibility was not observed by this plan; an announced date is schedule evidence only.',
      'Replacement answer quality, latency and cost are not established by a recovery plan.',
      'A revert undoes code, not what the feature already did: messages sent and records written stay as they are.',
    ],
  };
}
