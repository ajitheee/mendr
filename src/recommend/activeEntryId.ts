// The stable name of an active-model catalog record.
//
// Mirrors registry/entryId.ts: a derived, deterministic id that the validator
// re-derives and CHECKS rather than trusts, so a hand-edited id that no longer
// matches its record is a violation, not a nickname. An active model has no
// retirement wave, so the qualifier is simply `active`.
//
//   openai.gpt-4o.active
//   anthropic.claude-opus-4-1.active
//   google.gemini-3.6-flash.active

import type { ActiveModel } from './types.js';

/** The deterministic id for an active-model record. Pure over provider + modelId. */
export function activeEntryIdFor(entry: Pick<ActiveModel, 'provider' | 'modelId'>): string {
  return `${entry.provider}.${entry.modelId}.active`;
}
