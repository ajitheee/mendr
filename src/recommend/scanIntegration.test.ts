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
  'schema', 'registryVersion', 'catalogVersion', 'scannedCommit', 'provider',
  'sortedBy', 'hasRecommendations', 'modelCount', 'reviewFlagged', 'filesScanned', 'filesMatched', 'models',
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
    expect(emptyJson.models).toEqual([]);
    expect(emptyJson.hasRecommendations).toBe(false);
    expect(hitJson.schema).toBe('mendr-recommend/v1');
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

  it('renders the "no in-provider model meets your required capabilities" line when everything is eliminated', async () => {
    const catalogNoVision = [model('gpt-4o', true, false)]; // vision=false
    const scan = await scanForRecommendations(
      fixture(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });`),
      registry, catalogNoVision, { sortBy: null, now: NOW },
    );
    expect(scan.receipts[0].officialSuccessors.length + scan.receipts[0].compatibleAlternatives.length).toBe(0);
    expect(renderRecommendText(scan).join('\n')).toContain('no in-provider model meets your required capabilities');
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
