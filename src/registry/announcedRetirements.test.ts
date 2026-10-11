import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { isVerified, loadLlmRegistry, modelIdEntries, resolveRegistryPath } from '../usage/llmRegistry.js';
import { checkDeprecationClaim } from './claimCheck.js';
import { resolveEvidenceDir } from './evidence.js';

// The dated retirements added on 2026-10-10 from OpenAI's and Google's deprecation pages, read from
// the SHIPPED registry. Twenty records: three through `mendr candidates promote`, the rest by the
// documented review-only path, each stamped by the gate's own classifier.

const entries = modelIdEntries(loadLlmRegistry(resolveRegistryPath()));
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
