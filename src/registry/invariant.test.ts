import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import type { CandidateEntry } from '../types.js';
import {
  loadLlmRegistry,
  modelIdEntries,
  resolveRegistryPath,
  autoApplyVerification,
} from '../usage/llmRegistry.js';
import { buildRegistryPrefilter } from '../usage/scanRepo.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { loadCandidates, resolveCandidatesPath, saveCandidates } from './candidates.js';
import { saveSnapshot } from './evidence.js';
import { discoverCandidates, PROVIDER_SOURCES } from './discover.js';

// THE INVARIANT, tested against the REAL on-disk files:
//   the fix engine reads registries/llm-deprecations.json and NOTHING ELSE.
// A candidate can therefore never produce a finding, never appear in a diff,
// and never be --written into anyone's working tree, no matter who proposed it
// or how confident they were.

const REGISTRY_PATH = resolveRegistryPath();
const CANDIDATES_PATH = resolveCandidatesPath();

/** A model id chosen to exist NOWHERE in the shipped registry. */
const PROBE_ID = 'gpt-4-mendr-invariant-probe';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const probe: CandidateEntry = {
  provider: 'openai',
  kind: 'model_id',
  deprecated: PROBE_ID,
  replacement: 'gpt-5.6-sol',
  // Deliberately maximal: stamped `verified`, fully evidenced. Even a candidate
  // that looks completely trustworthy must be invisible to the engine.
  verification: autoApplyVerification({ checkedAt: '2026-08-20', reasons: ['fixture'] }),
  evidence: [
    {
      sourceUrl: 'https://example.test/deprecations',
      contentHash: `sha256:${'a'.repeat(64)}`,
      retrievedAt: '2026-08-20T12:00:00.000Z',
    },
  ],
  candidateId: `openai:${PROBE_ID}`,
  proposedBy: 'llm-research',
  proposedAt: '2026-08-20T12:00:00.000Z',
};

// The queue's real contents are restored no matter how the assertions land.
const originalCandidates = readFileSync(CANDIDATES_PATH, 'utf8');
afterAll(() => writeFileSync(CANDIDATES_PATH, originalCandidates));

describe('a queued candidate is INERT to the fix engine', () => {
  // The probe is written to the REAL queue file: this invariant is about the
  // files that ship, not about a temp copy of them.
  beforeAll(() => {
    saveCandidates([...loadCandidates(CANDIDATES_PATH), probe], CANDIDATES_PATH);
  });

  it('really is on disk, in the file a human reviews', () => {
    expect(loadCandidates(CANDIDATES_PATH).some((c) => c.deprecated === PROBE_ID)).toBe(true);
  });

  it('never reaches the registry the engine loads', () => {
    expect(modelIdEntries(loadLlmRegistry()).some((e) => e.deprecated === PROBE_ID)).toBe(false);
  });

  it('produces ZERO findings from the model-id locator', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'app.ts',
      `const client = {} as any;\n` +
        `await client.chat.completions.create({ model: "${PROBE_ID}", messages: [] });\n`,
    );
    expect(findModelIdLiterals(project, loadLlmRegistry())).toHaveLength(0);
  });

  it('contributes no token to the scan pre-filter', () => {
    // NOT "the prefilter rejects the probe file": the prefilter is a coarse
    // substring pre-scan built from registry tokens, and the probe id contains
    // the real token `gpt-4`, so a file holding it IS parsed — and then finds
    // nothing, which is the locator assertion above. What matters here is that
    // the candidate added no token of its own to the scan surface.
    expect(buildRegistryPrefilter(loadLlmRegistry())?.source ?? '').not.toContain(
      'invariant-probe',
    );
  });

  it('loadLlmRegistry resolves the active registry, never the candidate queue', () => {
    expect(REGISTRY_PATH).toMatch(/llm-deprecations\.json$/);
    expect(REGISTRY_PATH).not.toBe(CANDIDATES_PATH);
  });
});

describe('a discover --write run leaves the active registry byte-identical', () => {
  it('writes candidates and snapshots and nothing else', async () => {
    const before = sha256File(REGISTRY_PATH);

    // Exactly what the `discover --write` CLI path does, with the network
    // stubbed: discover, snapshot every fetched document, save the queue.
    const html =
      '<table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr>' +
      '<tr><td>January 5, 2026</td><td>claude-9-probe-20240229</td><td>claude-opus-4-8</td></tr></table>';
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => html }) as unknown as Response) as unknown as typeof fetch;

    const result = await discoverCandidates(['anthropic'], {
      activeRegistry: loadLlmRegistry(),
      existingCandidates: loadCandidates(CANDIDATES_PATH),
      fetchImpl,
      now: () => '2026-08-20T12:00:00.000Z',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sourceUrl).toBe(PROVIDER_SOURCES.anthropic);

    const snapshotDir = mkdtempSync(join(tmpdir(), 'mendr-snapshots-'));
    for (const doc of result.documents) saveSnapshot(snapshotDir, doc.ref, doc.text);
    saveCandidates(
      [...loadCandidates(CANDIDATES_PATH), ...result.candidates],
      CANDIDATES_PATH,
    );

    // The queue moved; the file the engine reads did not.
    expect(loadCandidates(CANDIDATES_PATH).some((c) => c.deprecated === 'claude-9-probe-20240229')).toBe(
      true,
    );
    expect(sha256File(REGISTRY_PATH)).toBe(before);
  });
});
