import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmModelIdDeprecation } from '../types.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { findPyModelIdLiterals } from '../python/scanPy.js';
import { auditUsage } from '../recon/usageAudit.js';
import { isVerified, loadLlmRegistry, modelIdEntries, resolveRegistryPath } from '../usage/llmRegistry.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { checkDates } from './checkDates.js';
import { checkDeprecationClaim } from './claimCheck.js';
import { readModelRows } from './discover.js';
import { resolveEvidenceDir, snapshotName } from './evidence.js';
import { normalizePageText, quoteIsOnPage } from './pageText.js';

// The dated retirements added on 2026-10-10 from OpenAI's and Google's deprecation pages, read from
// the SHIPPED registry. Twenty records: three through `mendr candidates promote`, the rest by the
// documented review-only path, each stamped by the gate's own classifier.

const registry = loadLlmRegistry(resolveRegistryPath());
const entries = modelIdEntries(registry);
const find = (id: string): LlmModelIdDeprecation => {
  const record = entries.find((e) => e.deprecated === id);
  if (!record) throw new Error(`the shipped registry has no record for ${id}`);
  return record;
};

const ADDED: Record<string, { replacement: string; shutdownDate: string; status: 'deprecated' | 'retired' }> = {
  'gpt-5.1': { replacement: 'gpt-6-sol', shutdownDate: '2027-04-01', status: 'deprecated' },
  'gpt-5.3-codex': { replacement: 'gpt-6-sol', shutdownDate: '2027-04-01', status: 'deprecated' },
  'gpt-5.4-nano': { replacement: 'gpt-6-luna', shutdownDate: '2027-04-01', status: 'deprecated' },
  'tts-1': { replacement: 'gpt-realtime-2.1-mini', shutdownDate: '2027-01-06', status: 'deprecated' },
  'tts-1-hd': { replacement: 'gpt-realtime-2.1-mini', shutdownDate: '2027-01-06', status: 'deprecated' },
  'gpt-4o-mini-tts-2025-03-20': { replacement: 'gpt-realtime-2.1-mini', shutdownDate: '2027-01-06', status: 'deprecated' },
  'gpt-4o-mini-tts-2025-12-15': { replacement: 'gpt-realtime-2.1-mini', shutdownDate: '2027-01-06', status: 'deprecated' },
  'whisper-1': { replacement: 'gpt-transcribe', shutdownDate: '2027-02-26', status: 'deprecated' },
  'gpt-4o-transcribe': { replacement: 'gpt-transcribe', shutdownDate: '2027-02-26', status: 'deprecated' },
  'gpt-4o-mini-transcribe': { replacement: 'gpt-transcribe', shutdownDate: '2027-02-26', status: 'deprecated' },
  'gpt-4o-transcribe-diarize': { replacement: 'gpt-transcribe', shutdownDate: '2027-02-26', status: 'deprecated' },
  'gpt-4o-audio': { replacement: 'gpt-audio-1.5', shutdownDate: '2027-01-20', status: 'deprecated' },
  'gpt-4o-mini-audio': { replacement: 'gpt-audio-1.5', shutdownDate: '2027-01-20', status: 'deprecated' },
  'gpt-4o-mini-realtime': { replacement: 'gpt-realtime-2.1-mini', shutdownDate: '2027-01-20', status: 'deprecated' },
  'gpt-4-turbo-preview-completions': { replacement: 'gpt-4.1', shutdownDate: '2026-03-26', status: 'retired' },
  'veo-3.0-generate-001': { replacement: 'veo-3.1-generate-preview', shutdownDate: '2026-06-30', status: 'retired' },
  'veo-3.0-fast-generate-001': { replacement: 'veo-3.1-fast-generate-preview', shutdownDate: '2026-06-30', status: 'retired' },
  'veo-2.0-generate-001': { replacement: 'veo-3.1-generate-preview', shutdownDate: '2026-06-30', status: 'retired' },
  'veo-3.0-generate-preview': { replacement: 'veo-3.1-generate-preview', shutdownDate: '2025-11-12', status: 'retired' },
  'veo-3.0-fast-generate-preview': { replacement: 'veo-3.1-fast-generate-preview', shutdownDate: '2025-11-12', status: 'retired' },
};

describe('the dated retirements added on 2026-10-10', () => {
  it("carries each provider's date and named replacement", () => {
    for (const [id, want] of Object.entries(ADDED)) {
      const record = find(id);
      expect({ replacement: record.replacement, shutdownDate: record.shutdownDate, status: record.status }, id).toEqual(want);
    }
  });

  it('rests every record on a quoted row and a stored snapshot, as the promote gate requires', () => {
    // The claim half of the promote gate, run offline. No catalog is consulted here, so the
    // "retired while a catalog lists it" rule cannot fire; every other rule does.
    for (const id of Object.keys(ADDED)) {
      const result = checkDeprecationClaim(find(id), { liveIds: new Set(), snapshotDir: resolveEvidenceDir() });
      expect(result.reasons, id).toEqual([]);
    }
  });

  it('auto-fixes none of them', () => {
    // The gate verified gpt-5.1, gpt-5.3-codex and gpt-5.4-nano. All three are held (see below).
    const autoFixed = Object.keys(ADDED).filter((id) => isVerified(find(id)));
    expect(autoFixed).toEqual([]);
  });

  it("holds gpt-5.3-codex for review: OpenAI's GPT-6 guide changes prompt_cache_retention, and nothing checks it", () => {
    // The default-effort change that holds gpt-5.1 does not reach gpt-5.3-codex (low through
    // xhigh, Responses only). This does: the guide tells a migration from GPT-5.5 or earlier to
    // replace prompt_cache_retention with prompt_cache_options.ttl. No parameter rule names the
    // GPT-6 family, so the TypeScript guard does not look at a swap to gpt-6-sol, and Python has
    // no guard. Swapped as verified, `prompt_cache_retention="24h"` stayed in the request.
    const record = find('gpt-5.3-codex');
    expect(record.verification?.status).toBe('quarantined');
    expect(record.verification?.autoApplyAllowed).toBe(false);
    expect(record.verification?.replacementConfirmed).toBe(true);
    expect(record.verification?.quarantineReason).toContain('prompt_cache_retention');
    expect(record.verification?.quarantineReason).toContain('prompt_cache_options.ttl');
    expect(record.evidence?.map((ref) => ref.excerpt)).toContain(
      'When migrating from GPT-5.5 or earlier, replace prompt_cache_retention with prompt_cache_options.ttl set to "30m".',
    );
    expect(isVerified(record)).toBe(false);
  });

  it('holds gpt-5.1 and gpt-5.4-nano for review: GPT-6 Sol and Luna default to a different reasoning effort', () => {
    // The gate verified both (the replacement is live in models.dev). They are quarantined
    // because OpenAI's model pages give gpt-5.1 and gpt-5.4-nano a default reasoning effort of
    // none and GPT-6 Sol and Luna a default of medium, and OpenAI's GPT-6 guide says that above
    // none, temperature, top_p and top_logprobs must be removed, and function calling in Chat
    // Completions needs none. An id swap alone can break a call that works today.
    for (const id of ['gpt-5.1', 'gpt-5.4-nano']) {
      const record = find(id);
      expect(record.verification?.status, id).toBe('quarantined');
      expect(record.verification?.autoApplyAllowed, id).toBe(false);
      expect(record.verification?.replacementConfirmed, id).toBe(true);
      expect(record.verification?.quarantineReason, id).toMatch(/reasoning effort/);
      expect(record.verification?.quarantineReason, id).toMatch(/reasoning_effort/);
      expect(isVerified(record), id).toBe(false);
    }
  });

  it('never auto-applies a row that names two replacements or changes the kind of model', () => {
    for (const id of [
      'whisper-1',
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'gpt-4o-transcribe-diarize',
      'gpt-4-turbo-preview-completions',
      'veo-3.0-generate-001',
      'veo-3.0-fast-generate-001',
      'veo-2.0-generate-001',
      'tts-1',
      'tts-1-hd',
      'gpt-4o-mini-tts-2025-03-20',
      'gpt-4o-mini-tts-2025-12-15',
      'gpt-4o-audio',
      'gpt-4o-mini-audio',
      'gpt-4o-mini-realtime',
    ]) {
      const record = find(id);
      expect(record.verification?.autoApplyAllowed, id).toBe(false);
      expect(record.verification?.status, id).not.toBe('verified');
    }
  });

  it('names both transcription replacements in the note, and says which workflow each one serves', () => {
    for (const id of ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize']) {
      const note = find(id).note ?? '';
      expect(note, id).toContain('gpt-live-transcribe or gpt-transcribe');
      expect(note, id).toContain('file transcription');
      expect(note, id).toContain('live audio');
    }
  });
});

// The dated snapshots those rows leave out. OpenAI's deprecations page names the gpt-5.1 and
// gpt-5.4-nano aliases and the gpt-4o-audio, gpt-4o-mini-audio and gpt-4o-mini-realtime families,
// and mendr matches exact ids, so a call or a usage row on a pinned snapshot got nothing. Each
// snapshot's model page (stored under registries/evidence/) lists it and marks the model
// Deprecated. The page never gives the snapshot a date of its own, so none of these records claims
// one: a future retirement must be stated by the provider for the id.
const SNAPSHOTS: Record<string, { parent: string; page: string; status: 'quarantined' | 'unverifiable' }> = {
  'gpt-5.1-2025-11-13': { parent: 'gpt-5.1', page: '69a7cf7832b7', status: 'quarantined' },
  'gpt-5.4-nano-2026-03-17': { parent: 'gpt-5.4-nano', page: '261bf9b9790c', status: 'quarantined' },
  'gpt-4o-audio-preview-2025-06-03': { parent: 'gpt-4o-audio', page: 'ac22c96d7566', status: 'unverifiable' },
  'gpt-4o-audio-preview-2024-12-17': { parent: 'gpt-4o-audio', page: 'ac22c96d7566', status: 'unverifiable' },
  'gpt-4o-mini-audio-preview-2024-12-17': { parent: 'gpt-4o-mini-audio', page: 'a482d9dbe55b', status: 'unverifiable' },
  'gpt-4o-mini-realtime-preview-2024-12-17': { parent: 'gpt-4o-mini-realtime', page: 'ef4d2c830276', status: 'quarantined' },
};

const evidenceDir = resolveEvidenceDir();
const page = (name: string): string => readFileSync(join(evidenceDir, `${name}.txt`), 'utf8');

describe('the dated snapshots the 2026-10-10 rows leave out', () => {
  it("names the alias's or the family's replacement, and claims no shutdown date", () => {
    for (const [id, want] of Object.entries(SNAPSHOTS)) {
      const record = find(id);
      expect(record.replacement, id).toBe(find(want.parent).replacement);
      expect(record.status, id).toBe('deprecated');
      expect(record.shutdownDate, id).toBeUndefined();
      expect(record.entryId, id).toBe(`openai.${id}.retirement-undated`);
    }
  });

  it('is never an automatic swap', () => {
    // gpt-5.x: the reasoning-effort change that holds their aliases. Audio: the catalogs do not
    // list the class. Realtime: quarantined, so a catalog that later lists gpt-realtime-2.1-mini
    // cannot make an undated record automatic on a re-stamp.
    for (const [id, want] of Object.entries(SNAPSHOTS)) {
      const record = find(id);
      expect(record.verification?.status, id).toBe(want.status);
      expect(record.verification?.autoApplyAllowed, id).toBe(false);
      expect(isVerified(record), id).toBe(false);
      if (want.status === 'quarantined') expect(record.verification?.quarantineReason, id).toBeTruthy();
    }
  });

  it('quotes its model page naming it, and every ref it cites is stored', () => {
    for (const [id, want] of Object.entries(SNAPSHOTS)) {
      const [modelPage] = find(id).evidence ?? [];
      expect(snapshotName(modelPage), id).toBe(`${want.page}.txt`);
      expect(modelPage.excerpt, id).toContain(id);
      expect(quoteIsOnPage(modelPage.excerpt!, page(want.page)), id).toBe(true);
      for (const ref of find(id).evidence ?? []) {
        expect(existsSync(join(evidenceDir, snapshotName(ref))), `${id}: ${ref.contentHash}`).toBe(true);
      }
    }
  });

  it("passes check-dates against OpenAI's stored page: not judged, never failing", () => {
    // The date check reads the deprecations page as of 2026-10-10. A snapshot record that copied
    // its alias's date would fail it ("absent", or "inferred-future" with inferredFrom set).
    const { facts } = readModelRows(page('461d3951ff15'), 'openai');
    const results = checkDates(registry, { openai: facts }, '2026-10-10');
    for (const id of Object.keys(SNAPSHOTS)) {
      const r = results.find((x) => x.deprecated === id)!;
      expect({ verdict: r.verdict, reason: r.reason }, id).toEqual({ verdict: 'unchecked', reason: 'claims no shutdown date' });
    }
    for (const id of Object.keys(ADDED).filter((x) => find(x).provider === 'openai')) {
      expect(results.find((x) => x.deprecated === id)?.verdict, id).toBe('confirmed');
    }
  });

  it('flags a TypeScript call on the pinned gpt-5.1 snapshot for review, as it does the alias', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'src/chat.ts',
      [
        "import OpenAI from 'openai';",
        'const client = new OpenAI();',
        'export const run = (messages: any) =>',
        "  client.chat.completions.create({ model: 'gpt-5.1-2025-11-13', temperature: 0.2, messages });",
      ].join('\n'),
    );
    const matches = findModelIdLiterals(project, registry);
    expect(matches.map((m) => m.value)).toEqual(['gpt-5.1-2025-11-13']);
    const [m] = matches;
    expect(classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason })).toEqual({
      tier: 'B',
      reason: 'replacement_unverified',
    });
  });

  it('flags a Python call on a gpt-4o-audio snapshot for review', async () => {
    const text = [
      'from openai import OpenAI',
      'client = OpenAI()',
      'client.chat.completions.create(model="gpt-4o-audio-preview-2025-06-03", modalities=["text", "audio"], messages=[])',
    ].join('\n');
    const matches = await findPyModelIdLiterals([{ path: 'app/voice.py', text }], registry);
    expect(matches.map((m) => m.value)).toEqual(['gpt-4o-audio-preview-2025-06-03']);
    const [m] = matches;
    expect(classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier).toBe('B');
  });

  it('reports usage of a pinned snapshot as exposure, with no deadline', () => {
    const row = (model: string) => ({ provider: 'openai' as const, model, requests: 10, inputTokens: 100, outputTokens: 50, costUsd: 1 });
    const audit = auditUsage([row('gpt-5.4-nano-2026-03-17'), row('gpt-5.4-mini')], registry, new Date('2026-10-10T00:00:00Z'));
    const snapshot = audit.models.find((f) => f.model === 'gpt-5.4-nano-2026-03-17')!;
    expect(snapshot.deprecated).toBe(true);
    expect(snapshot.replacement).toBe('gpt-6-luna');
    expect(snapshot.shutdownDate).toBeNull();
    expect(snapshot.daysUntil).toBeNull();
    // Negative case: a current model beside it is not exposure.
    expect(audit.models.find((f) => f.model === 'gpt-5.4-mini')?.deprecated).toBe(false);
    expect(audit.exposed.map((f) => f.model)).toEqual(['gpt-5.4-nano-2026-03-17']);
  });
});

describe('the gpt-4o-audio, gpt-4o-mini-audio and gpt-4o-mini-realtime family rows', () => {
  // OpenAI's rows name model families. No OpenAI page lists a model by the literal family id: the
  // callable ids are the -preview alias and its dated snapshots. The notes used to say the record
  // "flags the literal id", which read as coverage of the family.
  const FAMILIES: Record<string, { page: string; alias: string; snapshots: string[] }> = {
    'gpt-4o-audio': {
      page: 'ac22c96d7566',
      alias: 'gpt-4o-audio-preview',
      snapshots: ['gpt-4o-audio-preview-2025-06-03', 'gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview-2024-10-01'],
    },
    'gpt-4o-mini-audio': { page: 'a482d9dbe55b', alias: 'gpt-4o-mini-audio-preview', snapshots: ['gpt-4o-mini-audio-preview-2024-12-17'] },
    'gpt-4o-mini-realtime': {
      page: 'ef4d2c830276',
      alias: 'gpt-4o-mini-realtime-preview',
      snapshots: ['gpt-4o-mini-realtime-preview-2024-12-17'],
    },
  };

  it('says in the note that no callable id matches the record', () => {
    for (const family of Object.keys(FAMILIES)) {
      const note = find(family).note ?? '';
      expect(note, family).toContain(`no model by the literal id ${family}`);
      expect(note, family).toContain('which no OpenAI page lists as callable');
      expect(note, family).not.toContain('flags the literal id');
    }
  });

  it("rests that on the family's model page, which lists the callable ids and not the family id", () => {
    for (const [family, want] of Object.entries(FAMILIES)) {
      const text = page(want.page);
      for (const id of [want.alias, ...want.snapshots]) expect(quoteIsOnPage(id, text), `${family}: ${id}`).toBe(true);
      // The family id as a whole token, never as the start of a longer id.
      const bare = new RegExp(`(^|[^a-z0-9.-])${family}([^a-z0-9.-]|$)`);
      expect(bare.test(normalizePageText(text)), family).toBe(false);
      expect(find(family).evidence?.some((ref) => snapshotName(ref) === `${want.page}.txt`), family).toBe(true);
    }
  });

  it('gives every callable dated snapshot a record of its own; an alias without one is named in the note', () => {
    const has = (id: string) => entries.some((e) => e.deprecated === id);
    for (const [family, want] of Object.entries(FAMILIES)) {
      for (const id of want.snapshots) expect(has(id), id).toBe(true);
      if (!has(want.alias)) expect(find(family).note, family).toContain(`${want.alias} has none yet`);
    }
  });
});
