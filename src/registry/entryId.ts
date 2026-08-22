// The stable name of a registry record.
//
// WHY THIS EXISTS: findings told the reader to run `mendr evidence <id>` and
// then never printed an id. The bare deprecated model id worked as an argument
// by accident (`evidence` matched on it), but it is not an identity: the same
// model id can legitimately appear under two providers, and the same
// provider+model can carry two records for two different retirement waves. A
// record needs a name that a person can copy off the screen and a validator can
// prove unique.
//
// FORMAT: `<provider>.<deprecated>.<qualifier>` where the qualifier is
// `retirement-<shutdownDate>` when the entry carries one and
// `retirement-undated` when it does not — e.g.
//   openai.gpt-4.retirement-2026-10-23
//   google.gemini-2.0-flash.retirement-undated
//
// The pieces are joined with `.` and NOT sanitised. Model ids already contain
// dots (`gemini-2.0-flash`) and the id is a display/lookup key, not a path or a
// parsed structure — inventing an escaping scheme would make the printed id
// differ from the model id a reader recognises, which is the one property that
// makes it copyable.

import type { LlmModelIdDeprecation } from '../types.js';

/** The qualifier segment: the retirement wave this record describes. */
function qualifierFor(entry: Pick<LlmModelIdDeprecation, 'shutdownDate'>): string {
  const date = entry.shutdownDate;
  return date ? `retirement-${date}` : 'retirement-undated';
}

/**
 * The deterministic id for a model-id record. Pure over the three fields it
 * reads, so the persisted `entryId` in the registry JSON can be re-derived and
 * CHECKED rather than trusted (see validateRegistry.ts) — a hand-edited id that
 * no longer matches its entry is a violation, not a nickname.
 */
export function entryIdFor(
  entry: Pick<LlmModelIdDeprecation, 'provider' | 'deprecated' | 'shutdownDate'>,
): string {
  return `${entry.provider}.${entry.deprecated}.${qualifierFor(entry)}`;
}

/**
 * The id to PRINT for an entry: the persisted one when it has been stamped,
 * otherwise the derived one. Never blank — a finding that printed an empty
 * `registry entry:` row would be worse than the missing row it replaced.
 */
export function displayEntryId(entry: LlmModelIdDeprecation): string {
  return entry.entryId ?? entryIdFor(entry);
}
