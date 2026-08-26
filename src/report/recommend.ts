// recommend — human renderer (string[]) + the --json projector.
//
// Pure projector/renderer functions (the cli.ts action only orchestrates and
// prints the thin envelope), matching the report/tiers.ts + watch/issue.ts split.

import type {
  CandidateDecision,
  ExtractedRequirement,
  RecommendationReceipt,
  RecommendJson,
} from '../recommend/types.js';
import type { RecommendScan } from '../recommend/scan.js';

/** The requirement keys that make a receipt need human review, for the warning. */
function reviewReasons(receipt: RecommendationReceipt): { unknownReqs: string[]; indeterminateCaps: string[] } {
  const unknownReqs = receipt.requirements.filter((r) => r.state === 'unknown').map((r) => r.key);
  const keptCandidates = [...receipt.officialSuccessors, ...receipt.compatibleAlternatives];
  const indeterminate = new Set<string>();
  for (const d of keptCandidates) {
    for (const c of d.checks) {
      if (c.result === 'indeterminate' && c.requirement === 'required') indeterminate.add(c.key);
    }
  }
  return { unknownReqs, indeterminateCaps: [...indeterminate] };
}

function requirementLine(r: ExtractedRequirement): string {
  const extra =
    r.key === 'minOutputTokens' && typeof r.min === 'number'
      ? ` (>= ${r.min})`
      : r.key === 'endpoint' && r.endpointFamily
        ? ` (${r.endpointFamily})`
        : '';
  return `    - ${r.key}: ${r.state}${extra}`;
}

function candidateLine(d: CandidateDecision): string {
  if (d.origin === 'official_successor') {
    const verdict = d.registryVerdict ? ` [registry: ${d.registryVerdict}]` : '';
    const note = d.inCatalog ? '' : ' (not yet in the active-model catalog — capability data unavailable)';
    return `    - ${d.modelId}${verdict}${note}`;
  }
  return `    - ${d.modelId}`;
}

function deadlineText(days: number | null): string {
  if (days === null) return 'no dated deadline';
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'due today';
  return `${days}d left`;
}

/** Human report for `recommend`. Returns lines the caller feeds to say(). */
export function renderRecommendText(scan: RecommendScan): string[] {
  const { receipts, reviewRequired, informational } = scan;
  if (receipts.length === 0 && reviewRequired.length === 0 && informational.length === 0) {
    return ['No deprecated model ids found. Nothing to recommend.'];
  }
  const lines: string[] = [];
  if (receipts.length === 0) lines.push('No live deprecated-model calls found.');
  for (const receipt of receipts) {
    lines.push('');
    lines.push(
      `${receipt.deprecated}  (${receipt.provider}, ${receipt.occurrences} live call${receipt.occurrences === 1 ? '' : 's'}, ${deadlineText(receipt.deadlineDays)})`,
    );
    lines.push(`  candidates from: ${receipt.candidateProvider}`);

    // Requirements: show only `required` and `unknown` (not_observed is quiet).
    const shown = receipt.requirements.filter((r) => r.state !== 'not_observed');
    if (shown.length > 0) {
      lines.push('  requirements the code proves:');
      for (const r of shown) lines.push(requirementLine(r));
    }

    if (receipt.reviewFlag) {
      const { unknownReqs, indeterminateCaps } = reviewReasons(receipt);
      const parts: string[] = [];
      if (unknownReqs.length) parts.push(`unknown requirements: ${unknownReqs.join(', ')}`);
      if (indeterminateCaps.length) parts.push(`unverifiable catalog capabilities: ${indeterminateCaps.join(', ')}`);
      lines.push(`  REVIEW: ${parts.join('; ')}`);
    }

    if (receipt.officialSuccessors.length > 0) {
      lines.push('  official successor(s):');
      for (const d of receipt.officialSuccessors) lines.push(candidateLine(d));
    }
    if (!receipt.alternativesQualified) {
      lines.push('  no compatibility-qualified alternatives — endpoint (model class) could not be determined.');
    } else if (receipt.compatibleAlternatives.length > 0) {
      lines.push('  compatible alternative(s):');
      for (const d of receipt.compatibleAlternatives) lines.push(candidateLine(d));
    }
    if (
      receipt.alternativesQualified &&
      receipt.officialSuccessors.length === 0 &&
      receipt.compatibleAlternatives.length === 0
    ) {
      lines.push('  no in-provider model meets your required capabilities.');
    }
    if (receipt.rejected.length > 0) {
      lines.push('  ruled out:');
      for (const d of receipt.rejected) lines.push(`    - ${d.modelId}: ${d.eliminationDetail ?? d.eliminatedBy ?? 'unspecified'}`);
    }
    lines.push(
      '  authorization: compatibility_only — capability match only; behaviour and cost were not evaluated.',
    );
  }

  // Findings recommend cannot generate a shortlist for, but must never hide.
  if (reviewRequired.length > 0) {
    lines.push('');
    lines.push('Review required:');
    for (const r of reviewRequired) {
      lines.push(`  ${r.deprecated} at ${r.file}:${r.line}  [${r.reason}]`);
      lines.push(`    ${r.detail}`);
    }
  }
  if (informational.length > 0) {
    const total = informational.reduce((s, g) => s + g.occurrences, 0);
    lines.push('');
    lines.push(`Informational: ${total} deprecated id occurrence${total === 1 ? '' : 's'} found in data positions`);
    for (const g of informational) lines.push(`  ${g.deprecated} (${g.occurrences})`);
  }
  if (receipts.length === 0) {
    lines.push('');
    lines.push('No compatibility shortlist was generated.');
  }
  return lines;
}

/** The overall outcome + a one-line human reason. */
function statusAndReason(
  hasRecommendations: boolean,
  liveDeprecatedCalls: number,
  otherFindings: number,
): { status: RecommendJson['status']; reason: string } {
  if (hasRecommendations) {
    return { status: 'recommendations', reason: 'Compatible replacements were generated for the live deprecated calls found.' };
  }
  if (liveDeprecatedCalls > 0) {
    return { status: 'no_shortlist', reason: 'Live deprecated calls were found, but no catalog model met their extracted requirements.' };
  }
  if (otherFindings > 0) {
    return { status: 'no_live_calls', reason: 'Deprecated IDs were found, but none reached a verified live API call.' };
  }
  return { status: 'clean', reason: 'No deprecated model ids found.' };
}

/** Build the stable `recommend --json` envelope. Pure. */
export function buildRecommendJson(
  scan: RecommendScan,
  meta: {
    registryVersion: string;
    catalogVersion: string;
    scannedCommit: string | null;
    provider: string | null;
    sortBy: 'cost' | 'context' | null;
  },
): RecommendJson {
  const { receipts, reviewRequired, informational } = scan;
  // Physical counts (deduped by site in scan.ts), not per-registry-entry sums.
  const liveDeprecatedCalls = scan.liveCallSites;
  const usageUnverified = reviewRequired.filter((r) => r.reason === 'usage_unverified').length;
  const informationalCount = informational.reduce((s, g) => s + g.occurrences, 0);
  const hasRecommendations = receipts.some(
    (r) => r.officialSuccessors.length + r.compatibleAlternatives.length > 0,
  );
  const { status, reason } = statusAndReason(
    hasRecommendations,
    liveDeprecatedCalls,
    reviewRequired.length + informational.length,
  );
  const providersFound = [
    ...new Set([
      ...receipts.map((r) => r.provider),
      ...reviewRequired.map((r) => r.provider),
      ...informational.map((g) => g.provider),
    ]),
  ].sort();

  return {
    schema: 'mendr-recommend/v1',
    status,
    reason,
    registryVersion: meta.registryVersion,
    catalogVersion: meta.catalogVersion,
    scannedCommit: meta.scannedCommit ?? null,
    providerFilter: meta.provider ?? null,
    providersFound,
    sortedBy: meta.sortBy,
    hasRecommendations,
    findings: { liveDeprecatedCalls, usageUnverified, informational: informationalCount },
    reviewFlagged: receipts.filter((r) => r.reviewFlag).length,
    filesScanned: scan.filesScanned,
    filesMatched: scan.filesMatched,
    recommendations: receipts,
    reviewRequired,
    informational,
  };
}
