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
      const q = new URLSearchParams({ start_time: String(unix(range.start)), bucket_width: '1d', limit: '180' });
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
      end_time: String(unix(range.end)),
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
  return [...byModel.entries()].map(([model, v]) => ({
    provider: 'openai' as Provider,
    model,
    requests: v.requests,
    inputTokens: v.input,
    outputTokens: v.output,
    costUsd: costs.get(model) ?? 0,
  }));
}

// --- Anthropic --------------------------------------------------------------
// Usage: GET /v1/organization/usage_report/messages (Admin key, x-api-key).

export async function fetchAnthropicUsage(apiKey: string, range: UsageRange): Promise<UsageRow[]> {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const byModel = new Map<string, { requests: number; input: number; output: number }>();
  let page: string | undefined;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({ starting_at: `${range.start}T00:00:00Z`, ending_at: `${range.end}T00:00:00Z`, bucket_width: '1d' });
    q.append('group_by[]', 'model');
    if (page) q.set('page', page);
    const body = (await getJson(`https://api.anthropic.com/v1/organization/usage_report/messages?${q}`, headers)) as {
      data?: Array<{ results?: Array<{ model?: string; uncached_input_tokens?: number; input_tokens?: number; output_tokens?: number }> }>;
      has_more?: boolean;
      next_page?: string;
    };
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) {
        const model = r.model;
        if (!model) continue;
        const acc = byModel.get(model) ?? { requests: 0, input: 0, output: 0 };
        acc.requests += 1; // the messages report is token-centric; requests approximated per result row
        acc.input += num(r.uncached_input_tokens ?? r.input_tokens);
        acc.output += num(r.output_tokens);
        byModel.set(model, acc);
      }
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return [...byModel.entries()].map(([model, v]) => ({
    provider: 'anthropic' as Provider,
    model,
    requests: v.requests,
    inputTokens: v.input,
    outputTokens: v.output,
    costUsd: 0, // cost_report join left for a follow-up; usage stands alone
  }));
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
