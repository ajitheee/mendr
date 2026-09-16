import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Finding } from '../audit/fingerprint.js';

// THE COMMITTED SUPPRESSION FILE: `.mendr/suppressions.json`.
//
// A scanner nobody can argue with is a scanner people turn off. The answer is not fewer
// findings — it is letting the person who owns the code say "I looked, and this one is not a
// dependency", in a file their colleagues can review in a pull request like any other change.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. A SUPPRESSION IS NEVER SILENCE. Suppressed findings are reported, every run, with the
//    reason and the person who wrote it. They stop being ACTIONABLE; they do not stop being
//    VISIBLE. The audit's conclusion is computed before suppression is applied, so a repository
//    whose every finding is suppressed still reports `exposure_detected` and can never read as
//    clean. That is the whole point: the tool must not become a way to make a real exposure
//    disappear from a dashboard.
//
// 2. IDENTITY IS SEMANTIC, NOT POSITIONAL. A suppression keys on the finding fingerprint from
//    audit/fingerprint.ts — provider, normalized model, repo-relative path, key, evidence type —
//    so it survives a reformat above it. Keying on `file:line` would mean every unrelated edit
//    silently un-suppresses a finding, or worse, slides the suppression onto a different one.
//
// 3. A SUPPRESSION CAN EXPIRE, AND A STALE ONE IS REPORTED. `expiresAt` makes "not now" different
//    from "never", which is what most of these really mean. Past that date the finding comes back
//    on its own. And a suppression whose finding no longer exists is surfaced as stale rather than
//    left to accumulate, because a file full of dead entries is how the next reviewer learns to
//    skim past it.

/** Bumped only on a breaking shape change. */
export const SUPPRESSIONS_SCHEMA = 'mendr-suppressions/v1';

export const SUPPRESSIONS_DIR = '.mendr';
export const SUPPRESSIONS_FILE = 'suppressions.json';
export const SUPPRESSIONS_RELATIVE_PATH = `${SUPPRESSIONS_DIR}/${SUPPRESSIONS_FILE}`;

/** One reviewed decision that a finding is not a dependency of this repository. */
export interface Suppression {
  /** Stable semantic id from audit/fingerprint.ts — survives a line move. */
  fingerprint: string;
  /**
   * The readable identity behind the hash, stored so a reviewer can see WHAT was suppressed
   * in the diff without running anything. Never used for matching.
   */
  identity: string;
  model: string;
  path: string;
  /** Why this is not a dependency. Required: a suppression with no argument is not reviewable. */
  reason: string;
  /** Who decided. Required for the same reason. */
  author: string;
  /** ISO date (YYYY-MM-DD). */
  createdAt: string;
  /** ISO date. Absent means it does not expire, which should be the rarer choice. */
  expiresAt?: string;
}

export interface SuppressionFile {
  schema: string;
  suppressions: Suppression[];
}

export const EMPTY_SUPPRESSIONS: SuppressionFile = {
  schema: SUPPRESSIONS_SCHEMA,
  suppressions: [],
};

/** Why a suppression did not apply on this run. */
export type InactiveReason = 'expired' | 'no_matching_finding';

export interface SuppressionOutcome {
  /** Findings a live suppression covered — reported, not actionable. */
  suppressed: { finding: Finding; suppression: Suppression }[];
  /** Findings nothing suppressed: the actionable set. */
  active: Finding[];
  /** Suppressions that did NOT apply, and why. */
  inactive: { suppression: Suppression; reason: InactiveReason }[];
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Parse a suppression file defensively.
 *
 * An unreadable or malformed file yields NO suppressions rather than throwing, because the
 * failure mode of a parse error must be "every finding is reported", never "the audit dies" and
 * never "everything is suppressed". Individual malformed entries are dropped the same way: a
 * record missing a reason or an author is not a reviewed decision, so it does not get to hide a
 * finding.
 */
export function parseSuppressions(text: string): SuppressionFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_SUPPRESSIONS;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_SUPPRESSIONS;
  const list = (raw as { suppressions?: unknown }).suppressions;
  if (!Array.isArray(list)) return EMPTY_SUPPRESSIONS;
  const suppressions: Suppression[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.fingerprint !== 'string' || !s.fingerprint) continue;
    if (typeof s.reason !== 'string' || !s.reason.trim()) continue;
    if (typeof s.author !== 'string' || !s.author.trim()) continue;
    if (!isIsoDate(s.createdAt)) continue;
    if (s.expiresAt !== undefined && !isIsoDate(s.expiresAt)) continue;
    suppressions.push({
      fingerprint: s.fingerprint,
      identity: typeof s.identity === 'string' ? s.identity : '',
      model: typeof s.model === 'string' ? s.model : '',
      path: typeof s.path === 'string' ? s.path : '',
      reason: s.reason.trim(),
      author: s.author.trim(),
      createdAt: s.createdAt,
      ...(s.expiresAt === undefined ? {} : { expiresAt: s.expiresAt as string }),
    });
  }
  return { schema: typeof (raw as { schema?: unknown }).schema === 'string'
    ? ((raw as { schema: string }).schema)
    : SUPPRESSIONS_SCHEMA, suppressions };
}

export function loadSuppressions(repoPath: string): SuppressionFile {
  const p = join(repoPath, SUPPRESSIONS_DIR, SUPPRESSIONS_FILE);
  if (!existsSync(p)) return EMPTY_SUPPRESSIONS;
  try {
    return parseSuppressions(readFileSync(p, 'utf8'));
  } catch {
    return EMPTY_SUPPRESSIONS;
  }
}

/** Write the file, sorted, so re-running on an unchanged repo produces no diff. */
export function saveSuppressions(repoPath: string, file: SuppressionFile): string {
  const p = join(repoPath, SUPPRESSIONS_DIR, SUPPRESSIONS_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const sorted = [...file.suppressions].sort((a, b) =>
    a.path === b.path ? a.fingerprint.localeCompare(b.fingerprint) : a.path.localeCompare(b.path),
  );
  writeFileSync(p, `${JSON.stringify({ schema: file.schema, suppressions: sorted }, null, 2)}\n`, 'utf8');
  return p;
}

/** Expired relative to `today` (YYYY-MM-DD). A suppression expires AFTER its date. */
export function isExpired(s: Suppression, today: string): boolean {
  return s.expiresAt !== undefined && s.expiresAt < today;
}

/**
 * Split findings into suppressed and active, and report every suppression that did not apply.
 *
 * Note what this function is NOT given: the conclusion. Suppression is applied to the actionable
 * set only, after the verdict has been computed, so no arrangement of this file can turn an
 * exposure into a clean result.
 */
export function applySuppressions(
  findings: readonly Finding[],
  file: SuppressionFile,
  today: string,
): SuppressionOutcome {
  const byFingerprint = new Map<string, Finding>();
  for (const f of findings) byFingerprint.set(f.fingerprint, f);

  const suppressed: SuppressionOutcome['suppressed'] = [];
  const inactive: SuppressionOutcome['inactive'] = [];
  const covered = new Set<string>();

  for (const s of file.suppressions) {
    if (isExpired(s, today)) {
      inactive.push({ suppression: s, reason: 'expired' });
      continue;
    }
    const finding = byFingerprint.get(s.fingerprint);
    if (!finding) {
      inactive.push({ suppression: s, reason: 'no_matching_finding' });
      continue;
    }
    suppressed.push({ finding, suppression: s });
    covered.add(s.fingerprint);
  }

  return {
    suppressed,
    active: findings.filter((f) => !covered.has(f.fingerprint)),
    inactive,
  };
}

/**
 * The lines the report prints. Always printed when anything is suppressed — there is no quiet
 * mode, because a suppression the reader cannot see is indistinguishable from a missed finding.
 */
export function formatSuppressionLines(outcome: SuppressionOutcome, today: string): string[] {
  const out: string[] = [];
  if (outcome.suppressed.length > 0) {
    out.push(
      `Suppressed (${outcome.suppressed.length}) — reported, not actionable. ` +
        'A suppression never makes a run read as clean.',
    );
    for (const { finding, suppression } of outcome.suppressed) {
      const until = suppression.expiresAt
        ? ` · expires ${suppression.expiresAt}${suppression.expiresAt === today ? ' (today — last run it applies)' : ''}`
        : ' · no expiry';
      out.push(
        `  ${finding.path}${finding.lines.length ? `:${finding.lines[0]}` : ''} ` +
          `${finding.model} — "${suppression.reason}" — ${suppression.author}, ${suppression.createdAt}${until}`,
      );
    }
  }
  const expired = outcome.inactive.filter((i) => i.reason === 'expired');
  if (expired.length > 0) {
    out.push(
      `Expired suppressions (${expired.length}) — these findings are ACTIONABLE again:`,
    );
    for (const { suppression: s } of expired) {
      out.push(`  ${s.path} ${s.model} — expired ${s.expiresAt} — was "${s.reason}" (${s.author})`);
    }
  }
  const stale = outcome.inactive.filter((i) => i.reason === 'no_matching_finding');
  if (stale.length > 0) {
    out.push(
      `Stale suppressions (${stale.length}) — no finding matches these any more; delete them from ` +
        `${SUPPRESSIONS_RELATIVE_PATH}:`,
    );
    for (const { suppression: s } of stale) {
      out.push(`  ${s.path} ${s.model} — "${s.reason}" (${s.author}, ${s.createdAt})`);
    }
  }
  return out;
}
