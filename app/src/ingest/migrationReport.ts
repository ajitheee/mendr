import { redactSecrets } from '../redact.js';

// The second document the App accepts: what mendr-action DID, sent from the
// customer's own CI run (schema mendr-migration-report/v1): outcome, PR url,
// verdict, the four gate statuses, the model swaps and the file paths they
// touch, and — unless the action was told not to send it — the unified diff of
// the swap itself, so the finding can show what changes. The diff is the
// change, never whole files; it is redacted and capped here again.
//
// Unlike the audit report, this one is WHITELISTED field by field: anything not
// named here is dropped, every string is redacted and capped, every list is
// capped.

export const MIGRATION_REPORT_SCHEMA = 'mendr-migration-report/v1';
export const MIGRATION_OUTCOMES = ['clean', 'migration-proposed', 'not-verified', 'error'] as const;
export type MigrationOutcome = (typeof MIGRATION_OUTCOMES)[number];
export const MIGRATION_VERDICTS = ['verified', 'failed', 'inconclusive', 'no_migration'] as const;
export type MigrationVerdict = (typeof MIGRATION_VERDICTS)[number];
export const GATE_STATUSES = ['pass', 'fail', 'inconclusive', 'not-configured'] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const MAX_MIGRATIONS = 100;
export const MAX_FILES = 200;
export const MAX_NOTES = 20;
export const MAX_TEXT_CHARS = 400;
/** The diff of a model-id swap is a few lines per site; this cap is generous and keeps a report bounded. */
export const MAX_DIFF_CHARS = 100_000;

export interface MigrationGates {
  typeCheck: GateStatus;
  build: GateStatus;
  tests: GateStatus;
  eval: GateStatus;
}

/** Which registry the migration was planned against, and how current it was. */
export interface MigrationRegistryInfo {
  source: 'snapshot' | 'file' | 'bundled';
  version: string;
  publishedAt: string | null;
  /** Days old at planning time; -1 = unknown. */
  ageDays: number;
  maxAgeDays: number;
  freshness: 'fresh' | 'stale';
}

export interface MigrationSwap {
  provider: string;
  from: string;
  to: string;
  language: string;
  sites: number;
  files: string[];
}

export interface MigrationReport {
  schema: typeof MIGRATION_REPORT_SCHEMA;
  outcome: MigrationOutcome;
  /** The PR mendr-action opened or updated; null unless a verified migration was proposed. */
  prUrl: string | null;
  sha: string | null;
  generatedAt: string | null;
  verdict: MigrationVerdict | null;
  gates: MigrationGates | null;
  behavioralTested: boolean;
  migrations: MigrationSwap[];
  changedFiles: string[];
  notes: string[];
  /**
   * The unified diff of the swap — the change itself, for display on the
   * finding. Redacted and capped; null when the action withheld it (`send-diff:
   * 'false'`), nothing changed, or what arrived was not a diff.
   */
  diff: string | null;
  /** Which registry the migration was planned against (null: an older action did not say). */
  registry?: MigrationRegistryInfo | null;
}

export type MigrationValidation = { ok: true; report: MigrationReport } | { ok: false; status: 400 | 413; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const clipped = v.length > MAX_TEXT_CHARS ? v.slice(0, MAX_TEXT_CHARS) : v;
  return redactSecrets(clipped);
}

function texts(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = text(x);
    if (t !== null) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function oneOf<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}

/** The registry provenance, field by field; anything malformed is dropped whole. */
function registryInfo(v: unknown): MigrationRegistryInfo | null {
  if (!isRecord(v)) return null;
  const source = oneOf(v.source, ['snapshot', 'file', 'bundled'] as const);
  const freshness = oneOf(v.freshness, ['fresh', 'stale'] as const);
  const version = text(v.version);
  if (!source || !freshness || !version) return null;
  const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : fallback);
  const publishedAt = typeof v.publishedAt === 'string' && !Number.isNaN(Date.parse(v.publishedAt)) ? v.publishedAt : null;
  return { source, version, publishedAt, ageDays: num(v.ageDays, -1), maxAgeDays: num(v.maxAgeDays, 0), freshness };
}

/** Only a unified diff is kept — something that starts like one — redacted, and capped with a visible mark. */
function diffText(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  if (!/^(diff --git |--- |\+\+\+ |Index: )/m.test(v.slice(0, 400))) return null;
  const capped = v.length > MAX_DIFF_CHARS ? `${v.slice(0, MAX_DIFF_CHARS)}\n… (truncated by Mendr at ${MAX_DIFF_CHARS} characters)` : v;
  return redactSecrets(capped);
}

const PR_URL = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

/**
 * Parse, validate and sanitize a migration report in one pass. The returned
 * document contains only the whitelisted fields, redacted and capped.
 */
export function validateMigrationReport(raw: string, maxBytes: number): MigrationValidation {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { ok: false, status: 413, message: `report exceeds ${maxBytes} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: 'body is not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, status: 400, message: 'body is not a JSON object' };
  if (parsed.schema !== MIGRATION_REPORT_SCHEMA) return { ok: false, status: 400, message: `schema must be ${MIGRATION_REPORT_SCHEMA}` };
  const outcome = oneOf(parsed.outcome, MIGRATION_OUTCOMES);
  if (!outcome) return { ok: false, status: 400, message: 'outcome is not a mendr-action outcome' };

  const prUrlRaw = typeof parsed.prUrl === 'string' ? parsed.prUrl.trim() : null;
  if (prUrlRaw !== null && prUrlRaw !== '' && !PR_URL.test(prUrlRaw)) return { ok: false, status: 400, message: 'prUrl is not a pull request URL' };
  const prUrl = prUrlRaw ? prUrlRaw : null;

  const sha = typeof parsed.sha === 'string' && /^[0-9a-f]{40}$/.test(parsed.sha) ? parsed.sha : null;
  const generatedAt = typeof parsed.generatedAt === 'string' && !Number.isNaN(Date.parse(parsed.generatedAt)) ? parsed.generatedAt : null;
  const verdict = oneOf(parsed.verdict, MIGRATION_VERDICTS);

  let gates: MigrationGates | null = null;
  if (isRecord(parsed.gates)) {
    const g = (k: string): GateStatus => oneOf(parsed.gates && (parsed.gates as Record<string, unknown>)[k], GATE_STATUSES) ?? 'not-configured';
    gates = { typeCheck: g('typeCheck'), build: g('build'), tests: g('tests'), eval: g('eval') };
  }

  const migrations: MigrationSwap[] = [];
  if (Array.isArray(parsed.migrations)) {
    for (const m of parsed.migrations) {
      if (!isRecord(m)) continue;
      const provider = text(m.provider);
      const from = text(m.from);
      const to = text(m.to);
      if (!provider || !from || !to) continue;
      migrations.push({
        provider,
        from,
        to,
        language: text(m.language) ?? 'unknown',
        sites: Number.isInteger(m.sites) && (m.sites as number) >= 0 ? (m.sites as number) : 0,
        files: texts(m.files, MAX_FILES),
      });
      if (migrations.length >= MAX_MIGRATIONS) break;
    }
  }

  return {
    ok: true,
    report: {
      schema: MIGRATION_REPORT_SCHEMA,
      outcome,
      prUrl,
      sha,
      generatedAt,
      verdict,
      gates,
      behavioralTested: parsed.behavioralTested === true,
      migrations,
      changedFiles: texts(parsed.changedFiles, MAX_FILES),
      notes: texts(parsed.notes, MAX_NOTES),
      diff: diffText(parsed.diff),
      registry: registryInfo(parsed.registry),
    },
  };
}

/** `#12` from a pull request URL, or '' when it does not parse. */
export function prNumber(prUrl: string): string {
  const m = /\/pull\/(\d+)$/.exec(prUrl);
  return m ? `#${m[1]}` : '';
}
