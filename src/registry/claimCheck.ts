// The SOURCE-SIDE promote gate: is the DEPRECATION CLAIM itself defensible?
//
// THE HOLE THIS FILE EXISTS TO CLOSE:
//   classifyEntry() (verify.ts) only ever looks at the REPLACEMENT — is it live,
//   is it the officially recommended target, is it itself deprecated. Nothing
//   looked at the other half of the claim: that `deprecated` is actually dying.
//   So a candidate saying `deprecated: "gpt-4o-mini"` (very much alive) ->
//   `replacement: "gpt-4o"` (live, uncontradicted) classified `verified`,
//   promoted, and the fix engine then auto-rewrote a healthy model under a
//   VERIFIED label. The replacement being real is not evidence the source is dead.
//
// WHAT THIS CAN AND CANNOT CHECK — the constraint that shapes every rule below:
//   there is NO public oracle for "did the provider retire this id". A model
//   being LIVE in a catalog is therefore NOT, on its own, a contradiction: an
//   announced-but-not-yet-shut-down model (gpt-4 today, calls stop 2026-10-23)
//   is legitimately live and legitimately deprecated at the same time. So this
//   gate does not try to confirm the deprecation. It checks that the claim is
//   SELF-CONSISTENT and QUOTE-BACKED:
//     (a) a lifecycle is STATED at all — an unstated one is an unproven claim;
//     (b) `retired` is not contradicted by the catalogs — "calls fail today"
//         and "the catalogs list it live" cannot both be true;
//     (c) `deprecated` carries the shutdown date such an announcement always has;
//     (d) some captured excerpt actually NAMES the model it is cited for;
//     (e) every evidence ref has a snapshot on disk, so a human can read it back.
//   Together those kill the fabricated-evidence path (a made-up quote about a
//   different model, or a hash nobody can open) without ever pretending mendr
//   independently verified the retirement.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRef, LlmModelIdDeprecation } from '../types.js';
import { snapshotName } from './evidence.js';
import { canonicalizeId } from './normalize.js';

/** What the claim check is evaluated against. Both inputs are required. */
export interface ClaimCheckInput {
  /**
   * Canonical + family forms of every live catalog id (oracles.ts#fetchOracles).
   * Used ONLY for the `retired` contradiction in rule (b).
   */
  liveIds: ReadonlySet<string>;
  /**
   * Directory the committed snapshots live in (`registries/evidence`). Required
   * rather than optional-with-a-default: an absent dir would silently turn rule
   * (e) off, and a gate that fails open is not a gate.
   */
  snapshotDir: string;
}

/** The verdict: `ok` plus every reason it is not ok (all rules, not the first). */
export interface ClaimCheckResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Is the deprecated id live in the public catalogs — by EXACT canonical identity?
 *
 * Deliberately NOT isLiveId(), which also matches the FAMILY form. A retired
 * dated snapshot normally shares its family with a live bare alias
 * (`claude-3-opus-20240229` retired while `claude-3-opus` still answers), so a
 * family match would refuse the most common legitimate claim in the registry.
 * Identity matching means rule (b) only fires on what it is meant to catch: the
 * id the candidate names is itself sitting in a catalog, alive.
 */
function deprecatedIdIsLive(deprecated: string, liveIds: ReadonlySet<string>): boolean {
  return liveIds.has(canonicalizeId(deprecated));
}

/**
 * Does this excerpt mention the model it is cited for?
 *
 * Matched case-insensitively, with `.`->`-` applied to BOTH sides so a page
 * writing `gemini-2.0-flash` still matches a registry id spelled
 * `gemini-2-0-flash` (the same normalization canonicalizeId applies to version
 * separators). Everything else is a plain substring test: this rule is meant to
 * be cheap and obvious, not clever.
 */
function excerptNames(excerpt: string, deprecated: string): boolean {
  const flatten = (s: string): string => s.toLowerCase().replace(/\./g, '-');
  const haystack = flatten(excerpt);
  return haystack.includes(flatten(deprecated)) || haystack.includes(canonicalizeId(deprecated));
}

/** Is there a stored snapshot behind this ref? (The `evidence` CLI reports this same state.) */
function refIsBacked(ref: EvidenceRef, snapshotDir: string): boolean {
  return existsSync(join(snapshotDir, snapshotName(ref)));
}

/**
 * Check the DEPRECATION half of a candidate's claim. Called by
 * promoteCandidates() IN ADDITION to classifyEntry() — both must pass, because
 * they check opposite halves of the same sentence ("X is dying, use Y instead").
 *
 * Every failing rule is reported, not just the first: a reviewer fixing a
 * candidate should learn everything wrong with it in one run.
 */
export function checkDeprecationClaim(
  candidate: LlmModelIdDeprecation,
  input: ClaimCheckInput,
): ClaimCheckResult {
  const { deprecated, status } = candidate;
  const reasons: string[] = [];

  // (a) NO lifecycle at all. "This model is being replaced" with no statement of
  // whether calls fail today or in a year is not a claim a gate can evaluate —
  // and it is not something a user can be warned about either.
  if (status === undefined) {
    reasons.push(
      `no "status" on the candidate -- an unstated lifecycle is an unproven claim; ` +
        `say "retired" (calls fail today) or "deprecated" with a "shutdownDate" (announced, still live)`,
    );
  }

  // (b) THE EXPLOIT. `retired` asserts calls fail TODAY; a public catalog
  // listing the id says otherwise. Both cannot be true, so the claim is refused
  // rather than reconciled.
  if (status === 'retired' && deprecatedIdIsLive(deprecated, input.liveIds)) {
    reasons.push(
      `status "retired" claims calls to "${deprecated}" fail today; the catalogs say otherwise ` +
        `-- "${deprecated}" is LIVE in a public catalog (models.dev / OpenRouter)`,
    );
  }

  // (c) An ANNOUNCED deprecation has a date — that is what makes it an
  // announcement. Without one there is nothing to check the claim against and
  // nothing to put in front of a user ("this dies on ..."), so the entry would
  // be a permanent, unfalsifiable "dying soon".
  if (status === 'deprecated' && !candidate.shutdownDate) {
    reasons.push(
      `status "deprecated" with no "shutdownDate" -- an announced deprecation has a date; ` +
        `with no date there is nothing to check and nothing to warn a user with`,
    );
  }

  const evidence = candidate.evidence ?? [];

  // (d) QUOTE-BACKING. A candidate can carry a perfectly well-formed EvidenceRef
  // whose excerpt was invented, or lifted from a row about a different model.
  // Requiring the quote to NAME the id is cheap and kills that path outright.
  if (!evidence.some((ref) => ref.excerpt && excerptNames(ref.excerpt, deprecated))) {
    reasons.push(
      `no evidence excerpt quotes "${deprecated}" -- a quote that never mentions the model ` +
        `it is cited for is not proof of that model's deprecation`,
    );
  }

  // (e) READABLE OFFLINE. `mendr evidence` already reports a hash with no stored
  // snapshot as "the ref is unbacked"; promotion must ACT on that rather than
  // report it. An audit trail nobody can open is not an audit trail.
  for (const ref of evidence) {
    if (!refIsBacked(ref, input.snapshotDir)) {
      reasons.push(
        `evidence ref is unbacked (no snapshot stored for ${ref.contentHash}) ` +
          `-- cannot be checked offline`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}
