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
//   1. PROVIDER ATTRIBUTION IS KEPT. `fetchLiveIds` folds each source into a flat Set
//      because membership is all a verifier needs. A catalog that cannot say which
//      provider publishes an id is not a catalog.
//   2. IDS ARE STORED AS PUBLISHED. `canonicalizeId` lowercases and rewrites `.` to `-`
//      so `gpt-5.6-sol` matches `gpt-5-6-sol`. Correct for matching, wrong for a
//      catalog: nobody writes `gpt-5-6-sol` in their source, and a catalog that cannot
//      be read back against real code is decoration.
//
// Sharing one function across those two needs would mean a flag, and a flag here would
// be an abstraction built for a second caller that does not exist yet.
//
// WHICH SOURCE MAY SAY A PROVIDER PUBLISHES AN ID (added 2026-10-09). The two sources
// are not equals, and treating them as equals put ids in this file that no provider
// documents:
//
//   - models.dev keys each provider's models by the id you send to THAT PROVIDER'S OWN
//     API. Its ids are the direct-provider ids, and only they go in `providers`.
//   - OpenRouter's ids are OpenRouter's routing names. For a call that goes through
//     OpenRouter they are exactly right (`anthropic/claude-sonnet-4.5` is what such a
//     call sends), so they are kept, in `openrouterOnly`. As evidence that a provider
//     publishes an id they are worthless. On 2026-10-09, against the providers' own
//     pages: OpenRouter lists dotted Claude ids (`claude-sonnet-4.5`, `claude-opus-5.5`,
//     `claude-sonnet-5.5`, ...) where Anthropic's id format is hyphens only; it lists
//     `gpt-6-sol-pro`, `gpt-6-astra-pro`, `gpt-6-luna-pro` and `gpt-6.1-sol-pro`, whose
//     OpenAI model pages return 404 (OpenAI's deprecation table names pro replacements
//     as `gpt-5.6-sol (reasoning.mode: pro)`, a setting, not an id); and it still lists
//     ids the provider has shut down, such as `gpt-5.1-codex` (OpenAI: "shut down on
//     July 23, 2026").
//
// So a spelling only OpenRouter lists lands in `openrouterOnly` and never in
// `providers`. Every reader that decides whether a destination is live reads
// `providers` alone (graph.ts), and the live verifier applies the same split
// (oracles.ts), so such a spelling can never make a replacement count as live or
// auto-appliable. The cost is the other kind of error, and it is the safe kind: a real
// id that models.dev happens not to list is reported unlisted, which sends a migration
// to review instead of letting one through.

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
  /**
   * First-party model ids this source listed (before de-duplication). OpenRouter's
   * land in `openrouterOnly` unless models.dev lists the same spelling.
   */
  contributed: number;
  note: string;
}

export interface ModelCatalog {
  schema: string;
  /** ISO-8601 UTC, seconds precision. */
  fetchedAt: string;
  sources: CatalogSource[];
  /**
   * provider -> the ids a DIRECT call to that provider's API uses, exactly as published,
   * sorted and de-duplicated. Only the direct-provider source (models.dev) adds to it.
   * This is the list that may say a destination is live.
   */
  providers: Record<string, string[]>;
  /**
   * provider -> spellings OpenRouter lists that no direct-provider source does, exactly
   * as OpenRouter spells them (namespace, `~` alias marker and `:variant` stripped).
   *
   * A call routed through OpenRouter does send these, which is why they are kept. They
   * are NEVER evidence that the provider's own API accepts the id, so nothing reads them
   * to decide that a replacement is live. Some are real ids models.dev does not list; most
   * are OpenRouter's own names. Being here says only which source listed the spelling.
   *
   * Optional because catalogs written before 2026-10-09 do not carry it; a reader must
   * treat its absence as "not recorded", never as "OpenRouter lists nothing".
   */
  openrouterOnly?: Record<string, string[]>;
  /** Total ids across every provider in `providers` (direct-provider ids only). */
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
 * The sources are NOT interchangeable (see the header). models.dev is the only one that
 * can put an id in `providers`; OpenRouter only fills `openrouterOnly`. That decides
 * what a failure means:
 *
 *   - OpenRouter failing is tolerated and recorded. `openrouterOnly` is then empty and
 *     its source says why; nothing that decides liveness reads it.
 *   - models.dev failing THROWS, and so does models.dev listing nothing for one of the
 *     providers. Either would leave `providers` saying a provider publishes no models,
 *     and writing that file would teach every downstream reader something false.
 *     OpenRouter cannot stand in: its spellings are not the provider's ids. The same
 *     fail-closed posture the scanner already takes when it cannot read a file.
 */
export async function buildModelCatalog(opts: BuildCatalogOptions = {}): Promise<ModelCatalog> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fetchedAt = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const direct = new Map<string, Set<string>>();
  const routed = new Map<string, Set<string>>();
  for (const p of CATALOG_PROVIDERS) {
    direct.set(p, new Set<string>());
    routed.set(p, new Set<string>());
  }
  const sources: CatalogSource[] = [];

  // --- OpenRouter: ids are namespaced `provider/id`, with `~` aliases and `:variant`.
  // Collected as ROUTED spellings; which of them models.dev also lists is settled below.
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
        const bucket = routed.get(provider);
        if (!bucket || !id) continue;
        bucket.add(id);
        contributed++;
      }
      sources.push({ url: CATALOG_OPENROUTER_URL, ok: true, sha256: or.sha256, contributed, note: `${rows.length} models, ${contributed} first-party` });
    } catch (err) {
      sources.push({ url: CATALOG_OPENROUTER_URL, ok: false, sha256: or.sha256, contributed: 0, note: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // --- models.dev: grouped by provider, keyed by the id the provider's own API takes.
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
          direct.get(provider)!.add(id);
          contributed++;
        }
      }
      sources.push({ url: CATALOG_MODELS_DEV_URL, ok: true, sha256: md.sha256, contributed, note: `${contributed} first-party models` });
    } catch (err) {
      sources.push({ url: CATALOG_MODELS_DEV_URL, ok: false, sha256: md.sha256, contributed: 0, note: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const directSource = sources.find((s) => s.url === CATALOG_MODELS_DEV_URL)!;
  if (!directSource.ok) {
    throw new Error(
      `mendr: the direct-provider model source could not be read (${sources.map((s) => `${s.url} ${s.note}`).join('; ')}). ` +
        'Refusing to write the catalog: without it every provider would read as offering no models, ' +
        "and OpenRouter cannot stand in, because its spellings are not the providers' own ids.",
    );
  }
  const silent = CATALOG_PROVIDERS.filter((p) => direct.get(p)!.size === 0);
  if (silent.length > 0) {
    throw new Error(
      `mendr: ${CATALOG_MODELS_DEV_URL} listed no ${silent.join(', ')} models. ` +
        `Refusing to write a catalog that says ${silent.length === 1 ? 'that provider publishes' : 'those providers publish'} nothing: ` +
        'a provider vanishing from the source is a change to look at, not a fact to record.',
    );
  }

  const providers: Record<string, string[]> = {};
  const openrouterOnly: Record<string, string[]> = {};
  let count = 0;
  for (const provider of CATALOG_PROVIDERS) {
    const ids = direct.get(provider)!;
    providers[provider] = [...ids].sort();
    // EXACT spelling, not canonical form: `claude-sonnet-4.5` stays here even though
    // `claude-sonnet-4-5` is direct, because the dotted spelling is the one no provider
    // documents for a direct call and a call through OpenRouter does send.
    openrouterOnly[provider] = [...routed.get(provider)!].filter((id) => !ids.has(id)).sort();
    count += ids.size;
  }

  return { schema: MODEL_CATALOG_SCHEMA, fetchedAt, sources, providers, openrouterOnly, count };
}

/** The exact bytes written to disk: 2-space JSON with a trailing newline. */
export function serializeCatalog(catalog: ModelCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
