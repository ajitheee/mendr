// mendr: model-catalog
// (This file IS Mendr's deprecation knowledge base — the annotation above makes
// self-scans report it as expected registry content instead of model-id debt.)
//
// Registry verification — the live oracle-fetch layer.
//
// Thin, impure counterpart to the pure classifier (verify.ts). It formalizes the
// registry-verify spike's fetch of two PUBLIC catalogs (no API keys) into a
// normalized `liveIds` set, and supplies the curated `officialRecommendations`
// table. Keeping fetch here means classifyEntry stays pure and testable.
//
//   models.dev  (PRIMARY)   https://models.dev/api.json
//       dash-style ids, per-provider, INCLUDING dated snapshots.
//   OpenRouter  (corroborating) https://openrouter.ai/api/v1/models
//       namespaced + dotted ids, with `~` aliases and `:variant` suffixes.

import type { VerificationOracles } from './verify.js';
import { canonicalizeId, familyOf } from './normalize.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

/** First-party providers we verify against; third-party hosts are ignored. */
export const ORACLE_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type OracleProvider = (typeof ORACLE_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// CURATED official recommendation table (captured 2026-08-15 by the
// registry-verify spike, from each provider's OWN deprecation docs).
//
// TODO(Maintainer): auto-ingest the provider deprecation tables (Anthropic
// platform docs, OpenAI deprecations page, Google model-versions) so this stays
// current without a human edit. We deliberately do NOT live-scrape provider HTML
// in this run — that markup is fragile and would make the classifier flaky.
//
// A KEY's presence ALSO marks that id as deprecated, which is what lets
// classifyEntry detect a chained deprecation (a replacement that is itself a key
// here). That is why `gpt-3.5-turbo-instruct` is listed: not because the
// registry deprecates it, but so a mapping INTO it is flagged as chained.
// ---------------------------------------------------------------------------
const CURATED_OFFICIAL: Record<OracleProvider, Record<string, string>> = {
  anthropic: {
    'claude-opus-4-1-20250805': 'claude-opus-4-8',
    'claude-opus-4-20250514': 'claude-opus-4-8',
    'claude-opus-4-5-20251101': 'claude-opus-4-8',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
    'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    'claude-3-opus-20240229': 'claude-opus-4-8',
    'claude-3-sonnet-20240229': 'claude-sonnet-4-6',
  },
  openai: {
    'gpt-4-0613': 'gpt-5.6-sol',
    'o1-preview': 'o3',
    'o1-mini': 'o4-mini',
    'gpt-4-32k': 'gpt-4o',
    'gpt-3.5-turbo-0613': 'gpt-3.5-turbo',
    'text-moderation-007': 'omni-moderation',
    // Itself deprecated (shutdown 2026-09-28) — a mapping INTO it is chained.
    'gpt-3.5-turbo-instruct': 'gpt-5.6-terra',
  },
  google: {},
};

/**
 * Build the official recommendation map the classifier consumes: canonical
 * deprecated id -> raw recommended id (raw kept for human-readable reasons; the
 * classifier canonicalizes at comparison time).
 */
export function officialRecommendations(): Map<string, string> {
  const map = new Map<string, string>();
  for (const provider of ORACLE_PROVIDERS) {
    for (const [deprecated, recommended] of Object.entries(CURATED_OFFICIAL[provider])) {
      map.set(canonicalizeId(deprecated), recommended);
    }
  }
  return map;
}

/**
 * Expand a catalog id into the forms the classifier looks up and add them to
 * `set`: the canonical id AND its family (bare-alias) form. Adding both means a
 * later bare-vs-dated lookup resolves via plain set membership.
 */
export function addLiveId(set: Set<string>, rawId: string): void {
  const canonical = canonicalizeId(rawId);
  if (!canonical) return;
  set.add(canonical);
  set.add(familyOf(canonical));
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Options for the fetch layer (a `fetchImpl` seam keeps it swappable in tests). */
export interface FetchOptions {
  fetchImpl?: typeof fetch;
}

/** The normalized live-id set plus which oracles responded and diagnostic notes. */
export interface LiveIdsResult {
  liveIds: Set<string>;
  sources: string[];
  notes: string[];
}

/**
 * Fetch both public catalogs and fold every first-party model id into one
 * normalized `liveIds` set. A single failing oracle is tolerated (noted, not
 * thrown) as long as the other responds — corroboration, not a hard dependency.
 */
export async function fetchLiveIds(opts: FetchOptions = {}): Promise<LiveIdsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const liveIds = new Set<string>();
  const sources: string[] = [];
  const notes: string[] = [];
  const providerSet: ReadonlySet<string> = new Set<string>(ORACLE_PROVIDERS);

  // --- OpenRouter (corroborating) ---
  try {
    const payload = (await fetchJson(OPENROUTER_URL, fetchImpl)) as { data?: unknown[] } | unknown[];
    const arr = (Array.isArray(payload) ? payload : payload.data ?? []) as { id: string }[];
    let firstParty = 0;
    for (const model of arr) {
      const stripped = String(model.id).replace(/^~/, '').split(':')[0];
      const slash = stripped.indexOf('/');
      if (slash < 0) continue;
      if (!providerSet.has(stripped.slice(0, slash))) continue; // ignore third-party hosts
      addLiveId(liveIds, stripped.slice(slash + 1));
      firstParty++;
    }
    sources.push('openrouter');
    notes.push(`openrouter: ${arr.length} models (${firstParty} first-party)`);
  } catch (err) {
    notes.push(`openrouter FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- models.dev (PRIMARY) ---
  try {
    const md = (await fetchJson(MODELS_DEV_URL, fetchImpl)) as Record<
      string,
      { models?: Record<string, unknown> }
    >;
    let count = 0;
    for (const provider of ORACLE_PROVIDERS) {
      const models = md[provider]?.models;
      if (!models) continue;
      for (const id of Object.keys(models)) {
        addLiveId(liveIds, id);
        count++;
      }
    }
    sources.push('models.dev');
    notes.push(`models.dev: ${count} first-party models`);
  } catch (err) {
    notes.push(`models.dev FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { liveIds, sources, notes };
}

/** The complete oracle bundle: live ids + curated recommendations + diagnostics. */
export interface Oracles extends VerificationOracles {
  liveIds: Set<string>;
  officialRecommendations: Map<string, string>;
  sources: string[];
  notes: string[];
}

/** Fetch the live catalogs and pair them with the curated recommendation table. */
export async function fetchOracles(opts: FetchOptions = {}): Promise<Oracles> {
  const { liveIds, sources, notes } = await fetchLiveIds(opts);
  return { liveIds, officialRecommendations: officialRecommendations(), sources, notes };
}
