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
//   models.dev  (PRIMARY, the ONLY liveness source)   https://models.dev/api.json
//       per-provider, keyed by the id the provider's own API takes, INCLUDING dated
//       snapshots. Its ids form `liveIds`, the set a replacement must be in to verify.
//   OpenRouter  (cautionary only)   https://openrouter.ai/api/v1/models
//       namespaced + dotted ids, with `~` aliases and `:variant` suffixes. These are
//       OpenRouter's routing names, not the providers' ids: it lists dotted Claude
//       spellings outside Anthropic's documented id format, pro "ids" OpenAI does as a
//       request setting, and ids a provider has already shut down. They form `routedIds`, which
//       can make a verdict MORE cautious (claimCheck.ts refuses a `retired` claim for an
//       id it lists) and can never make a replacement live. Until 2026-10-09 they were
//       folded into `liveIds`, so an OpenRouter-only spelling such as `gpt-6.1-sol-pro`
//       counted as a live replacement and could classify `verified`.

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
    // Added 2026-10-10 from the deprecations page (snapshot 8d440e5f7cd4), so that the gate,
    // and not a hand edit, decides these records. Without a row the classifier sees nothing to
    // contradict, and 83bba86 stamped all seven verified and auto-appliable.
    //
    // "2026-03-26 | gpt-4-0314 | gpt-5 or gpt-4.1*", and the same for gpt-4-0125-preview
    // "(including gpt-4-turbo-preview ..., which point to this snapshot)". The footnote reads
    // "*For tasks that are especially latency sensitive and don't require reasoning". That is
    // two targets, and the classifier will not pick one (verify.ts, namedReplacements).
    'gpt-4-0314': 'gpt-5 or gpt-4.1',
    'gpt-4-0125-preview': 'gpt-5 or gpt-4.1',
    'gpt-4-turbo-preview': 'gpt-5 or gpt-4.1',
    // One hop, as the page names it. The registry carries the end of each chain instead
    // (gpt-3.5-turbo retires 2026-10-23 and gpt-3.5-turbo-instruct retired 2026-09-28, both to
    // gpt-5.6-terra), so these classify unverified, as gpt-3.5-turbo-0613 above always has.
    // Whether following a chain may auto-apply is the owner's decision. If it may, teach the
    // classifier to follow these rows; do not delete them.
    'gpt-3.5-turbo-0301': 'gpt-3.5-turbo',
    'gpt-3.5-turbo-16k-0613': 'gpt-3.5-turbo',
    'text-davinci-003': 'gpt-3.5-turbo-instruct',
    'text-davinci-002': 'gpt-3.5-turbo-instruct',
  },
  google: {
    // Same reason, from Google's deprecations page (snapshot d8b5a2b597a3): "gemini-2.0-flash-lite
    // | February 25, 2025 | June 1, 2026 | gemini-3.1-flash-lite", and the same for -001. The
    // registry carries gemini-3.5-flash-lite, where Google retires gemini-3.1-flash-lite on
    // 2027-05-07.
    'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite',
    'gemini-2.0-flash-lite-001': 'gemini-3.1-flash-lite',
  },
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

/** The normalized id sets plus which oracles responded and diagnostic notes. */
export interface LiveIdsResult {
  /** Direct-provider ids (models.dev): the only set that can make a replacement live. */
  liveIds: Set<string>;
  /** Every id OpenRouter lists. Cautionary only; see the header. */
  routedIds: Set<string>;
  sources: string[];
  notes: string[];
}

/**
 * Fetch both public catalogs into two normalized sets: `liveIds` from models.dev,
 * `routedIds` from OpenRouter. A failing oracle is noted, not thrown. When models.dev
 * fails, `liveIds` is empty and every replacement reads as not live — the run blocks
 * auto-apply rather than letting OpenRouter's spellings stand in for the providers' ids.
 */
export async function fetchLiveIds(opts: FetchOptions = {}): Promise<LiveIdsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const liveIds = new Set<string>();
  const routedIds = new Set<string>();
  const sources: string[] = [];
  const notes: string[] = [];
  const providerSet: ReadonlySet<string> = new Set<string>(ORACLE_PROVIDERS);

  // --- OpenRouter (cautionary only: never makes a replacement live) ---
  try {
    const payload = (await fetchJson(OPENROUTER_URL, fetchImpl)) as { data?: unknown[] } | unknown[];
    const arr = (Array.isArray(payload) ? payload : payload.data ?? []) as { id: string }[];
    let firstParty = 0;
    for (const model of arr) {
      const stripped = String(model.id).replace(/^~/, '').split(':')[0];
      const slash = stripped.indexOf('/');
      if (slash < 0) continue;
      if (!providerSet.has(stripped.slice(0, slash))) continue; // ignore third-party hosts
      addLiveId(routedIds, stripped.slice(slash + 1));
      firstParty++;
    }
    sources.push('openrouter');
    notes.push(`openrouter: ${arr.length} models (${firstParty} first-party; cautionary only, never makes a replacement live)`);
  } catch (err) {
    notes.push(`openrouter FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- models.dev (PRIMARY: the only source that can make a replacement live) ---
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
    notes.push(
      `models.dev FAILED: ${err instanceof Error ? err.message : String(err)} ` +
        '-- no direct-provider source this run, so no replacement can verify',
    );
  }

  return { liveIds, routedIds, sources, notes };
}

/** The complete oracle bundle: live ids + curated recommendations + diagnostics. */
export interface Oracles extends VerificationOracles {
  liveIds: Set<string>;
  routedIds: Set<string>;
  officialRecommendations: Map<string, string>;
  sources: string[];
  notes: string[];
}

/** Fetch the live catalogs and pair them with the curated recommendation table. */
export async function fetchOracles(opts: FetchOptions = {}): Promise<Oracles> {
  const { liveIds, routedIds, sources, notes } = await fetchLiveIds(opts);
  return { liveIds, routedIds, officialRecommendations: officialRecommendations(), sources, notes };
}
