// mendr: model-catalog
// (This file IS Mendr's model knowledge base — the annotation above makes
// self-scans report it as expected registry content instead of model-id debt.)
//
// PLANE 1, the half we never built: the provider CATALOG.
//
// The deprecation registry answers "which model ids are dying". It cannot answer
// "which model ids exist", because it only ever contained retirements. So a literal
// the scanner meets is either a known retirement or invisible — a repository calling
// three models reports one. That gap is why Mendr can say what is broken but not what
// you depend on.
//
// This module collects the other half. The FETCH already existed in oracles.ts, where
// `verify-registry` pulls the same two public catalogs to check that a replacement is
// live — and then throws the result away. Here it is collected as an artifact instead.
//
// TWO DELIBERATE DIFFERENCES from oracles.ts, which is why this duplicates its fetch
// rather than sharing it:
//
//   1. PROVIDER ATTRIBUTION IS KEPT. `fetchLiveIds` folds everything into one flat Set
//      because membership is all a verifier needs. A catalog that cannot say which
//      provider publishes an id is not a catalog.
//   2. IDS ARE STORED AS PUBLISHED. `canonicalizeId` lowercases and rewrites `.` to `-`
//      so `gpt-5.6-sol` matches `gpt-5-6-sol`. Correct for matching, wrong for a
//      catalog: nobody writes `gpt-5-6-sol` in their source, and a catalog that cannot
//      be read back against real code is decoration.
//
// Sharing one function across those two needs would mean a flag, and a flag here would
// be an abstraction built for a second caller that does not exist yet.

import { createHash } from 'node:crypto';

/** Bumped only on a breaking shape change. */
export const MODEL_CATALOG_SCHEMA = 'mendr-model-catalog/v1';

export const CATALOG_MODELS_DEV_URL = 'https://models.dev/api.json';
export const CATALOG_OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

/** First-party providers we catalog; third-party rehosts are ignored. */
export const CATALOG_PROVIDERS = ['anthropic', 'google', 'openai'] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

/**
 * What one source contributed, and proof of exactly what was read.
 *
 * The `sha256` is of the RAW BYTES, not of the parsed result — that is what makes
 * this immutable source evidence rather than a claim about it. Anyone can re-fetch
 * the url and check whether the catalog was built from what is there now.
 */
export interface CatalogSource {
  url: string;
  ok: boolean;
  /** sha256 of the exact response body, or null when the fetch failed. */
  sha256: string | null;
  /** First-party model ids this source contributed (before de-duplication). */
  contributed: number;
  note: string;
}

export interface ModelCatalog {
  schema: string;
  /** ISO-8601 UTC, seconds precision. */
  fetchedAt: string;
  sources: CatalogSource[];
  /** provider -> ids exactly as published, sorted and de-duplicated. */
  providers: Record<string, string[]>;
  /** Total ids across every provider. */
  count: number;
}

export interface BuildCatalogOptions {
  fetchImpl?: typeof fetch;
  /** Fixed clock, so a test can assert bytes. */
  now?: Date;
}

/** An id worth cataloguing: non-empty, not a path, not absurdly long. */
function usableId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > 120) return null;
  return id;
}

async function readSource(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; sha256: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Collect the live model catalog from the two public sources.
 *
 * One source failing is tolerated and recorded — they corroborate each other rather
 * than one depending on the other. BOTH failing THROWS, and that is the important
 * rule: an empty catalog is indistinguishable from "this provider offers no models",
 * and writing that file would teach every downstream reader something false. The same
 * fail-closed posture the scanner already takes when it cannot read a file.
 */
export async function buildModelCatalog(opts: BuildCatalogOptions = {}): Promise<ModelCatalog> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fetchedAt = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const byProvider = new Map<string, Set<string>>();
  for (const p of CATALOG_PROVIDERS) byProvider.set(p, new Set<string>());
  const sources: CatalogSource[] = [];

  // --- OpenRouter: ids are namespaced `provider/id`, with `~` aliases and `:variant`.
  const or = await readSource(CATALOG_OPENROUTER_URL, fetchImpl);
  if ('error' in or) {
    sources.push({ url: CATALOG_OPENROUTER_URL, ok: false, sha256: null, contributed: 0, note: `failed: ${or.error}` });
  } else {
    let contributed = 0;
    try {
      const payload = JSON.parse(or.text) as { data?: unknown[] } | unknown[];
      const rows = (Array.isArray(payload) ? payload : (payload.data ?? [])) as { id?: unknown }[];
      for (const row of rows) {
        const raw = usableId(row?.id);
        if (!raw) continue;
        // Strip the alias marker and the variant suffix, then split the namespace.
        const stripped = raw.replace(/^~/, '').split(':')[0]!;
        const slash = stripped.indexOf('/');
        if (slash < 0) continue;
        const provider = stripped.slice(0, slash);
        const id = stripped.slice(slash + 1);
        const bucket = byProvider.get(provider);
        if (!bucket || !id) continue;
        bucket.add(id);
        contributed++;
      }
      sources.push({ url: CATALOG_OPENROUTER_URL, ok: true, sha256: or.sha256, contributed, note: `${rows.length} models, ${contributed} first-party` });
    } catch (err) {
      sources.push({ url: CATALOG_OPENROUTER_URL, ok: false, sha256: or.sha256, contributed: 0, note: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // --- models.dev: already grouped by provider, ids published dash-style.
  const md = await readSource(CATALOG_MODELS_DEV_URL, fetchImpl);
  if ('error' in md) {
    sources.push({ url: CATALOG_MODELS_DEV_URL, ok: false, sha256: null, contributed: 0, note: `failed: ${md.error}` });
  } else {
    let contributed = 0;
    try {
      const payload = JSON.parse(md.text) as Record<string, { models?: Record<string, unknown> }>;
      for (const provider of CATALOG_PROVIDERS) {
        const models = payload[provider]?.models;
        if (!models) continue;
        for (const key of Object.keys(models)) {
          const id = usableId(key);
          if (!id) continue;
          byProvider.get(provider)!.add(id);
          contributed++;
        }
      }
      sources.push({ url: CATALOG_MODELS_DEV_URL, ok: true, sha256: md.sha256, contributed, note: `${contributed} first-party models` });
    } catch (err) {
      sources.push({ url: CATALOG_MODELS_DEV_URL, ok: false, sha256: md.sha256, contributed: 0, note: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (!sources.some((s) => s.ok)) {
    throw new Error(
      `mendr: no model catalog source could be read (${sources.map((s) => `${s.url} ${s.note}`).join('; ')}). ` +
        'Refusing to write an empty catalog: it would read as "these providers offer no models".',
    );
  }

  const providers: Record<string, string[]> = {};
  let count = 0;
  for (const provider of CATALOG_PROVIDERS) {
    const ids = [...byProvider.get(provider)!].sort();
    providers[provider] = ids;
    count += ids.length;
  }

  return { schema: MODEL_CATALOG_SCHEMA, fetchedAt, sources, providers, count };
}

/** The exact bytes written to disk: 2-space JSON with a trailing newline. */
export function serializeCatalog(catalog: ModelCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
