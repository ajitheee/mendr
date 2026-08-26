import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { scanForRecommendations } from './scan.js';
import { buildRecommendJson, renderRecommendText } from '../report/recommend.js';
import { activeEntryIdFor } from './activeEntryId.js';
import type { ActiveModel, EndpointFamily, Provenanced } from './types.js';

// --- non-regression imports (criterion 10): the frozen shared contracts -------
import { EXPOSURE_SCHEMA, serializeExposure } from '../watch/exposureFile.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { foldExposure } from '../watch/exposure.js';
import { isVerified } from '../usage/llmRegistry.js';
import { isRemoteRepoUrl, resolveRepoOrExit, assertAnalyzable, cloneRemoteOrExit } from '../cli/repoTarget.js';

function prov<T>(value: T): Provenanced<T> {
  return { value, source: 'https://docs.test/x', checkedAt: '2026-08-25' };
}
function model(modelId: string, tools = true, vision = true): ActiveModel {
  return {
    entryId: activeEntryIdFor({ provider: 'openai', modelId }),
    provider: 'openai',
    modelId,
    lifecycle: 'active',
    capabilities: {
      tools: prov(tools),
      jsonStrict: prov(true),
      streaming: prov(true),
      vision: prov(vision),
      reasoning: prov(false),
      contextTokens: prov(128000),
      maxOutputTokens: prov(16384),
    },
    endpoint: prov<EndpointFamily>('chat_completions'),
    price: { inputPerMTok: prov(2.5), outputPerMTok: prov(10), currency: 'USD' },
    availability: { regions: { value: 'unknown' }, requiresPreviewAccess: prov(false), minAccountTier: prov<string | null>(null) },
  };
}

const registry: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'retired', shutdownDate: '2026-10-23' },
];
const catalog = [model('gpt-4o'), model('gpt-4o-mini')];
const NOW = new Date('2026-08-25T00:00:00Z');

const dirs: string[] = [];
function fixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-rec-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'app.ts'), source);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const JSON_KEYS = [
  'schema', 'status', 'reason', 'registryVersion', 'catalogVersion', 'scannedCommit', 'providerFilter',
  'providersFound', 'sortedBy', 'hasRecommendations', 'findings', 'reviewFlagged', 'filesScanned',
  'filesMatched', 'recommendations', 'reviewRequired', 'informational',
];

describe('recommend integration — criterion 8 (writes nothing)', () => {
  it('a scan creates no .mendr file and leaves the directory listing unchanged', async () => {
    const dir = fixture(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", tools: [] });`);
    const before = readdirSync(dir).sort();
    const scan = await scanForRecommendations(dir, registry, catalog, { sortBy: null, now: NOW });
    expect(scan.receipts.length).toBe(1);
    expect(existsSync(join(dir, '.mendr'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe('recommend integration — criterion 9 (stable --json contract)', () => {
  function jsonFor(scan: Awaited<ReturnType<typeof scanForRecommendations>>) {
    return buildRecommendJson(scan, {
      registryVersion: 'sha256:aaaa', catalogVersion: 'sha256:bbbb', scannedCommit: null, provider: null, sortBy: null,
    });
  }

  it('empty and non-empty scans share the identical top-level shape (models: [] on empty)', async () => {
    const hit = await scanForRecommendations(
      fixture(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", tools: [] });`),
      registry, catalog, { sortBy: null, now: NOW },
    );
    const empty = await scanForRecommendations(
      fixture(`export const x = 1;`),
      registry, catalog, { sortBy: null, now: NOW },
    );
    const hitJson = jsonFor(hit);
    const emptyJson = jsonFor(empty);
    expect(Object.keys(hitJson).sort()).toEqual([...JSON_KEYS].sort());
    expect(Object.keys(emptyJson).sort()).toEqual([...JSON_KEYS].sort());
    expect(emptyJson.recommendations).toEqual([]);
    expect(emptyJson.hasRecommendations).toBe(false);
    expect(emptyJson.status).toBe('clean');
    expect(hitJson.schema).toBe('mendr-recommend/v1');
    expect(hitJson.status).toBe('recommendations');
  });
});

describe('recommend render — criterion 5 (review warning) + criterion 14 (empty kept line)', () => {
  it('the REVIEW line NAMES the unknown requirements, and --json reviewFlagged counts it', async () => {
    // A model id in a variable (options not visible) => all requirements unknown => reviewFlag.
    const scan = await scanForRecommendations(
      fixture(`const modelName = "gpt-4"; export { modelName };`),
      registry, catalog, { sortBy: null, now: NOW },
    );
    const text = renderRecommendText(scan).join('\n');
    expect(text).toContain('REVIEW');
    expect(text).toContain('unknown requirements');
    expect(text).toContain('endpoint'); // one of the named unknown keys
    const j = buildRecommendJson(scan, { registryVersion: 'a', catalogVersion: 'b', scannedCommit: null, provider: null, sortBy: null });
    expect(j.reviewFlagged).toBe(1);
  });

  it('renders the "no in-provider model" line for a cross-provider run where everything is eliminated', async () => {
    // --provider google on a dead OpenAI chat call: the gemini candidate is
    // eliminated by endpoint, and cross-provider has no official successor.
    const googleCatalog: ActiveModel[] = [{
      entryId: 'google.gemini-x.active', provider: 'google', modelId: 'gemini-x', lifecycle: 'active',
      capabilities: { tools: prov(true), jsonStrict: prov(true), streaming: prov(true), vision: prov(true), reasoning: prov(true), contextTokens: prov(1000000), maxOutputTokens: prov(65536) },
      endpoint: prov<EndpointFamily>('gemini_generate'),
      price: { inputPerMTok: prov(0.3), outputPerMTok: prov(2.5), currency: 'USD' },
      availability: { regions: { value: 'unknown' }, requiresPreviewAccess: prov(false), minAccountTier: prov<string | null>(null) },
    }];
    const scan = await scanForRecommendations(
      fixture(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", tools: [] });`),
      registry, googleCatalog, { sortBy: null, now: NOW, candidateProvider: 'google' },
    );
    const rc = scan.receipts[0];
    expect(rc.officialSuccessors.length + rc.compatibleAlternatives.length).toBe(0);
    expect(renderRecommendText(scan).join('\n')).toContain('no in-provider model meets your required capabilities');
  });
});

describe('recommend surfaces findings it cannot shortlist (the Splunk-Agent case)', () => {
  it('reports usage_unverified as review and data ids as informational, with status no_live_calls', async () => {
    // A model-like assignment with no in-file sink => usage_unverified (Python
    // sink rule); a list entry => data. Neither is a live call.
    const dir = fixture('');
    writeFileSync(join(dir, 'sim.py'), 'model = "gpt-4"\nCATALOG = ["gpt-4"]\n');
    const scan = await scanForRecommendations(dir, registry, catalog, { sortBy: null, now: NOW });

    expect(scan.receipts).toEqual([]);
    expect(scan.reviewRequired.some((r) => r.reason === 'usage_unverified' && r.deprecated === 'gpt-4')).toBe(true);
    expect(scan.informational.reduce((s, g) => s + g.occurrences, 0)).toBeGreaterThan(0);

    const j = buildRecommendJson(scan, { registryVersion: 'a', catalogVersion: 'b', scannedCommit: null, provider: null, sortBy: null });
    expect(j.status).toBe('no_live_calls');
    expect(j.findings.usageUnverified).toBeGreaterThanOrEqual(1);
    expect(j.findings.liveDeprecatedCalls).toBe(0);
    expect(j.providersFound).toContain('openai');

    const text = renderRecommendText(scan).join('\n');
    expect(text).toContain('Review required');
    expect(text).toContain('Informational');
    expect(text).toContain('No compatibility shortlist was generated');
  });

  it('preserves a type_cast_masked Tier B occurrence as review, not informational (chatbot-ui P1 fix)', async () => {
    // `model: ("gpt-4" as Id)` is a masked cast -> a `data` position carrying the
    // cast reason -> the shared classifier returns Tier B type_cast_masked.
    const dir = fixture('type Id = string; const c: any = {}; c.chat.completions.create({ model: ("gpt-4" as Id) });');
    const scan = await scanForRecommendations(dir, registry, catalog, { sortBy: null, now: NOW });
    expect(scan.receipts).toEqual([]); // masked cast is not a live call
    expect(scan.reviewRequired.some((r) => r.reason === 'type_cast_masked')).toBe(true);
    expect(scan.informational.find((g) => g.deprecated === 'gpt-4')).toBeUndefined();
  });

  it('dedupes review + informational by physical site when an id has multiple registry entries', async () => {
    // Two retirement waves for one id — a validator-passing, supported state.
    // The scanner emits a match per entry per node; the buckets must NOT duplicate.
    const registryDup: LlmRegistry = [
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'retired', shutdownDate: '2026-06-01' },
      { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'retired', shutdownDate: '2026-10-23' },
    ];
    const dir = fixture('');
    writeFileSync(join(dir, 'sim.py'), 'model = "gpt-4"\nX = ["gpt-4"]\n');
    const scan = await scanForRecommendations(dir, registryDup, catalog, { sortBy: null, now: NOW });

    expect(scan.reviewRequired.filter((r) => r.reason === 'usage_unverified').length).toBe(1);
    const info = scan.informational.filter((g) => g.deprecated === 'gpt-4');
    expect(info.length).toBe(1);
    expect(info[0].occurrences).toBe(1);
  });
});

describe('non-regression — criterion 10 (fix-llm / Watch contracts unchanged)', () => {
  it('EXPOSURE_SCHEMA is still mendr-exposure/v2', () => {
    expect(EXPOSURE_SCHEMA).toBe('mendr-exposure/v2');
  });

  it('the hoisted repo-target helpers keep their behaviour and exports', () => {
    expect(typeof cloneRemoteOrExit).toBe('function');
    expect(typeof resolveRepoOrExit).toBe('function');
    expect(typeof assertAnalyzable).toBe('function');
    expect(isRemoteRepoUrl('https://github.com/x/y')).toBe(true);
    expect(isRemoteRepoUrl('git@github.com:x/y.git')).toBe(true);
    expect(isRemoteRepoUrl('.')).toBe(false);
    expect(isRemoteRepoUrl('./some/local/path')).toBe(false);
  });

  it('isVerified stays the four-field conjunction', () => {
    const base: LlmModelIdDeprecation = {
      provider: 'openai', kind: 'model_id', deprecated: 'x', replacement: 'y',
      verification: { status: 'verified', officialSourceConfirmed: true, replacementConfirmed: true, autoApplyAllowed: true, quarantineReason: null },
    };
    expect(isVerified(base)).toBe(true);
    expect(isVerified({ ...base, verification: { ...base.verification!, autoApplyAllowed: false } })).toBe(false);
    expect(isVerified({ ...base, verification: { ...base.verification!, status: 'quarantined', quarantineReason: 'held' } })).toBe(false);
    expect(isVerified({ ...base, verification: undefined })).toBe(false);
  });

  it('classifyOccurrenceTier is unchanged (model_arg + verified => A, unverified => B)', () => {
    const verified: LlmModelIdDeprecation = {
      provider: 'openai', kind: 'model_id', deprecated: 'x', replacement: 'y',
      verification: { status: 'verified', officialSourceConfirmed: true, replacementConfirmed: true, autoApplyAllowed: true, quarantineReason: null },
    };
    expect(classifyOccurrenceTier({ position: 'model_arg', deprecation: verified }).tier).toBe('A');
    const unverified: LlmModelIdDeprecation = { provider: 'openai', kind: 'model_id', deprecated: 'x', replacement: 'y' };
    expect(classifyOccurrenceTier({ position: 'model_arg', deprecation: unverified }).tier).toBe('B');
  });

  it('ExposedModel gained no field — foldExposure output key set is frozen', () => {
    const entry: LlmModelIdDeprecation = {
      provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'retired', shutdownDate: '2026-10-23',
      verification: { status: 'verified', officialSourceConfirmed: true, replacementConfirmed: true, autoApplyAllowed: true, quarantineReason: null },
    };
    const [em] = foldExposure([
      { value: 'gpt-4', entry, file: 'app.ts', line: 1, column: 1, tier: 'A', usageVerdict: 'confirmed' },
    ]);
    expect(Object.keys(em).sort()).toEqual(
      [
        'autoApplyAllowed', 'disposition', 'entryId', 'highestTier', 'id', 'locations', 'occurrences',
        'provider', 'replacement', 'replacementVerdict', 'shutdownDate', 'sourceUrl', 'status', 'tierCounts',
      ].sort(),
    );
  });
});
