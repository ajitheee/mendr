import { describe, expect, it } from 'vitest';
import {
  buildModelCatalog,
  CATALOG_MODELS_DEV_URL,
  CATALOG_OPENROUTER_URL,
  MODEL_CATALOG_SCHEMA,
  serializeCatalog,
} from './catalog.js';

// PLANE 1, the half that was missing: a catalog of what EXISTS, not only what is dying.
//
// The gap this closes, demonstrated: a file calling gpt-4-0613, gpt-5.6-sol and
// claude-sonnet-5 reported ONE model, because only the retirement was in the registry.
// The other two were invisible. A catalog is what lets a later scan say "recognized and
// healthy" or "we have never heard of this" instead of saying nothing at all.

const openrouter = (ids: string[]) =>
  JSON.stringify({ data: ids.map((id) => ({ id })) });

const modelsDev = (byProvider: Record<string, string[]>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(byProvider).map(([p, ids]) => [p, { models: Object.fromEntries(ids.map((i) => [i, {}])) }]),
    ),
  );

/** A fetch seam: url -> body, or a thrown/failed response. */
const stub = (routes: Record<string, string | { status: number } | Error>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) throw new Error(`unstubbed ${url}`);
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'object') return { ok: false, status: hit.status, text: async () => '' } as Response;
    return { ok: true, status: 200, text: async () => hit } as Response;
  }) as unknown as typeof fetch;

const NOW = new Date('2026-09-18T00:00:00.000Z');

describe('collecting the catalog', () => {
  it('keeps provider attribution, which the verifier throws away', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o', 'anthropic/claude-sonnet-5', 'meta/llama-3']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({ google: ['gemini-3.6-flash'] }),
      }),
    });
    expect(c.providers.openai).toEqual(['gpt-4o']);
    expect(c.providers.anthropic).toEqual(['claude-sonnet-5']);
    expect(c.providers.google).toEqual(['gemini-3.6-flash']);
    expect(c.count).toBe(3);
  });

  // The reason this does not reuse oracles.ts: `canonicalizeId` rewrites `.` to `-`
  // so ids match across sources. Nobody writes `gpt-5-6-sol` in their source file, and
  // a catalog that cannot be read back against real code is decoration.
  it('stores ids exactly as published, dots and all', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-5.6-sol']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({ openai: ['gpt-4.1-mini'] }),
      }),
    });
    expect(c.providers.openai).toContain('gpt-5.6-sol');
    expect(c.providers.openai).toContain('gpt-4.1-mini');
    expect(c.providers.openai.join(' ')).not.toContain('gpt-5-6-sol');
  });

  it('ignores third-party rehosts and strips alias and variant markers', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['~openai/gpt-4o:free', 'togetherai/mixtral', 'openai/o3-mini:batch']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({}),
      }),
    });
    expect(c.providers.openai).toEqual(['gpt-4o', 'o3-mini']);
    expect(JSON.stringify(c.providers)).not.toContain('mixtral');
  });

  it('merges the two sources without duplicating', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({ openai: ['gpt-4o', 'gpt-4o-mini'] }),
      }),
    });
    expect(c.providers.openai).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });
});

describe('evidence, so the claim can be re-checked', () => {
  it('records a sha256 of the raw bytes each source returned', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({ openai: ['gpt-4o'] }),
      }),
    });
    for (const s of c.sources) {
      expect(s.ok).toBe(true);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('names the source that failed instead of quietly shrinking', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: { status: 503 },
        [CATALOG_MODELS_DEV_URL]: modelsDev({ openai: ['gpt-4o'] }),
      }),
    });
    const failed = c.sources.find((s) => s.url === CATALOG_OPENROUTER_URL)!;
    expect(failed.ok).toBe(false);
    expect(failed.note).toContain('503');
    expect(failed.sha256).toBeNull();
    expect(c.count).toBe(1); // the surviving source still produced a catalog
  });

  // THE RULE THAT MATTERS. An empty catalog is indistinguishable from "these providers
  // offer no models", and writing that file teaches every later reader something false.
  it('REFUSES to produce a catalog when no source could be read', async () => {
    await expect(
      buildModelCatalog({
        now: NOW,
        fetchImpl: stub({
          [CATALOG_OPENROUTER_URL]: { status: 500 },
          [CATALOG_MODELS_DEV_URL]: new Error('DNS'),
        }),
      }),
    ).rejects.toThrow(/no model catalog source could be read/);
  });

  it('refuses when a source answers with unparseable content, too', async () => {
    await expect(
      buildModelCatalog({
        now: NOW,
        fetchImpl: stub({ [CATALOG_OPENROUTER_URL]: '{ broken', [CATALOG_MODELS_DEV_URL]: 'also broken' }),
      }),
    ).rejects.toThrow(/no model catalog source could be read/);
  });
});

describe('the file it writes', () => {
  it('is deterministic for the same input and clock', async () => {
    const fetchImpl = stub({
      [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
      [CATALOG_MODELS_DEV_URL]: modelsDev({ openai: ['gpt-4o'] }),
    });
    const a = serializeCatalog(await buildModelCatalog({ now: NOW, fetchImpl }));
    const b = serializeCatalog(await buildModelCatalog({ now: NOW, fetchImpl }));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('carries its schema and a seconds-precision timestamp', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({}),
      }),
    });
    expect(c.schema).toBe(MODEL_CATALOG_SCHEMA);
    expect(c.fetchedAt).toBe('2026-09-18T00:00:00Z');
  });

  it('lists every provider, including one that contributed nothing', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: modelsDev({}),
      }),
    });
    expect(Object.keys(c.providers).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(c.providers.anthropic).toEqual([]);
  });
});
