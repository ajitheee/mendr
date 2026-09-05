import { redactSecrets } from '../redact.js';

// The App accepts exactly one document: the CLI's `mendr audit --json` output
// (schema mendr-audit/v3). It validates the shape it relies on, then
// sanitizes the WHOLE document before anything is stored: every string is
// passed through the same secret redaction the CLI uses, snippets are capped
// to the CLI's own limits (7 lines, 160 chars), and nothing else is trusted
// to have been done client-side.

export const SCHEMA = 'mendr-audit/v3';
export const SNIPPET_MAX_LINES = 7;
export const SNIPPET_MAX_CHARS = 161; // 160 + the CLI's ellipsis
export const STRING_MAX_CHARS = 4000;

export type Decision = 'patch' | 'review' | 'monitor';
export const CONCLUSIONS = ['exposure_detected', 'no_exposure_in_completed_surfaces', 'inconclusive', 'audit_failed'] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

export interface Snippet {
  startLine: number;
  lines: string[];
}

export interface Location {
  file: string;
  line: number;
  column?: number;
  key?: string | null;
  value?: string;
  role?: string;
  surface?: string;
  tier?: string;
  disposition?: string;
  reason?: string;
  patchEligible?: boolean;
  providerSurface?: string | null;
  snippet?: Snippet | null;
  lineHash?: string | null;
  /** Config selectors: evidence that code reads this selector (reader tie-back). */
  readerTieBack?: { proven?: boolean; readers?: { file: string; line: number; via?: string }[] } | null;
  [k: string]: unknown;
}

export interface Investigation {
  provider: string;
  model: string;
  decision: Decision;
  reason?: string;
  nextAction?: string | null;
  entryId?: string | null;
  retirementEvidence?: {
    status?: string | null;
    shutdownDate?: string | null;
    daysUntil?: number | null;
    replacement?: string | null;
    replacementVerdict?: string | null;
    sourceUrl?: string | null;
  } | null;
  productionUsage?: string;
  verification?: { readerTieBackProven?: boolean } | null;
  locations: { selectors: Location[]; catalog: Location[] };
  [k: string]: unknown;
}

export interface AuditReport {
  schema: typeof SCHEMA;
  repo?: string;
  generatedAt?: string;
  sha?: string | null;
  conclusion: Conclusion;
  coverage?: unknown;
  investigations: Investigation[];
  [k: string]: unknown;
}

export type Validation = { ok: true; report: AuditReport } | { ok: false; status: 400 | 413; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validLocation(l: unknown): l is Location {
  return isRecord(l) && typeof l.file === 'string' && l.file.length > 0 && Number.isInteger(l.line) && (l.line as number) >= 1;
}

export function validateReport(raw: string, maxBytes: number): Validation {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { ok: false, status: 413, message: `report exceeds ${maxBytes} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: 'body is not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, status: 400, message: 'body is not a JSON object' };
  if (parsed.schema !== SCHEMA) return { ok: false, status: 400, message: `schema must be ${SCHEMA} (mendr audit --json)` };
  if (!CONCLUSIONS.includes(parsed.conclusion as Conclusion)) return { ok: false, status: 400, message: 'conclusion is not an audit conclusion' };
  if (!Array.isArray(parsed.investigations)) return { ok: false, status: 400, message: 'investigations must be an array' };
  for (const [i, inv] of parsed.investigations.entries()) {
    if (!isRecord(inv)) return { ok: false, status: 400, message: `investigation ${i} is not an object` };
    if (typeof inv.provider !== 'string' || typeof inv.model !== 'string') return { ok: false, status: 400, message: `investigation ${i} lacks provider/model` };
    if (inv.decision !== 'patch' && inv.decision !== 'review' && inv.decision !== 'monitor') return { ok: false, status: 400, message: `investigation ${i} has an unknown decision` };
    if (!isRecord(inv.locations) || !Array.isArray(inv.locations.selectors) || !Array.isArray(inv.locations.catalog)) {
      return { ok: false, status: 400, message: `investigation ${i} lacks locations.selectors/catalog` };
    }
    for (const l of [...inv.locations.selectors, ...inv.locations.catalog]) {
      if (!validLocation(l)) return { ok: false, status: 400, message: `investigation ${i} has a location without file/line` };
    }
  }
  return { ok: true, report: parsed as unknown as AuditReport };
}

function scrub(v: unknown, depth: number): unknown {
  if (depth > 32) return null;
  if (typeof v === 'string') {
    const clipped = v.length > STRING_MAX_CHARS ? v.slice(0, STRING_MAX_CHARS) : v;
    return redactSecrets(clipped);
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null;
}

function capSnippet(l: Location): Location {
  const s = l.snippet;
  if (!s || !isRecord(s) || !Array.isArray(s.lines)) return { ...l, snippet: null };
  const lines = s.lines.slice(0, SNIPPET_MAX_LINES).map((x) => (typeof x === 'string' ? (x.length > SNIPPET_MAX_CHARS ? x.slice(0, SNIPPET_MAX_CHARS) : x) : ''));
  const startLine = Number.isInteger(s.startLine) && (s.startLine as number) >= 1 ? (s.startLine as number) : l.line;
  return { ...l, snippet: { startLine, lines } };
}

/** Deep-redact every string and cap every snippet. Returns a new document. */
export function sanitizeReport(report: AuditReport): AuditReport {
  const scrubbed = scrub(report, 0) as AuditReport;
  return {
    ...scrubbed,
    investigations: scrubbed.investigations.map((inv) => ({
      ...inv,
      locations: {
        selectors: inv.locations.selectors.map(capSnippet),
        catalog: inv.locations.catalog.map(capSnippet),
      },
    })),
  };
}

export interface DecisionCounts {
  patch: number;
  review: number;
  informational: number;
}

export function countDecisions(report: AuditReport): DecisionCounts {
  const c: DecisionCounts = { patch: 0, review: 0, informational: 0 };
  for (const inv of report.investigations) {
    if (inv.decision === 'patch') c.patch++;
    else if (inv.decision === 'review') c.review++;
    else c.informational++;
  }
  return c;
}
