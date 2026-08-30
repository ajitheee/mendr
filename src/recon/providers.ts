// Provider usage/cost fetchers + the fixture loader.
//
// READ-ONLY: only GET usage/cost endpoints; never invokes a model, never moves
// money, never reads prompts. Keys come from the caller (an env var), never an
// inline CLI argument. Endpoints/response shapes follow each provider's documented
// org usage API as of authoring — these APIs are new and evolving, so parsing is
// DEFENSIVE (tolerate missing fields) and should be verified against the live API.

import { readFileSync } from 'node:fs';
import type { Provider, UsageRow } from './types.js';

export interface UsageRange {
  /** ISO date (YYYY-MM-DD) inclusive start. */
  start: string;
  /** ISO date (YYYY-MM-DD) inclusive end. */
  end: string;
}

const unix = (isoDate: string): number => Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const DAY_SECONDS = 86_400;

/**
 * Both providers define their END bound as EXCLUSIVE, but {@link UsageRange.end}
 * is documented (and used) as an INCLUSIVE calendar day. Without this the final
 * day of the window is silently dropped and every total reads one day short of
 * the provider's own dashboard — the exact failure that makes a reconciliation
 * look like a bug in the tool.
 */
const exclusiveEndUnix = (isoDate: string): number => unix(isoDate) + DAY_SECONDS;

/** The same exclusive-end rule as an RFC-3339 timestamp (Anthropic's format). */
function exclusiveEndIso(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
}

/**
 * What a provider's usage read does NOT cover. Printed in the audit's coverage
 * report so an unqueried category is disclosed rather than silently read as
 * "no usage" — a dashboard total that exceeds mendr must be explainable.
 */
export function providerCoverageNotes(provider: Provider): string[] {
  if (provider === 'openai') {
    return [
      'Chat Completions + Responses only. Embeddings, images, moderations, audio (speech/transcription), ' +
        'vector stores, code interpreter, and file/web-search usage are NOT queried.',
      'Requests/tokens come from the Usage API; cost comes from the Costs API — OpenAI states these two ' +
        'ledgers may not tie out exactly. Only the Costs figure reconciles to the invoice.',
    ];
  }
  if (provider === 'anthropic') {
    return [
      'Anthropic\'s usage API reports NO request count — the requests column is not available for Anthropic ' +
        'and is reported as 0, not measured. Token and cost figures are real.',
      'Input tokens sum uncached + cache-read + cache-creation buckets (these price differently).',
      'Priority Tier spend is excluded from the cost report and will not reconcile from it alone.',
    ];
  }
  return ['Google/Vertex usage has no simple read endpoint (Cloud Billing BigQuery export) — not implemented.'];
}

/** Redact any credential-looking token from a string before it reaches a log/error. */
function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_.-]{6,}/g, 'sk-***')
    .replace(/(bearer|x-api-key|authorization)([:=]?\s*)\S+/gi, '$1$2***');
}

/** Fetch JSON with a hard timeout; throws a friendly, credential-redacted error on failure. */
async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`request failed: ${redact(err instanceof Error ? err.message : String(err))}`);
  }
  if (!res.ok) {
    const body = redact((await res.text().catch(() => '')).slice(0, 300));
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `authentication failed (${res.status}) — the key must be a READ-ONLY usage/cost Admin key with org access.${body ? ` ${body}` : ''}`,
      );
    }
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

// --- OpenAI -----------------------------------------------------------------
// Usage: GET /v1/organization/usage/completions (Admin key). Buckets carry
// per-model results. Cost: GET /v1/organization/costs, line_item ~ "<model>, <kind>".

async function fetchOpenAiCosts(apiKey: string, range: UsageRange): Promise<Map<string, number>> {
  const byModel = new Map<string, number>();
  try {
    let page: string | undefined;
    for (let i = 0; i < 40; i++) {
      // end_time is REQUIRED here: without it the costs query runs to "now",
      // summing spend from outside the audited window into per-model cost.
      const q = new URLSearchParams({
        start_time: String(unix(range.start)),
        end_time: String(exclusiveEndUnix(range.end)),
        bucket_width: '1d',
        limit: '180',
      });
      q.append('group_by[]', 'line_item');
      if (page) q.set('page', page);
      const body = (await getJson(`https://api.openai.com/v1/organization/costs?${q}`, {
        Authorization: `Bearer ${apiKey}`,
      })) as { data?: Array<{ results?: Array<{ amount?: { value?: number }; line_item?: string }> }>; has_more?: boolean; next_page?: string };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) {
          const model = (r.line_item ?? '').split(',')[0].trim();
          if (model) byModel.set(model, (byModel.get(model) ?? 0) + num(r.amount?.value));
        }
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
  } catch {
    // Cost is best-effort — usage (requests/tokens) still stands without it.
  }
  return byModel;
}

export async function fetchOpenAiUsage(apiKey: string, range: UsageRange): Promise<UsageRow[]> {
  const byModel = new Map<string, { requests: number; input: number; output: number }>();
  let page: string | undefined;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({
      start_time: String(unix(range.start)),
      // Exclusive upper bound — see exclusiveEndUnix. Passing unix(end) directly
      // dropped the whole final day of the requested (inclusive) range.
      end_time: String(exclusiveEndUnix(range.end)),
      bucket_width: '1d',
      limit: '31',
    });
    q.append('group_by[]', 'model');
    if (page) q.set('page', page);
    const body = (await getJson(`https://api.openai.com/v1/organization/usage/completions?${q}`, {
      Authorization: `Bearer ${apiKey}`,
    })) as {
      data?: Array<{ results?: Array<{ model?: string; num_model_requests?: number; input_tokens?: number; output_tokens?: number }> }>;
      has_more?: boolean;
      next_page?: string;
    };
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) {
        const model = r.model;
        if (!model) continue;
        const acc = byModel.get(model) ?? { requests: 0, input: 0, output: 0 };
        acc.requests += num(r.num_model_requests);
        acc.input += num(r.input_tokens);
        acc.output += num(r.output_tokens);
        byModel.set(model, acc);
      }
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  const costs = await fetchOpenAiCosts(apiKey, range);
  const rows: UsageRow[] = [...byModel.entries()].map(([model, v]) => ({
    provider: 'openai' as Provider,
    model,
    requests: v.requests,
    inputTokens: v.input,
    outputTokens: v.output,
    costUsd: costs.get(model) ?? 0,
  }));
  // The Costs API covers EVERY category; the completions Usage API covers one.
  // Spend on a model that never appears in completions usage (an embedding, TTS,
  // or image model) previously had no row to attach to and was silently dropped,
  // pushing the reported total below the invoice. Emit it as a cost-only row so
  // the dollar total reconciles to the /costs endpoint.
  const seen = new Set(rows.map((r) => r.model));
  for (const [model, costUsd] of costs) {
    if (seen.has(model) || costUsd === 0) continue;
    rows.push({ provider: 'openai', model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd });
  }
  return rows;
}

// --- Anthropic --------------------------------------------------------------
// Usage: GET /v1/organization/usage_report/messages (Admin key, x-api-key).

/** One Anthropic usage result row (only the fields the API actually returns). */
interface AnthropicUsageResult {
  model?: string;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  output_tokens?: number;
}

/**
 * Total input tokens: uncached + cache-read + both cache-creation buckets. Summing
 * only `uncached_input_tokens` undercounts every cached prompt, which is most of
 * the traffic on a caching workload.
 */
function anthropicInputTokens(r: AnthropicUsageResult): number {
  return (
    num(r.uncached_input_tokens) +
    num(r.cache_read_input_tokens) +
    num(r.cache_creation?.ephemeral_1h_input_tokens) +
    num(r.cache_creation?.ephemeral_5m_input_tokens)
  );
}

/**
 * Per-model spend from the Cost Report. Amounts arrive as a decimal STRING in the
 * lowest currency unit (cents), so they are divided by 100 — unlike OpenAI, whose
 * amount.value is already USD.
 */
async function fetchAnthropicCosts(
  apiKey: string,
  range: UsageRange,
  headers: Record<string, string>,
): Promise<Map<string, number>> {
  const byModel = new Map<string, number>();
  try {
    let page: string | undefined;
    for (let i = 0; i < 40; i++) {
      const q = new URLSearchParams({
        starting_at: `${range.start}T00:00:00Z`,
        ending_at: exclusiveEndIso(range.end),
        bucket_width: '1d',
        limit: '31',
      });
      q.append('group_by[]', 'description');
      if (page) q.set('page', page);
      const body = (await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, headers)) as {
        data?: Array<{ results?: Array<{ model?: string; amount?: string | number; currency?: string }> }>;
        has_more?: boolean;
        next_page?: string;
      };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) {
          const model = r.model;
          if (!model) continue;
          const cents = typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount ?? '0'));
          if (!Number.isFinite(cents)) continue;
          byModel.set(model, (byModel.get(model) ?? 0) + cents / 100);
        }
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
  } catch {
    // Cost is best-effort — token usage still stands without it.
  }
  return byModel;
}

export async function fetchAnthropicUsage(apiKey: string, range: UsageRange): Promise<UsageRow[]> {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const byModel = new Map<string, { input: number; output: number }>();
  let page: string | undefined;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({
      starting_at: `${range.start}T00:00:00Z`,
      ending_at: exclusiveEndIso(range.end), // exclusive — see exclusiveEndIso
      bucket_width: '1d',
      limit: '31', // default is 7 buckets/page; a month then costs ~5 round-trips
    });
    q.append('group_by[]', 'model');
    if (page) q.set('page', page);
    // NOTE the PLURAL `organizations` — the singular form 404s (OpenAI uses the
    // singular; copying it here made every Anthropic read return nothing).
    const body = (await getJson(`https://api.anthropic.com/v1/organizations/usage_report/messages?${q}`, headers)) as {
      data?: Array<{ results?: AnthropicUsageResult[] }>;
      has_more?: boolean;
      next_page?: string;
    };
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) {
        const model = r.model;
        if (!model) continue;
        const acc = byModel.get(model) ?? { input: 0, output: 0 };
        acc.input += anthropicInputTokens(r);
        acc.output += num(r.output_tokens);
        byModel.set(model, acc);
      }
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  const costs = await fetchAnthropicCosts(apiKey, range, headers);
  const rows: UsageRow[] = [...byModel.entries()].map(([model, v]) => ({
    provider: 'anthropic' as Provider,
    model,
    // The Messages Usage Report has NO request-count field. Reporting 0 (and
    // disclosing it in providerCoverageNotes) beats the old `+= 1` per result
    // row, which produced roughly (days x groups) and looked like a real count.
    requests: 0,
    inputTokens: v.input,
    outputTokens: v.output,
    costUsd: costs.get(model) ?? 0,
  }));
  const seen = new Set(rows.map((r) => r.model));
  for (const [model, costUsd] of costs) {
    if (seen.has(model) || costUsd === 0) continue;
    rows.push({ provider: 'anthropic', model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd });
  }
  return rows;
}

/** Dispatch to a provider fetcher. Google/Vertex has no simple usage endpoint (BigQuery billing export) — not in the prototype. */
export async function fetchProviderUsage(provider: Provider, apiKey: string, range: UsageRange): Promise<UsageRow[]> {
  if (provider === 'openai') return fetchOpenAiUsage(apiKey, range);
  if (provider === 'anthropic') return fetchAnthropicUsage(apiKey, range);
  throw new Error(
    'google/vertex usage has no simple read endpoint (it comes from the Cloud Billing BigQuery export) — not implemented in this prototype. Use --fixture, or an openai/anthropic key.',
  );
}

/** Load usage rows from a fixture JSON file (an array of UsageRow) — the demo/test path, no key needed. */
export function loadFixtureUsage(path: string): UsageRow[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`usage fixture at ${path} must be a JSON array of usage rows`);
  return parsed.map((r, i) => {
    if (typeof r?.provider !== 'string' || typeof r?.model !== 'string') {
      throw new Error(`usage fixture row #${i} needs a string "provider" and "model"`);
    }
    return {
      provider: r.provider as Provider,
      model: r.model,
      requests: num(r.requests),
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      costUsd: num(r.costUsd),
    };
  });
}
