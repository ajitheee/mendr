import { describe, expect, it } from 'vitest';
import { summarizeRefresh, type CatalogLike, type RefreshSide, type SdkLike } from './refreshSummary.js';

// registry-refresh's "What actually moved" step. It ran inline in the workflow, untested,
// until PR #40 (2026-10-05) showed what that cost: titled "+4 model ids, 5 SDK bumps", its
// diff made SIX bumps and two of its four "model ids" were OpenRouter spellings no
// provider documents.

const pkg = (ecosystem: string, name: string, latest: string) => ({ ecosystem, name, latest });

/** The eight packages as main and PR #40 recorded them (sdk-releases.json, 2026-09-28 vs 2026-10-05). */
const SDK_MAIN: SdkLike = {
  packages: [
    pkg('npm', '@anthropic-ai/sdk', '0.128.0'),
    pkg('npm', '@google/genai', '2.24.0'),
    pkg('npm', '@google/generative-ai', '0.24.1'),
    pkg('npm', 'openai', '7.23.0'),
    pkg('pypi', 'anthropic', '1.8.0'),
    pkg('pypi', 'google-genai', '2.25.0'),
    pkg('pypi', 'google-generativeai', '0.8.6'),
    pkg('pypi', 'openai', '3.19.2'),
  ],
};
const SDK_PR40: SdkLike = {
  packages: [
    pkg('npm', '@anthropic-ai/sdk', '0.131.0'),
    pkg('npm', '@google/genai', '2.27.0'),
    pkg('npm', '@google/generative-ai', '0.24.1'),
    pkg('npm', 'openai', '7.28.0'),
    pkg('pypi', 'anthropic', '1.11.0'),
    pkg('pypi', 'google-genai', '2.28.0'),
    pkg('pypi', 'google-generativeai', '0.8.6'),
    pkg('pypi', 'openai', '3.24.0'),
  ],
};

const CATALOG: CatalogLike = {
  providers: { anthropic: ['claude-sonnet-5'], openai: ['gpt-6-sol'] },
  openrouterOnly: { anthropic: ['claude-sonnet-4.5'], openai: ['gpt-6-sol-pro'] },
  sources: [
    { url: 'https://openrouter.ai/api/v1/models', ok: true },
    { url: 'https://models.dev/api.json', ok: true },
  ],
};

const side = (catalog: CatalogLike, sdk: SdkLike): RefreshSide => ({ catalog, sdk });

describe('SDK bumps are keyed by ecosystem AND name', () => {
  // THE PR #40 DEFECT. `openai` is a package on npm and on PyPI; keyed by name alone, the
  // PyPI record overwrote the npm one and npm openai 7.23.0 -> 7.28.0 vanished from the body.
  it('counts PR #40 as the six bumps its diff made, not five', () => {
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(CATALOG, SDK_PR40));
    expect(s.bumped).toHaveLength(6);
    expect(s.summary).toBe('6 SDK bumps');
  });

  it('reports npm openai and PyPI openai as two separate bumps', () => {
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(CATALOG, SDK_PR40));
    expect(s.bumped.filter((b) => b.name === 'openai')).toEqual([
      { ecosystem: 'npm', name: 'openai', from: '7.23.0', to: '7.28.0' },
      { ecosystem: 'pypi', name: 'openai', from: '3.19.2', to: '3.24.0' },
    ]);
    expect(s.body).toContain('- npm `openai` 7.23.0 → 7.28.0');
    expect(s.body).toContain('- pypi `openai` 3.19.2 → 3.24.0');
  });

  it('does not invent a bump when only one ecosystem moved', () => {
    const now: SdkLike = { packages: [pkg('npm', 'openai', '7.23.0'), pkg('pypi', 'openai', '3.24.0')] };
    const was: SdkLike = { packages: [pkg('npm', 'openai', '7.23.0'), pkg('pypi', 'openai', '3.19.2')] };
    const s = summarizeRefresh(side(CATALOG, was), side(CATALOG, now));
    expect(s.bumped).toEqual([{ ecosystem: 'pypi', name: 'openai', from: '3.19.2', to: '3.24.0' }]);
  });
});

describe('model ids are provider ids only', () => {
  // PR #40's "+4 model ids" were claude-sonnet-5-5 and gpt-6.1-sol (real) plus
  // claude-sonnet-5.5 and gpt-6.1-sol-pro (OpenRouter spellings). Only the first two count.
  const NOW: CatalogLike = {
    ...CATALOG,
    providers: { anthropic: ['claude-sonnet-5', 'claude-sonnet-5-5'], openai: ['gpt-6-sol', 'gpt-6.1-sol'] },
    openrouterOnly: {
      anthropic: ['claude-sonnet-4.5', 'claude-sonnet-5.5'],
      openai: ['gpt-6-sol-pro', 'gpt-6.1-sol-pro'],
    },
  };

  it('counts what the direct-provider source added, and nothing OpenRouter alone lists', () => {
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(NOW, SDK_PR40));
    expect(s.added).toEqual(['anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-sol']);
    expect(s.summary).toBe('+2 model ids, 6 SDK bumps');
  });

  it('lists OpenRouter-only spellings in their own section, never as model ids', () => {
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(NOW, SDK_PR40));
    expect(s.routedAdded).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol-pro']);
    const [modelIds, rest] = s.body.split('**OpenRouter-only spellings**');
    expect(modelIds).not.toContain('gpt-6.1-sol-pro');
    expect(modelIds).not.toContain('claude-sonnet-5.5');
    expect(rest).toContain('`openai/gpt-6.1-sol-pro`');
  });

  // Weekly churn on OpenRouter's slugs must not open a PR every Monday: nothing decides
  // anything from them.
  it('opens no PR when only OpenRouter-only spellings moved', () => {
    const now: CatalogLike = { ...CATALOG, openrouterOnly: { ...CATALOG.openrouterOnly, google: ['gemma-3-27b-it'] } };
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(now, SDK_MAIN));
    expect(s.substantive).toBe(false);
    expect(s.summary).toBe('OpenRouter-only spellings only');
  });

  it('shows an id leaving `providers` for `openrouterOnly` as both halves of the move', () => {
    const now: CatalogLike = {
      ...CATALOG,
      providers: { anthropic: ['claude-sonnet-5'], openai: [] },
      openrouterOnly: { ...CATALOG.openrouterOnly, openai: ['gpt-6-sol', 'gpt-6-sol-pro'] },
    };
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(now, SDK_MAIN));
    expect(s.removed).toEqual(['openai/gpt-6-sol']);
    expect(s.routedAdded).toEqual(['openai/gpt-6-sol']);
    expect(s.summary).toBe('-1 model id');
  });
});

describe('a source that could not be read', () => {
  it('is named, and its spellings are not reported as withdrawn', () => {
    const now: CatalogLike = {
      ...CATALOG,
      openrouterOnly: { anthropic: [], openai: [] },
      sources: [
        { url: 'https://openrouter.ai/api/v1/models', ok: false, note: 'failed: HTTP 503' },
        { url: 'https://models.dev/api.json', ok: true },
      ],
    };
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(now, SDK_MAIN));
    expect(s.routedCompared).toBe(false);
    expect(s.routedRemoved).toEqual([]);
    expect(s.failedSources).toEqual(['https://openrouter.ai/api/v1/models (failed: HTTP 503)']);
    expect(s.body).toMatch(/could not read.*missing from this refresh, not withdrawn/s);
    expect(s.substantive).toBe(false);
  });

  it('a catalog from before the split, with no `openrouterOnly`, is not compared on it', () => {
    const before: CatalogLike = { providers: CATALOG.providers, sources: CATALOG.sources };
    const s = summarizeRefresh(side(before, SDK_MAIN), side(CATALOG, SDK_MAIN));
    expect(s.routedCompared).toBe(false);
    expect(s.routedAdded).toEqual([]);
    expect(s.summary).toBe('timestamps only');
  });
});

describe('nothing moved', () => {
  it('says so, and is not substantive', () => {
    const s = summarizeRefresh(side(CATALOG, SDK_MAIN), side(CATALOG, SDK_MAIN));
    expect(s.substantive).toBe(false);
    expect(s.summary).toBe('timestamps only');
    expect(s.body).toBe('_Only `fetchedAt` changed; no ids and no SDK versions moved._\n');
  });
});
