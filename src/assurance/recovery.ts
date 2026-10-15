// IF THE MIGRATION GOES WRONG: WHAT CAN THE TEAM ACTUALLY DO?
//
// The usual answer, "revert the pull request", is only true while the old model still answers.
// On and after its shutdown date a revert sends every request to a model that no longer exists,
// which is worse than the regression it was meant to undo. So the plan is computed from the dates,
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
  const olds = [...new Set(swaps.map((s) => s.from))].map((m) => `\`${m}\``).join(', ');
  const news = [...new Set(swaps.map((s) => s.to))].map((m) => `\`${m}\``).join(', ');

  let revert: RecoveryOption;
  if (gone.length > 0) {
    const g = gone.map((s) => `\`${s.from}\` shut down on ${s.shutdownDate!.slice(0, 10)}`).join('; ');
    revert = {
      kind: 'revert',
      available: false,
      detail: `Do not revert: ${g}, so a revert sends requests to a model that no longer answers.`,
    };
  } else if (first) {
    revert = {
      kind: 'revert',
      available: true,
      detail: `Revert the pull request and calls go back to ${olds}, until ${first.shutdownDate!.slice(0, 10)}, when \`${first.from}\` shuts down. After that, a revert stops working.`,
    };
  } else {
    revert = {
      kind: 'revert',
      available: true,
      detail: `Revert the pull request and calls go back to ${olds}. No shutdown date is announced yet; check before relying on it.`,
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
    caveats: ['A revert undoes code, not what the feature already did: messages sent and records written stay as they are.'],
  };
}
