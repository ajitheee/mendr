// Registry integrity validation — the CI gate on the DATA.
//
// The engine gate (isVerified) decides what mendr will auto-apply. This module
// decides what the registry is allowed to CONTAIN, and it is deliberately a
// different question: the engine fails closed on bad data and says nothing,
// which means a registry can rot for months while every run quietly downgrades
// entries to review-only. A user reading `auto-fix eligible: 41` has no way to
// know 45 records went stale.
//
// So every internal contradiction is a BUILD FAILURE:
//   - a `verified` record missing one of the three proofs it claims to have;
//   - `autoApplyAllowed` switched on under any status but `verified`;
//   - a quarantine with no stated cause;
//   - a model_id record with no replacement, or no lifecycle claim at all;
//   - a caveat written in `reasons` on a record that is nonetheless
//     auto-appliable (THE PROSE LINT — the one job the old regex fail-safe
//     still has, now that it is out of the safety path);
//   - a missing, wrong, or duplicated `entryId`.
//
// Pure over the registry it is handed: no filesystem, no clock, no network, so
// the CI script, the `mendr validate-registry` command, and the unit test all
// run the same code against whatever registry they choose.

import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { hasSelfContradictingReasons, selfContradictionMarkersIn } from '../usage/llmRegistry.js';
import { modelIdEntries } from '../usage/llmRegistry.js';
import { entryIdFor } from './entryId.js';

/**
 * Machine-readable violation codes, so a consumer can route (or, one day,
 * grandfather) one class without matching the printed sentence — the same
 * discipline the report's Tier B reason codes follow.
 */
export type RegistryViolationCode =
  | 'verified_without_official_source'
  | 'verified_without_replacement_confirmation'
  | 'verified_without_auto_apply'
  | 'auto_apply_without_verified_status'
  | 'quarantined_without_reason'
  | 'missing_replacement'
  | 'missing_lifecycle'
  | 'caveat_over_auto_apply'
  | 'missing_entry_id'
  | 'entry_id_mismatch'
  | 'duplicate_entry_id';

/** One thing wrong with one record. */
export interface RegistryViolation {
  /** The record's id — its stamped `entryId`, or the derived one when absent. */
  entryId: string;
  code: RegistryViolationCode;
  /** One sentence a human can act on, naming the fields involved. */
  message: string;
}

/** Everything wrong with a registry, plus the arithmetic to summarise it. */
export interface RegistryValidation {
  /** `model_id` records examined. Param entries carry no verification block. */
  recordsChecked: number;
  violations: RegistryViolation[];
}

/** The id a violation is reported under. Never blank — see displayEntryId. */
function idOf(entry: LlmModelIdDeprecation): string {
  return entry.entryId ?? entryIdFor(entry);
}

/**
 * Check every `model_id` record in a registry. Returns ALL violations, not the
 * first: a reviewer fixing a batch of records wants the whole list in one run,
 * and a validator that stops at the first failure trains people to re-run it
 * ten times.
 */
export function validateRegistry(registry: LlmRegistry): RegistryValidation {
  const entries = modelIdEntries(registry);
  const violations: RegistryViolation[] = [];
  const add = (
    entry: LlmModelIdDeprecation,
    code: RegistryViolationCode,
    message: string,
  ): void => {
    violations.push({ entryId: idOf(entry), code, message });
  };

  /** entryId -> the records claiming it, for the uniqueness pass below. */
  const byId = new Map<string, LlmModelIdDeprecation[]>();

  for (const entry of entries) {
    const v = entry.verification;

    // --- the four structured switches, and their contradictions -------------
    if (v?.status === 'verified') {
      if (!v.officialSourceConfirmed) {
        add(
          entry,
          'verified_without_official_source',
          'status "verified" but officialSourceConfirmed is false -- a verified record must ' +
            "rest on the provider's own documentation of the deprecation",
        );
      }
      if (!v.replacementConfirmed) {
        add(
          entry,
          'verified_without_replacement_confirmation',
          `status "verified" but replacementConfirmed is false -- the replacement ` +
            `"${entry.replacement}" is not confirmed live and uncontradicted`,
        );
      }
      if (!v.autoApplyAllowed) {
        // Not "a withheld verified entry": that state is expressible and would
        // be read by a human as a considered decision, when in the data it is
        // indistinguishable from a half-finished edit. If the record should be
        // held back, quarantine it and say why.
        add(
          entry,
          'verified_without_auto_apply',
          'status "verified" but autoApplyAllowed is false -- a record that must not be ' +
            'auto-applied belongs in status "quarantined" with a quarantineReason, not in a ' +
            'verified stamp the switch silently overrides',
        );
      }
    } else if (v?.autoApplyAllowed) {
      add(
        entry,
        'auto_apply_without_verified_status',
        `autoApplyAllowed is true while status is "${v.status}" -- only a verified record may ` +
          'be auto-applied',
      );
    }

    if (v?.status === 'quarantined' && !v.quarantineReason?.trim()) {
      add(
        entry,
        'quarantined_without_reason',
        'status "quarantined" with an empty quarantineReason -- a quarantine must name what ' +
          'has to be resolved before the record can be trusted',
      );
    }

    // --- the record's own substance -----------------------------------------
    if (!entry.replacement?.trim()) {
      add(
        entry,
        'missing_replacement',
        'model_id record has no "replacement" -- there is nothing to migrate to',
      );
    }
    if (!entry.status && !entry.shutdownDate) {
      add(
        entry,
        'missing_lifecycle',
        'model_id record carries neither "status" nor "shutdownDate" -- nothing in the record ' +
          'claims the source id is actually dead',
      );
    }

    // --- THE PROSE LINT ------------------------------------------------------
    // The only surviving job of the old regex fail-safe. It is not a safety
    // gate any more (the engine reads booleans); it is a REVIEW check that
    // catches the exact migration mistake this whole change was about — a
    // caveat sitting in `reasons` under a switched-on record.
    if (v?.autoApplyAllowed && hasSelfContradictingReasons(entry)) {
      const markers = selfContradictionMarkersIn(v.reasons)
        .map((m) => `"${m}"`)
        .join(', ');
      add(
        entry,
        'caveat_over_auto_apply',
        `autoApplyAllowed is true but verification.reasons contains a caveat (${markers}) -- ` +
          'resolve the caveat or quarantine the record; reasons are documentation, so a ' +
          'warning left there is a warning nothing enforces',
      );
    }

    // --- identity -----------------------------------------------------------
    const derived = entryIdFor(entry);
    if (!entry.entryId) {
      add(
        entry,
        'missing_entry_id',
        `model_id record has no "entryId" -- expected "${derived}" ` +
          '(run `mendr verify-registry --write` to stamp it)',
      );
    } else if (entry.entryId !== derived) {
      add(
        entry,
        'entry_id_mismatch',
        `entryId "${entry.entryId}" does not match the id derived from this record ` +
          `("${derived}") -- the id is generated, not chosen`,
      );
    }
    const id = idOf(entry);
    byId.set(id, [...(byId.get(id) ?? []), entry]);
  }

  for (const [id, claimants] of byId) {
    if (claimants.length < 2) continue;
    // Reported once per colliding record, so the count matches the number of
    // records a reviewer has to touch.
    for (const entry of claimants) {
      violations.push({
        entryId: id,
        code: 'duplicate_entry_id',
        message:
          `entryId "${id}" is claimed by ${claimants.length} records -- an id that names two ` +
          'records cannot be used to look either of them up',
      });
    }
  }

  return { recordsChecked: entries.length, violations };
}

/**
 * Render a validation result for a terminal: every violation with its record
 * id, then a summary count. The summary prints on success too — "0 violations
 * across 106 records" is the line a CI log needs to prove the check RAN, as
 * opposed to silently matching nothing.
 */
export function formatValidation(result: RegistryValidation): string[] {
  const { recordsChecked, violations } = result;
  if (violations.length === 0) {
    return [`registry OK: 0 violations across ${recordsChecked} model_id records.`];
  }
  const lines = [`registry INVALID: ${violations.length} violation(s):`, ''];
  for (const v of violations) {
    lines.push(`  ${v.entryId}`);
    lines.push(`    [${v.code}] ${v.message}`);
  }
  // Per-code tally: a batch failure is usually one mistake made N times, and
  // the tally says which mistake without re-reading N paragraphs.
  const byCode = new Map<RegistryViolationCode, number>();
  for (const v of violations) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
  lines.push('');
  lines.push(
    `summary: ${violations.length} violation(s) across ${recordsChecked} model_id records ` +
      `(${[...byCode].map(([code, n]) => `${code} ${n}`).join(', ')}).`,
  );
  return lines;
}
