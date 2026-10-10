import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildModelCatalog,
  CATALOG_MODELS_DEV_URL,
  CATALOG_OPENROUTER_URL,
  MODEL_CATALOG_SCHEMA,
  serializeCatalog,
  type ModelCatalog,
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

/** models.dev listing one id for every provider, plus whatever a test adds. */
const allThree = (extra: Record<string, string[]> = {}) =>
  modelsDev({
    anthropic: ['claude-sonnet-5', ...(extra.anthropic ?? [])],
    google: ['gemini-3.6-flash', ...(extra.google ?? [])],
    openai: ['gpt-4o', ...(extra.openai ?? [])],
  });

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
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o', 'meta/llama-3']),
        [CATALOG_MODELS_DEV_URL]: allThree(),
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
        [CATALOG_MODELS_DEV_URL]: allThree({ openai: ['gpt-5.6-sol', 'gpt-4.1-mini'] }),
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
        [CATALOG_MODELS_DEV_URL]: allThree({ openai: ['o3-mini'] }),
      }),
    });
    expect(c.providers.openai).toEqual(['gpt-4o', 'o3-mini']);
    expect(c.openrouterOnly!.openai).toEqual([]);
    expect(JSON.stringify(c)).not.toContain('mixtral');
  });

  it('merges the two sources without duplicating', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: allThree({ openai: ['gpt-4o-mini'] }),
      }),
    });
    expect(c.providers.openai).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(c.openrouterOnly!.openai).toEqual([]);
  });
});

// PR #40 (2026-10-05) proposed claude-sonnet-5.5 and gpt-6.1-sol-pro as provider ids
// because OpenRouter listed them. Neither is: Anthropic's ids are hyphens only, and
// OpenAI's page for gpt-6.1-sol-pro returns 404 (pro is `reasoning.mode: pro`). These
// tests are the reason the next Monday refresh cannot propose them again.
describe('a spelling only OpenRouter lists is never a provider id', () => {
  const pr40Shape = () =>
    buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter([
          'anthropic/claude-sonnet-5.5',
          'openai/gpt-6.1-sol',
          'openai/gpt-6.1-sol-pro',
          'openai/gpt-6-sol-pro',
        ]),
        [CATALOG_MODELS_DEV_URL]: allThree({ anthropic: ['claude-sonnet-5-5'], openai: ['gpt-6.1-sol'] }),
      }),
    });

  it('keeps it out of `providers`, the list that may say a destination is live', async () => {
    const c = await pr40Shape();
    expect(c.providers.anthropic).toEqual(['claude-sonnet-5', 'claude-sonnet-5-5']);
    expect(c.providers.openai).toEqual(['gpt-4o', 'gpt-6.1-sol']);
    for (const bad of ['claude-sonnet-5.5', 'gpt-6.1-sol-pro', 'gpt-6-sol-pro']) {
      expect(Object.values(c.providers).flat()).not.toContain(bad);
    }
    expect(c.count).toBe(5);
  });

  // A call routed through OpenRouter DOES send `anthropic/claude-sonnet-5.5`, so the
  // spelling is kept rather than thrown away: apart, and under a name that says what it is.
  it('records it in `openrouterOnly`, exactly as OpenRouter spells it', async () => {
    const c = await pr40Shape();
    expect(c.openrouterOnly).toEqual({
      anthropic: ['claude-sonnet-5.5'],
      google: [],
      openai: ['gpt-6-sol-pro', 'gpt-6.1-sol-pro'],
    });
  });

  // Exact spelling, not canonical form: Anthropic documents no dotted spelling for a direct
  // call, so it stays visible even though its canonical form is a real id.
  it('keeps a dotted spelling apart even when its dashed twin is a provider id', async () => {
    const c = await pr40Shape();
    expect(c.providers.anthropic).toContain('claude-sonnet-5-5');
    expect(c.openrouterOnly!.anthropic).toContain('claude-sonnet-5.5');
  });

  it('never lists one id in both places', async () => {
    const c = await pr40Shape();
    for (const p of Object.keys(c.providers)) {
      const direct = new Set(c.providers[p]);
      expect(c.openrouterOnly![p]!.filter((id) => direct.has(id))).toEqual([]);
    }
  });
});

describe('evidence, so the claim can be re-checked', () => {
  it('records a sha256 of the raw bytes each source returned', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o']),
        [CATALOG_MODELS_DEV_URL]: allThree(),
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
        [CATALOG_MODELS_DEV_URL]: allThree(),
      }),
    });
    const failed = c.sources.find((s) => s.url === CATALOG_OPENROUTER_URL)!;
    expect(failed.ok).toBe(false);
    expect(failed.note).toContain('503');
    expect(failed.sha256).toBeNull();
    expect(c.count).toBe(3); // the direct-provider source still produced a catalog
    expect(c.openrouterOnly).toEqual({ anthropic: [], google: [], openai: [] });
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
    ).rejects.toThrow(/direct-provider model source could not be read/);
  });

  // OpenRouter answering is not enough: its spellings are not the providers' ids, so a
  // catalog built from it alone would put exactly the wrong ids in `providers`.
  it('REFUSES when only OpenRouter could be read', async () => {
    await expect(
      buildModelCatalog({
        now: NOW,
        fetchImpl: stub({
          [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o', 'anthropic/claude-sonnet-5.5']),
          [CATALOG_MODELS_DEV_URL]: { status: 502 },
        }),
      }),
    ).rejects.toThrow(/OpenRouter cannot stand in/);
  });

  it('refuses when a source answers with unparseable content, too', async () => {
    await expect(
      buildModelCatalog({
        now: NOW,
        fetchImpl: stub({ [CATALOG_OPENROUTER_URL]: '{ broken', [CATALOG_MODELS_DEV_URL]: 'also broken' }),
      }),
    ).rejects.toThrow(/direct-provider model source could not be read/);
  });

  // With one direct source, a provider it suddenly lists nothing for would be written
  // as "this provider publishes no models". OpenRouter used to mask that; now it cannot.
  it('REFUSES when the direct-provider source lists nothing for one provider', async () => {
    await expect(
      buildModelCatalog({
        now: NOW,
        fetchImpl: stub({
          [CATALOG_OPENROUTER_URL]: openrouter(['google/gemini-3.6-flash']),
          [CATALOG_MODELS_DEV_URL]: modelsDev({ anthropic: ['claude-sonnet-5'], openai: ['gpt-4o'] }),
        }),
      }),
    ).rejects.toThrow(/listed no google models/);
  });
});

describe('the file it writes', () => {
  it('is deterministic for the same input and clock', async () => {
    const fetchImpl = stub({
      [CATALOG_OPENROUTER_URL]: openrouter(['openai/gpt-4o', 'openai/o4-mini-high']),
      [CATALOG_MODELS_DEV_URL]: allThree(),
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
        [CATALOG_MODELS_DEV_URL]: allThree(),
      }),
    });
    expect(c.schema).toBe(MODEL_CATALOG_SCHEMA);
    expect(c.fetchedAt).toBe('2026-09-18T00:00:00Z');
  });

  it('lists every provider in both maps, including one OpenRouter said nothing about', async () => {
    const c = await buildModelCatalog({
      now: NOW,
      fetchImpl: stub({
        [CATALOG_OPENROUTER_URL]: openrouter(['openai/o4-mini-high']),
        [CATALOG_MODELS_DEV_URL]: allThree(),
      }),
    });
    expect(Object.keys(c.providers).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(Object.keys(c.openrouterOnly!).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(c.openrouterOnly!.anthropic).toEqual([]);
    expect(c.openrouterOnly!.openai).toEqual(['o4-mini-high']);
  });
});

// The SHIPPED file, re-checked on every test run. It was reclassified by hand on
// 2026-10-09 (each spelling below checked against the provider's own page that day), and
// a later hand edit or a refresh that regresses the split should fail here, not in a
// user's migration.
describe('the shipped catalog', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = JSON.parse(
    readFileSync(join(here, '..', '..', 'registries', 'model-catalog.json'), 'utf8'),
  ) as ModelCatalog;
  const direct = Object.values(shipped.providers).flat();

  it('counts only provider ids', () => {
    expect(shipped.count).toBe(direct.length);
  });

  it('never lists one spelling as both a provider id and an OpenRouter-only one', () => {
    for (const [p, ids] of Object.entries(shipped.openrouterOnly ?? {})) {
      const mine = new Set(shipped.providers[p]);
      expect(ids.filter((id) => mine.has(id))).toEqual([]);
    }
  });

  // Anthropic: "model IDs use a dateless format: claude-{name}-{major}[-{minor}]", and the
  // dated form before it is hyphenated too. On Anthropic's pages (2026-10-09) the only
  // dotted ids are the long-retired claude-1.x, claude-2.x and claude-instant-1.x.
  it('holds no dotted Claude id as an Anthropic provider id', () => {
    expect(shipped.providers.anthropic!.filter((id) => id.includes('.'))).toEqual([]);
  });

  // Each one's model page on developers.openai.com returned 404 on 2026-10-09; OpenAI does
  // pro as `reasoning.mode: pro`. The dotted Claude spellings are on no Anthropic page.
  it('keeps the spellings the 2026-10-09 review found only on OpenRouter out of `providers`', () => {
    const openrouterOnly = [
      ['anthropic', 'claude-sonnet-5.5'],
      ['anthropic', 'claude-sonnet-4.5'],
      ['anthropic', 'claude-opus-5.5'],
      ['anthropic', 'claude-fable-5.1'],
      ['openai', 'gpt-6.1-sol-pro'],
      ['openai', 'gpt-6-sol-pro'],
      ['openai', 'gpt-6-astra-pro'],
      ['openai', 'gpt-6-luna-pro'],
    ] as const;
    for (const [p, id] of openrouterOnly) {
      expect(shipped.providers[p]).not.toContain(id);
      expect(shipped.openrouterOnly?.[p]).toContain(id);
    }
  });

  it('carries the provider ids PR #40 found and the providers confirm', () => {
    expect(shipped.providers.anthropic).toContain('claude-sonnet-5-5');
    expect(shipped.providers.openai).toContain('gpt-6.1-sol');
  });
});
