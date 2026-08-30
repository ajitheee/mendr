// The GitHub-native single-issue lifecycle report.
//
// ONE issue per repository, identified by a hidden marker and edited in place
// forever (the Renovate Dependency Dashboard mechanic). Prior state lives INSIDE
// the issue body as a hidden JSON block — deliberately, so the workflow never
// writes to the repository and "the default branch is untouched" is structural
// rather than a promise.
//
// SAFETY PROPERTIES this module is responsible for:
//   * A skipped / failed / unsupported / no-data surface stays visible and blocks
//     any general "clean" claim (concludeAudit is the single gate).
//   * The issue closes ONLY when there are no current findings AND every enabled
//     required surface completed. A skipped scan can never close it.
//   * Resolution history survives every update.
//   * Secrets are redacted from anything that reaches the body.
//   * Nothing here opens a PR or merges anything.

import {
  concludeAudit,
  coverageGaps,
  type AuditConclusion,
  type AuditCoverage,
  type ModelInvestigation,
} from './investigation.js';
import { diffFindings, toFindings, type Finding } from './fingerprint.js';
import { RUNTIME_SOURCE_LABEL } from '../runtime/evidence.js';

/** Identifies THE audit issue. Searched for in the body; survives label edits. */
export const AUDIT_MARKER = '<!-- mendr-audit:v1 -->';
/** Present ONLY in a resolved body, so a Mendr close is distinguishable from a human one. */
export const AUDIT_CLEAR_MARKER = '<!-- mendr-audit:clear -->';
export const AUDIT_ISSUE_TITLE = 'Mendr: retiring AI dependencies in this repository';
export const AUDIT_LABEL = 'mendr-audit';

const STATE_OPEN = '<!-- mendr-audit:state';
const STATE_CLOSE = '-->';
/** Keep the history bounded so a long-lived issue body cannot grow without limit. */
export const MAX_HISTORY_ENTRIES = 20;

/** One past lifecycle event, preserved across updates. */
export interface HistoryEntry {
  /** ISO timestamp of the run. */
  at: string;
  /** The commit that was scanned. */
  sha: string;
  newCount: number;
  resolvedCount: number;
  openCount: number;
  conclusion: AuditConclusion;
}

/** What we carry from run to run, stored in the issue body. */
export interface AuditState {
  v: 1;
  /** Fingerprints open as of the last run. */
  open: string[];
  history: HistoryEntry[];
}

export const EMPTY_STATE: AuditState = { v: 1, open: [], history: [] };

// --- secret redaction -------------------------------------------------------

/**
 * Scrub anything credential-shaped before it reaches a public issue body. Applied
 * to the WHOLE rendered body, so no future field can leak by being added without
 * remembering this. Patterns are deliberately broad — a false positive costs a
 * masked string in a report; a false negative publishes a key.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g, '$1-***REDACTED***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh*_***REDACTED***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***REDACTED***')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox*-***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***REDACTED***')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt.***REDACTED***')
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_?KEY|CREDENTIAL)S?)\s*[:=]\s*["']?[^\s"'<>]{6,}/gi,
      '$1=***REDACTED***',
    );
}

// --- state (de)serialization ------------------------------------------------

/** Read the prior state out of an issue body. Missing/corrupt state reads as empty. */
export function parseAuditState(body: string | null | undefined): AuditState {
  if (!body) return { ...EMPTY_STATE };
  const start = body.indexOf(STATE_OPEN);
  if (start === -1) return { ...EMPTY_STATE };
  const end = body.indexOf(STATE_CLOSE, start + STATE_OPEN.length);
  if (end === -1) return { ...EMPTY_STATE };
  const raw = body.slice(start + STATE_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<AuditState>;
    if (parsed.v !== 1) return { ...EMPTY_STATE };
    return {
      v: 1,
      open: Array.isArray(parsed.open) ? parsed.open.filter((s): s is string => typeof s === 'string') : [],
      history: Array.isArray(parsed.history) ? (parsed.history.filter((h) => h && typeof h === 'object') as HistoryEntry[]) : [],
    };
  } catch {
    // A corrupt block must not crash the run or silently erase the issue: treat as
    // no prior state (everything reads as new) rather than throwing in CI.
    return { ...EMPTY_STATE };
  }
}

function serializeState(state: AuditState): string {
  return `${STATE_OPEN}\n${JSON.stringify(state)}\n${STATE_CLOSE}`;
}

// --- close / reopen policy --------------------------------------------------

/**
 * Did every REQUIRED surface complete? Source and config are required; runtime is
 * optional by design and never blocks. A surface that was skipped, failed, or had
 * nothing to scan did NOT complete.
 */
export function requiredSurfacesCompleted(coverage: AuditCoverage): boolean {
  if (coverage.config.failed || !coverage.config.analyzed) return false;
  if (coverage.source.failed || !coverage.source.analyzed) return false;
  if (coverage.source.tsFiles + coverage.source.pyFiles === 0) return false;
  return true;
}

/**
 * May the issue be CLOSED? Only when nothing is open AND every required surface
 * completed. This is the guard against the worst failure mode: a broken or
 * skipped scan reporting zero findings and closing a real exposure.
 */
export function mayClose(coverage: AuditCoverage, openCount: number): boolean {
  return openCount === 0 && requiredSurfacesCompleted(coverage);
}

// --- rendering --------------------------------------------------------------

const DECISION_LABEL: Record<string, string> = {
  patch: 'patch available (reviewed PR — never auto-merged)',
  review: 'review required',
  monitor: 'monitor',
};

const EVIDENCE_LABEL: Record<string, string> = {
  runtime_selector_candidate: 'config selector **candidate**',
  catalog_definition: 'config catalog definition',
  catalog_reference: 'config catalog reference',
  test_fixture: 'test/data fixture',
  code_call_site: 'code call site (model argument)',
  code_candidate: 'code literal (use not proven)',
  code_reference: 'code data reference',
};

function deadlineText(f: Finding): string {
  if (f.daysUntil === null) return f.shutdownDate ? `shuts ${f.shutdownDate}` : 'no dated deadline';
  if (f.daysUntil < 0) return `**${-f.daysUntil}d OVERDUE**`;
  if (f.daysUntil === 0) return '**due TODAY**';
  return `${f.daysUntil}d left`;
}

function findingLine(f: Finding): string {
  const where = f.lines.length > 0 ? `${f.path}:${f.lines.join(', ')}` : f.path;
  const key = f.key ? ` \`${f.key}\`` : '';
  const live = f.observed ? ' · **observed in production**' : '';
  return `- \`${f.model}\` — ${where}${key} — ${EVIDENCE_LABEL[f.evidenceType] ?? f.evidenceType} — ${deadlineText(f)}${live}`;
}

/** The coverage matrix, as markdown rows. Always rendered. */
export function coverageMatrixLines(coverage: AuditCoverage): string[] {
  const c = coverage;
  const rows: string[] = ['| surface | status |', '| --- | --- |'];
  rows.push(
    `| Source code (TS/TSX/Python) | ${
      c.source.failed
        ? '✗ **FAILED**'
        : !c.source.analyzed
          ? '○ **not scanned**'
          : c.source.tsFiles + c.source.pyFiles === 0
            ? '○ **no supported source found**'
            : `✓ ${c.source.tsFiles + c.source.pyFiles} files (${c.source.tsFiles} TS/TSX, ${c.source.pyFiles} Python)`
    } |`,
  );
  rows.push(`| Configuration | ${c.config.failed ? '✗ **FAILED**' : `✓ ${c.config.filesScanned} files`} |`);
  rows.push(`| Deprecation registry | ✓ ${c.registry.providers.join(', ') || 'none'} |`);
  rows.push(
    `| Runtime usage | ${
      c.runtime.failed
        ? '✗ **FAILED**'
        : c.runtime.connected
          ? `✓ ${RUNTIME_SOURCE_LABEL[c.runtime.source ?? 'usage_export']}`
          : '○ not measured — optional, not connected'
    } |`,
  );
  rows.push('| Reader tie-back | ○ not proven |');
  return rows;
}

export interface AuditIssueInput {
  investigations: readonly ModelInvestigation[];
  coverage: AuditCoverage;
  /** The exact commit that was scanned. */
  sha: string;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  previous: AuditState;
  repoUrl?: string;
}

export interface AuditIssueRender {
  title: string;
  body: string;
  state: AuditState;
  conclusion: AuditConclusion;
  openCount: number;
  newCount: number;
  resolvedCount: number;
  /** True when the issue may be closed (nothing open AND every required surface ran). */
  closable: boolean;
}

/** Render the whole issue body. The returned body is already redacted. */
export function renderAuditIssue(input: AuditIssueInput): AuditIssueRender {
  const { investigations, coverage, sha, scannedAt, previous } = input;
  const findings = toFindings(investigations);
  const diff = diffFindings(previous.open, findings);
  const conclusion = concludeAudit(coverage, investigations.length);
  const closable = mayClose(coverage, findings.length);
  const shortSha = sha.slice(0, 7);

  const history: HistoryEntry[] = [
    ...previous.history,
    {
      at: scannedAt,
      sha: shortSha,
      newCount: diff.fresh.length,
      resolvedCount: diff.resolved.length,
      openCount: findings.length,
      conclusion,
    },
  ].slice(-MAX_HISTORY_ENTRIES);

  const state: AuditState = { v: 1, open: findings.map((f) => f.fingerprint), history };

  const L: string[] = [AUDIT_MARKER];
  if (closable) L.push(AUDIT_CLEAR_MARKER);
  L.push('');
  L.push(`## ${AUDIT_ISSUE_TITLE}`);
  L.push('');
  L.push(`**Scanned commit:** \`${sha}\` · **Scanned at:** ${scannedAt}`);
  L.push('');

  // Conclusion — never a general "clean".
  if (findings.length === 0) {
    if (closable) {
      L.push('### ✅ No current exposure');
      L.push('');
      L.push('No retiring AI dependencies were found, and every required surface completed successfully.');
    } else {
      L.push('### ⚠️ No findings — but this is NOT a clean result');
      L.push('');
      L.push('A required surface did not complete, so zero findings proves nothing:');
      for (const gap of coverageGaps(coverage)) L.push(`- ${gap}`);
    }
  } else {
    L.push(
      `### ${diff.fresh.length} new · ${diff.continuing.length} continuing · ${diff.resolved.length} resolved`,
    );
  }
  L.push('');

  if (diff.fresh.length > 0) {
    L.push('### 🆕 New');
    L.push('');
    for (const f of diff.fresh) L.push(findingLine(f));
    L.push('');
  }
  if (diff.continuing.length > 0) {
    L.push('### ➡️ Continuing');
    L.push('');
    for (const f of diff.continuing) L.push(findingLine(f));
    L.push('');
  }
  if (diff.resolved.length > 0) {
    L.push('### ✅ Resolved since the last scan');
    L.push('');
    L.push(`${diff.resolved.length} finding(s) no longer present at \`${shortSha}\`.`);
    L.push('');
  }

  // Per-model detail: retirement evidence, classification, uncertainty, next action.
  if (investigations.length > 0) {
    L.push('<details><summary>Evidence and next actions</summary>');
    L.push('');
    for (const inv of investigations) {
      const r = inv.retirementEvidence;
      L.push(`#### \`${inv.model}\` (${inv.provider})`);
      L.push('');
      L.push(`- **Retirement:** ${r.status ?? 'listed'}${r.shutdownDate ? ` — ${r.shutdownDate}` : ''}${r.sourceUrl ? ` ([source](${r.sourceUrl}))` : ''}`);
      if (r.replacement) {
        L.push(
          `- **Migration evidence:** \`${r.replacement}\` — registry verdict **${r.replacementVerdict ?? 'unstamped'}**` +
            (r.replacementVerdict === 'verified' ? ' (evidence only; not applied)' : ' — not a recommended swap'),
        );
      }
      L.push(
        `- **Production usage:** ${
          !inv.productionUsage.measured
            ? 'not measured'
            : inv.productionUsage.observed
              ? `observed${inv.productionUsage.requests > 0 ? ` — ${inv.productionUsage.requests.toLocaleString('en-US')} requests` : ''}`
              : 'not observed in the connected source (which covers only what it records)'
        }`,
      );
      L.push('- **Reader tie-back:** not proven — a config location is a *candidate*, not a proven runtime control.');
      L.push(`- **Next action:** ${DECISION_LABEL[inv.decision] ?? inv.decision}`);
      L.push('');
    }
    L.push('</details>');
    L.push('');
  }

  L.push('### Audit coverage');
  L.push('');
  for (const row of coverageMatrixLines(coverage)) L.push(row);
  L.push('');
  const gaps = coverageGaps(coverage);
  if (gaps.length > 0) {
    L.push('**Limits of this run:**');
    for (const gap of gaps) L.push(`- ${gap}`);
    L.push('');
  }

  if (history.length > 1) {
    L.push('<details><summary>Scan history</summary>');
    L.push('');
    L.push('| scanned at | commit | new | resolved | open | conclusion |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const h of [...history].reverse()) {
      L.push(`| ${h.at} | \`${h.sha}\` | ${h.newCount} | ${h.resolvedCount} | ${h.openCount} | ${h.conclusion} |`);
    }
    L.push('');
    L.push('</details>');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(
    'Mendr edits this one issue in place. It does not modify the default branch, does not merge anything, ' +
      'and opens a migration PR only for a verified Tier-A code call site — always for review. ' +
      'Config findings stay review-only until reader tie-back is proven.',
  );
  L.push('');
  L.push(serializeState(state));

  return {
    title: AUDIT_ISSUE_TITLE,
    body: redactSecrets(L.join('\n')),
    state,
    conclusion,
    openCount: findings.length,
    newCount: diff.fresh.length,
    resolvedCount: diff.resolved.length,
    closable,
  };
}

/**
 * The findings a verified migration PR may cover: Tier-A code call sites with a
 * VERIFIED successor. Never config (tie-back unproven), never an unverified
 * replacement. Empty means: do not open a PR.
 */
export function prEligibleFindings(investigations: readonly ModelInvestigation[]): Finding[] {
  return toFindings(investigations).filter(
    (f) =>
      f.surface === 'code' &&
      f.evidenceType === 'code_call_site' &&
      f.tier === 'A' &&
      f.replacementVerdict === 'verified',
  );
}
