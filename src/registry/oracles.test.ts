import { describe, expect, it } from 'vitest';
import { fetchLiveIds, fetchOracles, MODELS_DEV_URL, OPENROUTER_URL } from './oracles.js';
import { isLiveId } from './normalize.js';

// The LIVE side of the same split catalog.ts makes on disk. Until 2026-10-09 every id
// OpenRouter listed was folded into `liveIds`, so `candidates verify` and `promote` would
// have called a replacement to `gpt-6.1-sol-pro` live and auto-appliable: OpenRouter lists
// it, OpenAI's page for it returns 404, and OpenAI does pro as `reasoning.mode: pro`.

/** A fetch seam answering `res.json()`, the way fetchJson reads it. */
const stub = (routes: Record<string, unknown | { status: number } | Error>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const hit = routes[String(input)];
    if (hit === undefined) throw new Error(`unstubbed ${String(input)}`);
    if (hit instanceof Error) throw hit;
    if (hit && typeof hit === 'object' && 'status' in hit) {
      return { ok: false, status: (hit as { status: number }).status, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => hit } as Response;
  }) as unknown as typeof fetch;

const openrouter = (ids: string[]) => ({ data: ids.map((id) => ({ id })) });
const modelsDev = (byProvider: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(byProvider).map(([p, ids]) => [p, { models: Object.fromEntries(ids.map((i) => [i, {}])) }]),
  );

const PR40 = {
  [OPENROUTER_URL]: openrouter([
    'openai/gpt-6.1-sol',
    'openai/gpt-6.1-sol-pro',
    'anthropic/claude-sonnet-5.5',
    'openai/gpt-5.1-codex',
  ]),
  [MODELS_DEV_URL]: modelsDev({ openai: ['gpt-6.1-sol'], anthropic: ['claude-sonnet-5-5'] }),
};

describe('which source can make a replacement live', () => {
  it('only models.dev: an id OpenRouter alone lists is not live', async () => {
    const { liveIds } = await fetchLiveIds({ fetchImpl: stub(PR40) });
    expect(isLiveId('gpt-6.1-sol', liveIds)).toBe(true);
    expect(isLiveId('gpt-6.1-sol-pro', liveIds)).toBe(false);
    // OpenAI shut gpt-5.1-codex down on 2026-07-23; OpenRouter still lists it.
    expect(isLiveId('gpt-5.1-codex', liveIds)).toBe(false);
  });

  // A dotted Claude spelling is not an Anthropic id, but it NAMES one: its canonical form
  // is the dashed id models.dev lists. Matching is canonical, so this stays live.
  it('still matches an OpenRouter spelling whose canonical form the provider publishes', async () => {
    const { liveIds } = await fetchLiveIds({ fetchImpl: stub(PR40) });
    expect(isLiveId('claude-sonnet-5.5', liveIds)).toBe(true);
  });

  it('keeps what OpenRouter lists in `routedIds`, for the checks that can only refuse', async () => {
    const { routedIds, sources } = await fetchLiveIds({ fetchImpl: stub(PR40) });
    expect(isLiveId('gpt-6.1-sol-pro', routedIds)).toBe(true);
    expect(isLiveId('gpt-5.1-codex', routedIds)).toBe(true);
    expect(sources).toEqual(['openrouter', 'models.dev']);
  });

  it('fetchOracles carries both sets through to the classifier', async () => {
    const o = await fetchOracles({ fetchImpl: stub(PR40) });
    expect(isLiveId('gpt-6.1-sol-pro', o.liveIds)).toBe(false);
    expect(isLiveId('gpt-6.1-sol-pro', o.routedIds)).toBe(true);
  });
});

describe('a failing source', () => {
  // The safe direction: with no direct-provider source nothing verifies, so nothing is
  // auto-applied on OpenRouter's word.
  it('models.dev failing leaves no live ids, and says why', async () => {
    const { liveIds, routedIds, notes } = await fetchLiveIds({
      fetchImpl: stub({ ...PR40, [MODELS_DEV_URL]: { status: 503 } }),
    });
    expect(liveIds.size).toBe(0);
    expect(routedIds.size).toBeGreaterThan(0);
    expect(notes.join(' ')).toMatch(/models\.dev FAILED.*no replacement can verify/);
  });

  it('OpenRouter failing changes nothing about liveness', async () => {
    const { liveIds, routedIds } = await fetchLiveIds({
      fetchImpl: stub({ ...PR40, [OPENROUTER_URL]: new Error('ECONNRESET') }),
    });
    expect(isLiveId('gpt-6.1-sol', liveIds)).toBe(true);
    expect(routedIds.size).toBe(0);
  });
});
