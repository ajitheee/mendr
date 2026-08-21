// Candidate entries — the human gate between research and the fix engine.
//
// THE INVARIANT THIS FILE EXISTS TO ENFORCE:
//   RESEARCH PRODUCES CANDIDATES; ONLY A HUMAN PROMOTES A CANDIDATE INTO THE
//   ACTIVE REGISTRY.
// An LLM research run, a scheduled discovery job, or a maintainer reading a
// docs page all write to `registries/candidates.json`. The fix engine never
// reads that file — loadLlmRegistry() resolves `llm-deprecations.json` and
// nothing else — so a candidate is inert by construction: it cannot produce a
// finding, cannot appear in a diff, and cannot be --written into anyone's tree.
//
// The only door between the two files is promoteCandidates(). It computes the
// next state of both files and refuses, with an explicit reason, anything that
// is not (a) classified `verified` against live oracles, (b) backed by at least
// one EvidenceRef, and (c) carrying a deprecation claim that is self-consistent
// and quote-backed (claimCheck.ts). Writing the computed state to disk is the
// CLI's job, and only `mendr candidates promote <id...>` — which requires
// explicit ids, never a bare "promote all" — calls it.
//
// (a) and (c) check OPPOSITE HALVES of the same sentence: classifyEntry judges
// the REPLACEMENT ("use Y instead"), checkDeprecationClaim judges the SOURCE
// ("X is dying"). Neither implies the other, which is exactly how a live model
// once got promoted behind a real replacement — see claimCheck.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CandidateEntry,
  CandidateProposer,
  LlmModelIdDeprecation,
  LlmRegistry,
} from '../types.js';
import { assertDeprecation, resolveRegistryAsset } from '../usage/llmRegistry.js';
import { checkDeprecationClaim } from './claimCheck.js';
import { canonicalizeId } from './normalize.js';
import { classifyEntry, type VerificationOracles } from './verify.js';

const CANDIDATES_RELATIVE = join('registries', 'candidates.json');

const VALID_PROPOSERS: ReadonlySet<CandidateProposer> = new Set<CandidateProposer>([
  'llm-research',
  'human',
  'discovery',
]);

/** Walk up from this module's directory to find the candidate queue on disk. */
export function resolveCandidatesPath(): string {
  return resolveRegistryAsset(CANDIDATES_RELATIVE);
}

/**
 * Validate one candidate. The base shape is checked by the SAME validator the
 * active registry uses (a candidate must be a legal registry entry before it is
 * a legal candidate), then the three candidate-only fields are required.
 */
function assertCandidate(entry: unknown, index: number): CandidateEntry {
  // The shared validator words its errors as "llm registry entry #N", which
  // sends a reader to the ACTIVE registry — the one file that is fine. Re-word
  // it here so a broken queue is never mistaken for a broken registry.
  let base;
  try {
    base = assertDeprecation(entry, index);
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).replace(
      /^llm registry entry #\d+ /,
      '',
    );
    throw new Error(`candidate #${index} ${detail}`);
  }
  if (base.kind !== 'model_id') {
    throw new Error(
      `candidate #${index} has kind "${base.kind}" -- candidates are model_id entries only ` +
        `(param kinds have no oracle to gate promotion on; author them in the active registry)`,
    );
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.candidateId !== 'string' || e.candidateId.length === 0) {
    throw new Error(`candidate #${index} has a missing/invalid "candidateId"`);
  }
  if (!VALID_PROPOSERS.has(e.proposedBy as CandidateProposer)) {
    throw new Error(`candidate #${index} has an invalid "proposedBy": ${String(e.proposedBy)}`);
  }
  if (typeof e.proposedAt !== 'string' || e.proposedAt.length === 0) {
    throw new Error(`candidate #${index} has a missing/invalid "proposedAt"`);
  }
  return {
    ...base,
    candidateId: e.candidateId,
    proposedBy: e.proposedBy as CandidateProposer,
    proposedAt: e.proposedAt,
  };
}

/**
 * Load and validate the candidate queue. Same hard-error posture as the active
 * registry loader: a malformed candidate is rejected outright rather than
 * half-read, because a half-read candidate is one a reviewer might promote.
 */
export function loadCandidates(explicitPath?: string): CandidateEntry[] {
  const path = explicitPath ?? resolveCandidatesPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read/parse candidates at ${path}: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`candidates at ${path} must be a JSON array`);
  }
  const candidates = parsed.map(assertCandidate);
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.candidateId)) {
      throw new Error(`candidates at ${path} contain a duplicate candidateId: ${c.candidateId}`);
    }
    seen.add(c.candidateId);
  }
  return candidates;
}

/** Write the candidate queue back, with the trailing newline git prefers. */
export function saveCandidates(candidates: CandidateEntry[], explicitPath?: string): string {
  const path = explicitPath ?? resolveCandidatesPath();
  writeFileSync(path, `${JSON.stringify(candidates, null, 2)}\n`);
  return path;
}

/**
 * Append a candidate, returning a NEW array (pure — the input is untouched).
 *
 * A duplicate `candidateId` THROWS rather than overwriting or silently
 * dropping: both of those quietly discard a pending proposal, and the whole
 * point of the queue is that nothing disappears without a human seeing it.
 */
export function addCandidate(
  candidates: readonly CandidateEntry[],
  candidate: CandidateEntry,
): CandidateEntry[] {
  if (candidates.some((c) => c.candidateId === candidate.candidateId)) {
    throw new Error(`candidate "${candidate.candidateId}" is already queued`);
  }
  return [...candidates, candidate];
}

/** One candidate the gate refused, and the explicit reason it refused. */
export interface PromotionRefusal {
  id: string;
  reason: string;
}

/** The computed next state of both files, plus what moved and what did not. */
export interface PromotionResult {
  /** Entries as they would appear in the ACTIVE registry (candidate fields stripped). */
  promoted: LlmModelIdDeprecation[];
  refused: PromotionRefusal[];
  nextRegistry: LlmRegistry;
  nextCandidates: CandidateEntry[];
}

/** Inputs to a promotion. `ids` is always explicit — there is no "promote all". */
export interface PromoteOptions {
  /** The candidateIds a HUMAN named on the command line. */
  ids: string[];
  /** Live oracle data the promotion gate classifies against. */
  oracles: VerificationOracles;
  /**
   * Where committed evidence snapshots live (`registries/evidence`). REQUIRED:
   * rule 5 refuses a ref with no snapshot on disk, and a defaulted/absent path
   * would quietly turn that check off.
   */
  snapshotDir: string;
  /** ISO date stamped into the promoted entry's verification block. */
  checkedAt?: string;
  /** Which oracles answered, recorded on the promoted entry. */
  sources?: string[];
}

/**
 * Promote named candidates into the active registry. Computes the next state of
 * both files and returns it; the caller writes. (The only impurity is rule 5's
 * existence check against `snapshotDir` — reading no file contents, writing
 * nothing.)
 *
 * HARD RULES, in refusal order (a candidate must clear all of them):
 *   1. the id must name a queued candidate;
 *   2. it must carry >= 1 EvidenceRef — a claim with no proof is not
 *      promotable no matter how it classifies;
 *   3. its `deprecated` id must not already be in the active registry;
 *   4. classifyEntry() must return `verified` against the supplied oracles —
 *      the REPLACEMENT half of the claim;
 *   5. checkDeprecationClaim() must pass — the SOURCE half: a stated lifecycle,
 *      no contradiction with the live catalogs, a shutdown date behind an
 *      announced deprecation, an excerpt naming the model, and a snapshot on
 *      disk behind every ref.
 * Rules 4 and 5 are what the active registry is FOR: it is the file the fix
 * engine auto-applies from, so nothing that would not pass the engine's own
 * gate may enter it — least of all on the say-so of the research run that
 * proposed it. Rule 5 exists because rule 4 alone let a LIVE model be promoted
 * as retired behind a genuine replacement (see claimCheck.ts).
 */
export function promoteCandidates(
  candidates: readonly CandidateEntry[],
  activeRegistry: LlmRegistry,
  opts: PromoteOptions,
): PromotionResult {
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const activeDeprecated = new Set(
    activeRegistry
      .filter((e): e is LlmModelIdDeprecation => e.kind === 'model_id')
      .map((e) => canonicalizeId(e.deprecated)),
  );

  const promoted: LlmModelIdDeprecation[] = [];
  const refused: PromotionRefusal[] = [];
  const movedIds = new Set<string>();

  for (const id of opts.ids) {
    const candidate = byId.get(id);
    if (!candidate) {
      refused.push({ id, reason: `no candidate with candidateId "${id}" is queued` });
      continue;
    }
    if (movedIds.has(id)) continue; // same id named twice on one command line

    if (!candidate.evidence || candidate.evidence.length === 0) {
      refused.push({
        id,
        reason:
          'no evidence captured -- a candidate must carry at least one EvidenceRef ' +
          '(source url + content hash) before it can enter the active registry',
      });
      continue;
    }

    if (activeDeprecated.has(canonicalizeId(candidate.deprecated))) {
      refused.push({
        id,
        reason: `the active registry already has an entry for "${candidate.deprecated}"`,
      });
      continue;
    }

    const { status, reasons } = classifyEntry(candidate, opts.oracles);
    if (status !== 'verified') {
      refused.push({
        id,
        reason: `classifies as ${status}, not verified: ${reasons.join('; ')}`,
      });
      continue;
    }

    // The SOURCE half, checked AFTER the replacement half so a reviewer reads
    // the headline verdict first. A candidate reaching this line has a real,
    // live, uncontradicted replacement — which says nothing whatsoever about
    // whether the id it claims to retire is dying.
    const claim = checkDeprecationClaim(candidate, {
      liveIds: opts.oracles.liveIds,
      snapshotDir: opts.snapshotDir,
    });
    if (!claim.ok) {
      refused.push({
        id,
        reason:
          `the deprecation claim does not hold up: ${claim.reasons.join('; ')} ` +
          `(the replacement checks out -- this refusal is about "${candidate.deprecated}", ` +
          `not "${candidate.replacement}")`,
      });
      continue;
    }

    // The promoted entry is a plain registry entry: the candidate bookkeeping
    // fields do not survive the move, and the verification block is the one
    // this gate just computed — never one the candidate carried in with it.
    const { candidateId: _id, proposedBy: _by, proposedAt: _at, ...entry } = candidate;
    promoted.push({
      ...entry,
      verification: {
        status,
        ...(opts.checkedAt ? { checkedAt: opts.checkedAt } : {}),
        ...(opts.sources ? { sources: opts.sources } : {}),
        // The stamped audit trail states what the gate ACTUALLY established —
        // including the boundary. `verified` here means "the replacement is
        // live and uncontradicted, and the deprecation claim is coherent and
        // quoted", never "mendr confirmed the provider retired this".
        reasons: [
          ...reasons,
          `the deprecation claim for "${candidate.deprecated}" is self-consistent ` +
            `(status "${candidate.status}"` +
            `${candidate.shutdownDate ? `, shutdown ${candidate.shutdownDate}` : ''}) ` +
            `and quote-backed by a stored snapshot; mendr did NOT independently confirm ` +
            `the provider retired it (no public oracle answers that)`,
        ],
      },
    });
    movedIds.add(id);
    activeDeprecated.add(canonicalizeId(candidate.deprecated));
  }

  return {
    promoted,
    refused,
    nextRegistry: [...activeRegistry, ...promoted],
    nextCandidates: candidates.filter((c) => !movedIds.has(c.candidateId)),
  };
}
