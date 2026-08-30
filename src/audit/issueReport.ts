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
//     any general "clean" claim.
//   * A finding is RESOLVED only when its own surface actually ran; otherwise it
//     is CARRIED FORWARD, stays open, and stays in the baseline.
//   * The issue closes ONLY when nothing is open, no surface failed, and every
//     required surface completed. A broken scan can never close a live exposure.
//   * Resolution history survives every update.
//   * Repo-controlled text cannot forge a marker, and secrets are redacted.
//   * Nothing here opens a PR or merges anything.

import {
  concludeAudit,
  coverageGaps,
  isExposure,
  type AuditConclusion,
  type AuditCoverage,
  type ModelInvestigation,
} from './investigation.js';
import {
  diffFindings,
  resolutionsAreTrustworthy,
  surfaceCompleted,
  toFindings,
  toOpenFinding,
  type Finding,
  type OpenFinding,
} from './fingerprint.js';
import { RUNTIME_SOURCE_LABEL } from '../runtime/evidence.js';

export const AUDIT_MARKER = '<!-- mendr-audit:v1 -->';
export const AUDIT_CLEAR_MARKER = '<!-- mendr-audit:clear -->';
export const AUDIT_ISSUE_TITLE = 'Mendr: retiring AI dependencies in this repository';
export const AUDIT_LABEL = 'mendr-audit';

const STATE_OPEN = '<!-- mendr-audit:state';
const STATE_CLOSE = '-->';
export const MAX_HISTORY_ENTRIES = 20;

/** GitHub rejects an issue body over 65536 chars; stay clear of the edge. */
export const MAX_BODY_CHARS = 60_000;
/** Hard cap on rendered finding lines, before the char budget even applies. */
export const MAX_LISTED_FINDINGS = 60;

export interface HistoryEntry {
  at: string;
  sha: string;
  newCount: number;
  resolvedCount: number;
  openCount: number;
  conclusion: AuditConclusion;
}

export interface AuditState {
  v: 1;
  open: OpenFinding[];
  history: HistoryEntry[];
}

export const EMPTY_STATE: AuditState = { v: 1, open: [], history: [] };

// --- injection + secret defence ---------------------------------------------

/**
 * Neutralize repo-controlled text before it is interpolated into the body. A
 * committed file path may contain `<`, `>` or a newline; without this, a path such
 * as `src/<!-- mendr-audit:clear -->/x.ts` would forge the marker that tells the
 * workflow Mendr closed this issue, or inject a second state block.
 */
export function sanitizeRepoText(s: string): string {
  return s.replace(/[<>|`]/g, '�').replace(/[\r\n]+/g, ' ').slice(0, 400);
}

/**
 * Scrub anything credential-shaped before it reaches a public issue body. Applied
 * to the WHOLE rendered body, so no future field can leak by being added without
 * remembering this.
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

/** Tolerantly read one persisted open finding (accepts the legacy bare-id shape). */
function toOpen(raw: unknown): OpenFinding | null {
  if (typeof raw === 'string') {
    return { fp: raw, model: '?', path: '?', key: null, evidenceType: '?', surface: 'code' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.fp !== 'string') return null;
  const surface = o.surface === 'config' || o.surface === 'runtime' ? o.surface : 'code';
  return {
    fp: o.fp,
    model: typeof o.model === 'string' ? o.model : '?',
    path: typeof o.path === 'string' ? o.path : '?',
    key: typeof o.key === 'string' ? o.key : null,
    evidenceType: typeof o.evidenceType === 'string' ? o.evidenceType : '?',
    surface,
  };
}

/**
 * Read the prior state out of an issue body. Uses the LAST state block, so an
 * injected block earlier in the body cannot shadow the real one. Missing or
 * corrupt state reads as empty rather than throwing in CI.
 */
export function parseAuditState(body: string | null | undefined): AuditState {
  if (!body) return { v: 1, open: [], history: [] };
  const start = body.lastIndexOf(STATE_OPEN);
  if (start === -1) return { v: 1, open: [], history: [] };
  const end = body.indexOf(STATE_CLOSE, start + STATE_OPEN.length);
  if (end === -1) return { v: 1, open: [], history: [] };
  try {
    const parsed = JSON.parse(body.slice(start + STATE_OPEN.length, end).trim()) as Partial<AuditState>;
    if (parsed.v !== 1) return { v: 1, open: [], history: [] };
    return {
      v: 1,
      open: Array.isArray(parsed.open) ? parsed.open.map(toOpen).filter((o): o is OpenFinding => o !== null) : [],
      history: Array.isArray(parsed.history) ? (parsed.history.filter((h) => h && typeof h === 'object') as HistoryEntry[]) : [],
    };
  } catch {
    return { v: 1, open: [], history: [] };
  }
}

const serializeState = (state: AuditState): string =>
  `${STATE_OPEN}\n${JSON.stringify(state)}\n${STATE_CLOSE}`;

// --- close policy -----------------------------------------------------------

/**
 * Did every REQUIRED surface complete? Source and config are required. Runtime is
 * optional for RAISING findings, so it is not required here — but see
 * {@link mayClose}, which will not close while a runtime-only finding is carried.
 */
export function requiredSurfacesCompleted(coverage: AuditCoverage): boolean {
  return surfaceCompleted(coverage, 'code') && surfaceCompleted(coverage, 'config');
}

/** Any surface attempted and errored? Then nothing this run can be trusted. */
export function anySurfaceFailed(coverage: AuditCoverage): boolean {
  return !!coverage.source.failed || !!coverage.config.failed || !!coverage.runtime.failed;
}

/**
 * May the issue be CLOSED? Only when nothing is open, no surface failed, and every
 * required surface completed. The guard against the worst failure mode: a broken
 * or skipped scan reporting zero findings and closing a real exposure.
 */
export function mayClose(coverage: AuditCoverage, openCount: number): boolean {
  if (openCount !== 0) return false;
  if (anySurfaceFailed(coverage)) return false;
  return requiredSurfacesCompleted(coverage);
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
  const path = sanitizeRepoText(f.path);
  const where = f.lines.length > 0 ? `${path}:${f.lines.join(', ')}` : path;
  const key = f.key ? ` \`${sanitizeRepoText(f.key)}\`` : '';
  const live = f.observed ? ' · **observed in production**' : '';
  return `- \`${sanitizeRepoText(f.model)}\` — ${where}${key} — ${EVIDENCE_LABEL[f.evidenceType] ?? f.evidenceType} — ${deadlineText(f)}${live}`;
}

const openLine = (o: OpenFinding): string =>
  `- \`${sanitizeRepoText(o.model)}\` — ${sanitizeRepoText(o.path)} (${o.surface})`;

/** A bounded list: at most `limit` lines, then an explicit remainder note. */
function boundedList(items: string[], limit: number): string[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), `- … and ${items.length - limit} more (not shown)`];
}

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
  const configRead = c.config.filesRead ?? c.config.filesScanned;
  rows.push(
    `| Configuration | ${
      c.config.failed
        ? '✗ **FAILED**'
        : c.config.filesScanned === 0
          ? '○ not applicable — no supported configuration files found'
          : configRead === 0
            ? `✗ **${c.config.filesScanned} files found but NONE could be read**`
            : `✓ ${configRead} files`
    } |`,
  );
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
  if (c.source.unanalyzedLanguages && c.source.unanalyzedLanguages.length > 0) {
    rows.push(`| Other languages present | ○ not analyzed — ${c.source.unanalyzedLanguages.join(', ')} |`);
  }
  rows.push('| Reader tie-back | ○ not proven |');
  return rows;
}

export interface AuditIssueInput {
  investigations: readonly ModelInvestigation[];
  coverage: AuditCoverage;
  sha: string;
  scannedAt: string;
  previous: AuditState;
}

export interface AuditIssueRender {
  title: string;
  body: string;
  state: AuditState;
  conclusion: AuditConclusion;
  openCount: number;
  newCount: number;
  resolvedCount: number;
  carriedCount: number;
  closable: boolean;
}

/** Render the whole issue body. The returned body is sanitized and redacted. */
export function renderAuditIssue(input: AuditIssueInput): AuditIssueRender {
  const { investigations, coverage, sha, scannedAt, previous } = input;
  // Only real EXPOSURE enters the issue lifecycle. Informational catalog /
  // fixture / documentation references are reported separately and must never
  // open, hold open, or reopen an issue.
  const exposureInvestigations = investigations.filter(isExposure);
  const informationalCount = investigations.length - exposureInvestigations.length;
  const findings = toFindings(exposureInvestigations);
  const diff = diffFindings(previous.open, findings, coverage);

  // Carried findings stay OPEN — they were never re-checked, so they are not gone.
  const carriedOpen = diff.carried;
  const openCount = findings.length + carriedOpen.length;

  // The conclusion and the headings must come from the SAME number the body shows.
  const conclusion = concludeAudit(coverage, openCount);
  const closable = mayClose(coverage, openCount);
  const trustworthy = resolutionsAreTrustworthy(coverage);
  const shortSha = sanitizeRepoText(sha.slice(0, 7));

  const historyEntry: HistoryEntry = {
    at: scannedAt,
    sha: shortSha,
    newCount: diff.fresh.length,
    resolvedCount: diff.resolved.length,
    openCount,
    conclusion,
  };
  // Append a history row ONLY when something meaningful changed, so a daily no-op
  // run does not rewrite the issue forever.
  const last = previous.history[previous.history.length - 1];
  const changed =
    !last ||
    last.sha !== historyEntry.sha ||
    last.openCount !== historyEntry.openCount ||
    last.conclusion !== historyEntry.conclusion ||
    historyEntry.newCount > 0 ||
    historyEntry.resolvedCount > 0;
  const history = (changed ? [...previous.history, historyEntry] : previous.history).slice(-MAX_HISTORY_ENTRIES);

  // The baseline: everything currently found PLUS everything we could not re-check.
  // Repo-derived strings are sanitized HERE too: they are JSON-serialized into the
  // state block, where a raw `<!-- mendr-audit:state` in a committed path would
  // otherwise inject a second block and shadow the real baseline.
  const safeOpen = (o: OpenFinding): OpenFinding => ({
    ...o,
    path: sanitizeRepoText(o.path),
    model: sanitizeRepoText(o.model),
    key: o.key === null ? null : sanitizeRepoText(o.key),
  });
  const state: AuditState = {
    v: 1,
    open: [...findings.map(toOpenFinding), ...carriedOpen].slice(0, 500).map(safeOpen),
    history,
  };

  const L: string[] = [AUDIT_MARKER];
  if (closable) L.push(AUDIT_CLEAR_MARKER);
  L.push('');
  L.push(`## ${AUDIT_ISSUE_TITLE}`);
  L.push('');
  L.push(`**Scanned commit:** \`${sanitizeRepoText(sha)}\` · **Scanned at:** ${scannedAt}`);
  L.push('');

  if (openCount === 0) {
    if (closable) {
      L.push('### ✅ No exposure in the surfaces that completed');
      L.push('');
      L.push('No retiring AI dependencies were found, and every required surface completed successfully.');
      L.push('This is not a general all-clear — surfaces mendr does not analyze are not covered.');
    } else {
      L.push('### ⚠️ No findings — but this is NOT a clean result');
      L.push('');
      L.push(
        anySurfaceFailed(coverage)
          ? 'A surface was attempted and FAILED, so this run proves nothing:'
          : 'A required surface did not complete, so zero findings proves nothing:',
      );
      for (const gap of coverageGaps(coverage)) L.push(`- ${gap}`);
    }
  } else {
    const parts = [`${diff.fresh.length} new`, `${diff.continuing.length} continuing`, `${diff.resolved.length} resolved`];
    if (diff.moved.length > 0) parts.push(`${diff.moved.length} moved`);
    if (carriedOpen.length > 0) parts.push(`${carriedOpen.length} not re-checked`);
    L.push(`### ${parts.join(' · ')}`);
  }
  L.push('');

  if (diff.fresh.length > 0) {
    L.push('### 🆕 New');
    L.push('');
    for (const line of boundedList(diff.fresh.map(findingLine), MAX_LISTED_FINDINGS)) L.push(line);
    L.push('');
  }
  if (diff.continuing.length > 0) {
    L.push('### ➡️ Continuing');
    L.push('');
    for (const line of boundedList(diff.continuing.map(findingLine), MAX_LISTED_FINDINGS)) L.push(line);
    L.push('');
  }
  if (diff.moved.length > 0) {
    L.push('### 🔀 Moved (same finding, new location — not fixed)');
    L.push('');
    for (const m of diff.moved.slice(0, MAX_LISTED_FINDINGS)) {
      L.push(`- \`${sanitizeRepoText(m.to.model)}\` — ${sanitizeRepoText(m.from.path)} → ${sanitizeRepoText(m.to.path)}`);
    }
    L.push('');
  }
  // Resolutions are only ever claimed when the owning surface actually ran.
  if (diff.resolved.length > 0 && trustworthy) {
    L.push('### ✅ Resolved since the last scan');
    L.push('');
    for (const line of boundedList(diff.resolved.map(openLine), MAX_LISTED_FINDINGS)) L.push(line);
    L.push('');
  }
  if (carriedOpen.length > 0) {
    L.push('### ⏸️ Not re-checked this run (still open)');
    L.push('');
    L.push('The surface that found these did not complete, so they could NOT be verified as fixed:');
    for (const line of boundedList(carriedOpen.map(openLine), MAX_LISTED_FINDINGS)) L.push(line);
    L.push('');
  }

  if (exposureInvestigations.length > 0) {
    L.push('<details><summary>Evidence and next actions</summary>');
    L.push('');
    for (const inv of exposureInvestigations.slice(0, MAX_LISTED_FINDINGS)) {
      const r = inv.retirementEvidence;
      L.push(`#### \`${sanitizeRepoText(inv.model)}\` (${sanitizeRepoText(inv.provider)})`);
      L.push('');
      L.push(`- **Retirement:** ${r.status ?? 'listed'}${r.shutdownDate ? ` — ${r.shutdownDate}` : ''}`);
      if (r.replacement) {
        L.push(
          `- **Migration evidence:** \`${sanitizeRepoText(r.replacement)}\` — registry verdict **${r.replacementVerdict ?? 'unstamped'}**` +
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

  if (informationalCount > 0) {
    L.push(`_${informationalCount} further deprecated model id(s) appear only in catalog, documentation or fixture data. Those are references, not dependencies, and do not affect this issue._`);
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

  // Budget the body BEFORE the state block, which must always survive intact —
  // losing it would erase the baseline and re-report everything as new.
  const stateBlock = serializeState(state);
  let prose = redactSecrets(L.join('\n'));
  const budget = MAX_BODY_CHARS - stateBlock.length - 200;
  if (prose.length > budget) {
    prose = `${prose.slice(0, budget)}\n\n_(report truncated to fit GitHub's issue size limit — see the full report in CI logs)_\n`;
  }

  return {
    title: AUDIT_ISSUE_TITLE,
    body: `${prose}\n${stateBlock}`,
    state,
    conclusion,
    openCount,
    newCount: diff.fresh.length,
    resolvedCount: trustworthy ? diff.resolved.length : 0,
    carriedCount: carriedOpen.length,
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
      f.tiers.includes('A') &&
      f.replacementVerdict === 'verified',
  );
}
