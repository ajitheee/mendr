// Runtime evidence — OPTIONAL proof that a located model is actually live.
//
// POSITIONING (deliberate): the entry requirement for mendr is a REPOSITORY, not
// a provider Admin key. Source + config scanning stands on its own — it finds the
// risk, the location, the deadline, and the migration evidence, and says plainly
// that runtime usage is unknown. Runtime evidence CLOSES that gap when a customer
// chooses to connect it, through whichever of these they are comfortable with:
//
//   otel           OpenTelemetry gen_ai/llm span or metric attributes
//   usage_export   a sanitized CSV/JSON the customer exports themselves
//   provider_api   a read-only Admin key the customer keeps in their own CI
//   gateway_logs   a model gateway / Sentry / Datadog / structured app log
//
// Every one is optional and every one is refusable. A customer who connects
// nothing still gets a complete, honest audit.
//
// WHAT WE READ, AND ONLY THIS: provider, model, service, environment, timestamp,
// request outcome, request volume. Never prompts, never responses, never PII.
// Cost is accepted when a source happens to carry it, but it is NOT required and
// NOT the point — customers already have billing dashboards.

import { readFileSync } from 'node:fs';
import { normalizeModelId } from '../recon/usageAudit.js';
import type { UsageAudit } from '../recon/types.js';

/** Where a runtime observation came from. */
export type RuntimeSource = 'otel' | 'usage_export' | 'provider_api' | 'gateway_logs';

/** Human labels for the coverage report. */
export const RUNTIME_SOURCE_LABEL: Record<RuntimeSource, string> = {
  otel: 'OpenTelemetry',
  usage_export: 'customer usage export',
  provider_api: 'provider usage API (read-only key)',
  gateway_logs: 'gateway / application logs',
};

/**
 * One observation of a model actually being called. The MVP-useful fields — model,
 * provider, last seen, volume, service, environment, outcome. `costUsd` is
 * optional and secondary.
 */
export interface RuntimeObservation {
  provider: string;
  /** Normalized model id (fine-tune prefix stripped) — what joins the registry. */
  model: string;
  /** The raw model string as observed, when it differed from the normalized id. */
  observed: string;
  service: string | null;
  environment: string | null;
  /** ISO timestamp of the most recent call seen for this model. */
  lastSeen: string | null;
  requests: number;
  /** True when the source reports request counts at all (Anthropic's does not). */
  requestsReported: boolean;
  failures: number;
  costUsd: number | null;
}

/** The connected runtime evidence, or the honest absence of it. */
export interface RuntimeEvidence {
  connected: boolean;
  source: RuntimeSource | null;
  observations: RuntimeObservation[];
  /** What this source does NOT cover — always disclosed. */
  notes: string[];
}

/** The default: nothing connected. A complete audit is still possible. */
export const NO_RUNTIME_EVIDENCE: RuntimeEvidence = {
  connected: false,
  source: null,
  observations: [],
  notes: [],
};

// --- field aliasing ---------------------------------------------------------
// Telemetry, exports, and gateway logs all name these differently. Accept the
// common spellings rather than forcing the customer to reshape their data.

const MODEL_KEYS = [
  'model', 'model_id', 'modelId', 'model_name', 'modelName',
  'gen_ai.request.model', 'gen_ai.response.model', 'llm.model_name', 'ai.model',
];
const PROVIDER_KEYS = ['provider', 'gen_ai.system', 'llm.vendor', 'vendor', 'system'];
const SERVICE_KEYS = ['service', 'service.name', 'service_name', 'serviceName', 'app', 'application'];
const ENV_KEYS = ['environment', 'env', 'deployment.environment', 'deployment_environment', 'stage'];
const TIME_KEYS = ['last_seen', 'lastSeen', 'timestamp', 'time', '@timestamp', 'date', 'observed_at'];
const REQUEST_KEYS = ['requests', 'request_count', 'requestCount', 'num_requests', 'num_model_requests', 'count', 'calls'];
const FAILURE_KEYS = ['failures', 'errors', 'error_count', 'failed'];
const COST_KEYS = ['cost', 'cost_usd', 'costUsd', 'amount'];

type Row = Record<string, unknown>;

function pick(row: Row, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    // case-insensitive fallback
    const hit = Object.keys(row).find((rk) => rk.toLowerCase() === k.toLowerCase());
    if (hit && row[hit] !== undefined && row[hit] !== null && row[hit] !== '') return row[hit];
  }
  return undefined;
}

const asString = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
};

const asNumber = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

/** Infer the provider from a model id when the source did not say. */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (/^(gpt|o[1-4]|text-|davinci|babbage|curie|ada|dall-e|whisper|tts|chatgpt)/.test(m)) return 'openai';
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gemini|palm|bison|text-bison|chat-bison)/.test(m)) return 'google';
  return 'unknown';
}

/** A failure count from either an explicit number or a status/outcome field. */
function failuresOf(row: Row): number {
  const explicit = pick(row, FAILURE_KEYS);
  if (explicit !== undefined) return asNumber(explicit);
  const status = asString(pick(row, ['status', 'outcome', 'result', 'http.status_code', 'status_code']));
  if (!status) return 0;
  if (/^(error|fail|failed|failure)$/i.test(status)) return 1;
  const code = parseInt(status, 10);
  if (Number.isFinite(code) && code >= 400) return 1;
  return 0;
}

/** Normalize one arbitrary row into an observation, or null when it names no model. */
export function toObservation(row: Row): RuntimeObservation | null {
  const rawModel = asString(pick(row, MODEL_KEYS));
  if (!rawModel) return null;
  const model = normalizeModelId(rawModel);
  const provider = asString(pick(row, PROVIDER_KEYS)) ?? inferProvider(model);
  const requestsRaw = pick(row, REQUEST_KEYS);
  const costRaw = pick(row, COST_KEYS);
  return {
    provider: provider.toLowerCase(),
    model,
    observed: rawModel,
    service: asString(pick(row, SERVICE_KEYS)),
    environment: asString(pick(row, ENV_KEYS)),
    lastSeen: asString(pick(row, TIME_KEYS)),
    // A log line with no count IS one request; an aggregate row carries its own.
    requests: requestsRaw === undefined ? 1 : asNumber(requestsRaw),
    requestsReported: requestsRaw !== undefined || true,
    failures: failuresOf(row),
    costUsd: costRaw === undefined ? null : asNumber(costRaw),
  };
}

/** Merge observations of the same (provider, model), summing volume, keeping the latest sighting. */
export function foldObservations(observations: readonly RuntimeObservation[]): RuntimeObservation[] {
  const byKey = new Map<string, RuntimeObservation>();
  for (const o of observations) {
    const key = `${o.provider}:${o.model}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...o, service: o.service, environment: o.environment });
      continue;
    }
    prior.requests += o.requests;
    prior.failures += o.failures;
    if (o.costUsd !== null) prior.costUsd = (prior.costUsd ?? 0) + o.costUsd;
    if (o.lastSeen && (!prior.lastSeen || o.lastSeen > prior.lastSeen)) prior.lastSeen = o.lastSeen;
    // Keep a service/environment if any row named one; multiple are joined by the caller.
    if (!prior.service && o.service) prior.service = o.service;
    if (!prior.environment && o.environment) prior.environment = o.environment;
    if (!prior.requestsReported && o.requestsReported) prior.requestsReported = true;
  }
  return [...byKey.values()].sort((a, b) => b.requests - a.requests || (a.model < b.model ? -1 : 1));
}

// --- parsing ----------------------------------------------------------------

/** A minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const row: Row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/**
 * Dig rows out of the shapes these sources actually emit: a bare array, an
 * OTel-ish `{resourceSpans|spans|data|records|results|rows}` envelope, or NDJSON.
 * OTel attribute bags are flattened so `gen_ai.request.model` is readable.
 */
function extractRows(parsed: unknown): Row[] {
  if (Array.isArray(parsed)) return parsed.map(flattenAttributes);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Row;
    for (const key of ['observations', 'rows', 'records', 'results', 'data', 'spans', 'resourceSpans', 'items']) {
      const v = obj[key];
      if (Array.isArray(v)) return v.map(flattenAttributes);
    }
    return [flattenAttributes(obj)];
  }
  return [];
}

/** Flatten `{attributes: {...}}` / `{resource: {attributes}}` / OTel kv arrays into the row. */
function flattenAttributes(item: unknown): Row {
  if (!item || typeof item !== 'object') return {};
  const row: Row = { ...(item as Row) };
  const merge = (bag: unknown): void => {
    if (!bag) return;
    if (Array.isArray(bag)) {
      // OTel KeyValue list: [{key, value:{stringValue|intValue|...}}]
      for (const kv of bag) {
        if (!kv || typeof kv !== 'object') continue;
        const k = (kv as Row).key;
        const raw = (kv as Row).value;
        if (typeof k !== 'string') continue;
        const v =
          raw && typeof raw === 'object'
            ? (Object.values(raw as Row)[0] as unknown)
            : raw;
        if (row[k] === undefined) row[k] = v;
      }
      return;
    }
    if (typeof bag === 'object') {
      for (const [k, v] of Object.entries(bag as Row)) if (row[k] === undefined) row[k] = v;
    }
  };
  merge(row.attributes);
  merge((row.resource as Row | undefined)?.attributes);
  merge(row.tags);
  merge(row.labels);
  merge(row.fields);
  return row;
}

/**
 * Load runtime evidence from a customer-provided file (Option 2 / Option 1 export
 * / Option 4 log dump). No credentials involved — the customer produces the file.
 * Accepts JSON (array or envelope), NDJSON, or CSV.
 */
export function loadRuntimeEvidenceFile(path: string, source: RuntimeSource = 'usage_export'): RuntimeEvidence {
  const text = readFileSync(path, 'utf8');
  const trimmed = text.trimStart();
  let rows: Row[];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      rows = extractRows(JSON.parse(text));
    } catch {
      // NDJSON: one JSON object per line.
      rows = text
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try { return flattenAttributes(JSON.parse(l)); } catch { return {}; }
        });
    }
  } else {
    rows = parseCsv(text);
  }

  const observations = foldObservations(rows.map(toObservation).filter((o): o is RuntimeObservation => o !== null));
  if (observations.length === 0) {
    throw new Error(
      `no model observations found in ${path}. Expected rows carrying a model id ` +
        '(model / model_id / gen_ai.request.model), optionally with provider, service, environment, ' +
        'timestamp, request count, and outcome.',
    );
  }
  return {
    connected: true,
    source,
    observations,
    notes: [
      `Runtime evidence came from a ${RUNTIME_SOURCE_LABEL[source]} file — it covers only what that ` +
        'source records. Models absent from it are NOT proven unused.',
    ],
  };
}

/** Adapt a provider-API usage audit into the same evidence shape (Option 3). */
export function runtimeEvidenceFromUsage(audit: UsageAudit, notes: readonly string[] = []): RuntimeEvidence {
  const observations = audit.models.map((f) => ({
    provider: f.provider,
    model: f.model,
    observed: f.observed,
    service: null,
    environment: null,
    lastSeen: audit.periodEnd,
    requests: f.requests,
    requestsReported: f.requests > 0 || audit.totalRequests > 0,
    failures: 0,
    costUsd: f.costUsd,
  }));
  return { connected: true, source: 'provider_api', observations, notes: [...notes] };
}
