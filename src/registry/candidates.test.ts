import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CandidateEntry, EvidenceRef, LlmRegistry } from '../types.js';
import { snapshotName } from './evidence.js';
import { canonicalizeId, familyOf } from './normalize.js';
import type { VerificationOracles } from './verify.js';
import { addCandidate, loadCandidates, promoteCandidates, saveCandidates } from './candidates.js';

// The human gate, tested end to end through promoteCandidates. No network, no
// clock: the oracle bundle is hand-built exactly as verify.test.ts builds it,
// and the snapshot directory is a real temp dir holding the files the evidence
// refs name (rule 5 asks the filesystem whether a ref can be read back).

function liveSet(...ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const id of ids) {
    set.add(canonicalizeId(id));
    set.add(familyOf(id));
  }
  return set;
}

const ORACLES: VerificationOracles = {
  // gpt-4o-mini is in the catalogs on purpose: it is the live model the
  // regression test below tries to promote as retired.
  liveIds: liveSet('claude-opus-4-8', 'gpt-5.6-sol', 'gpt-4o', 'gpt-4o-mini'),
  officialRecommendations: new Map([[canonicalizeId('claude-3-opus-20240229'), 'claude-opus-4-8']]),
};

const EVIDENCE: EvidenceRef[] = [
  {
    sourceUrl: 'https://example.test/deprecations',
    contentHash: `sha256:${'a'.repeat(64)}`,
    retrievedAt: '2026-08-20T12:00:00.000Z',
    excerpt: 'January 5, 2026 | claude-3-opus-20240229 | claude-opus-4-8',
  },
];

/** A snapshot dir that really holds the files the given refs name. */
function snapshotDirWith(...refs: EvidenceRef[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-promote-evidence-'));
  for (const ref of refs) writeFileSync(join(dir, snapshotName(ref)), 'the stored page text');
  return dir;
}

const SNAPSHOT_DIR = snapshotDirWith(EVIDENCE[0]);

function candidate(over: Partial<CandidateEntry> = {}): CandidateEntry {
  return {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    status: 'retired',
    evidence: EVIDENCE,
    candidateId: 'anthropic:claude-3-opus-20240229',
    proposedBy: 'discovery',
    proposedAt: '2026-08-20T12:00:00.000Z',
    ...over,
  };
}

function tempFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mendr-candidates-')), 'candidates.json');
  writeFileSync(path, contents);
  return path;
}

describe('loadCandidates — validation', () => {
  it('reads a well-formed queue', () => {
    const path = tempFile(JSON.stringify([candidate()]));
    const [loaded] = loadCandidates(path);
    expect(loaded.candidateId).toBe('anthropic:claude-3-opus-20240229');
    expect(loaded.evidence?.[0].contentHash).toBe(EVIDENCE[0].contentHash);
  });

  it('accepts an empty queue', () => {
    expect(loadCandidates(tempFile('[]'))).toEqual([]);
  });

  it('HARD-errors on a missing candidateId', () => {
    const { candidateId: _drop, ...rest } = candidate();
    expect(() => loadCandidates(tempFile(JSON.stringify([rest])))).toThrow(/candidateId/);
  });

  it('HARD-errors on an unknown proposedBy', () => {
    const path = tempFile(JSON.stringify([candidate({ proposedBy: 'the-vibes' as never })]));
    expect(() => loadCandidates(path)).toThrow(/proposedBy/);
  });

  it('HARD-errors on a malformed contentHash', () => {
    const path = tempFile(
      JSON.stringify([candidate({ evidence: [{ ...EVIDENCE[0], contentHash: 'md5:beef' }] })]),
    );
    expect(() => loadCandidates(path)).toThrow(/contentHash/);
  });

  it('HARD-errors on an empty evidence array (a claim of proof with none)', () => {
    expect(() => loadCandidates(tempFile(JSON.stringify([candidate({ evidence: [] })])))).toThrow(
      /empty "evidence"/,
    );
  });

  it('HARD-errors on a param entry (candidates are model_id only)', () => {
    const path = tempFile(
      JSON.stringify([
        {
          provider: 'openai',
          kind: 'param_rename',
          param: 'max_tokens',
          replacement: 'max_completion_tokens',
          on_models: ['o1'],
          candidateId: 'openai:max_tokens',
          proposedBy: 'human',
          proposedAt: '2026-08-20T12:00:00.000Z',
        },
      ]),
    );
    expect(() => loadCandidates(path)).toThrow(/model_id entries only/);
  });

  it('HARD-errors on a duplicate candidateId', () => {
    const path = tempFile(JSON.stringify([candidate(), candidate()]));
    expect(() => loadCandidates(path)).toThrow(/duplicate candidateId/);
  });

  it('round-trips through saveCandidates', () => {
    const path = tempFile('[]');
    saveCandidates([candidate()], path);
    expect(loadCandidates(path)).toEqual([candidate()]);
  });
});

describe('addCandidate', () => {
  it('appends without mutating the input array', () => {
    const queue: CandidateEntry[] = [];
    const next = addCandidate(queue, candidate());
    expect(queue).toHaveLength(0);
    expect(next).toHaveLength(1);
  });

  it('refuses a duplicate id rather than silently overwriting a pending proposal', () => {
    expect(() => addCandidate([candidate()], candidate())).toThrow(/already queued/);
  });
});

describe('promoteCandidates — the HARD RULES', () => {
  const empty: LlmRegistry = [];

  it('promotes a verified, evidence-backed candidate', () => {
    const c = candidate();
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.refused).toEqual([]);
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].verification?.status).toBe('verified');
    // The candidate bookkeeping fields do NOT survive into the active registry.
    expect(result.promoted[0]).not.toHaveProperty('candidateId');
    expect(result.promoted[0]).not.toHaveProperty('proposedBy');
    expect(result.nextRegistry).toHaveLength(1);
    expect(result.nextCandidates).toEqual([]);
  });

  it('REFUSES a candidate that does not classify as verified', () => {
    // Replacement is live nowhere in the catalog -> unverified -> blocked.
    const c = candidate({
      deprecated: 'claude-2.0',
      replacement: 'claude-imaginary-9',
      candidateId: 'anthropic:claude-2-0',
    });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/classifies as unverified, not verified/);
    expect(result.refused[0].reason).toMatch(/not found live/);
    // Nothing moved, so both files are unchanged.
    expect(result.nextRegistry).toEqual(empty);
    expect(result.nextCandidates).toEqual([c]);
  });

  it('REFUSES an out-of-class (unverifiable) candidate too -- only `verified` passes', () => {
    const c = candidate({
      provider: 'openai',
      deprecated: 'text-moderation-007',
      replacement: 'omni-moderation',
      candidateId: 'openai:text-moderation-007',
    });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/classifies as unverifiable/);
  });

  it('REFUSES a candidate with no evidence, however well it classifies', () => {
    const c = candidate({ evidence: undefined });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/no evidence captured/);
  });

  it('REFUSES an unknown candidateId', () => {
    const result = promoteCandidates([candidate()], empty, {
      ids: ['anthropic:not-a-thing'],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.refused[0].reason).toMatch(/no candidate with candidateId/);
    expect(result.nextCandidates).toHaveLength(1);
  });

  it('REFUSES a candidate the active registry already covers', () => {
    const active: LlmRegistry = [
      {
        provider: 'anthropic',
        kind: 'model_id',
        deprecated: 'claude-3-opus-20240229',
        replacement: 'claude-opus-4-8',
      },
    ];
    const c = candidate();
    const result = promoteCandidates([c], active, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/already has an entry/);
  });

  it('promotes only the ids NAMED, leaving every other candidate pending', () => {
    const named = candidate();
    const other = candidate({
      deprecated: 'gpt-4-0613',
      replacement: 'gpt-5.6-sol',
      provider: 'openai',
      candidateId: 'openai:gpt-4-0613',
    });
    const result = promoteCandidates([named, other], empty, {
      ids: [named.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toHaveLength(1);
    expect(result.nextCandidates.map((c) => c.candidateId)).toEqual([other.candidateId]);
  });

  it('recomputes verification rather than trusting a stamp the candidate carried in', () => {
    // The attack this closes: a research run writes `verification: verified`
    // onto its own proposal. The gate must ignore that entirely.
    const c = candidate({
      replacement: 'claude-imaginary-9',
      verification: { status: 'verified', reasons: ['trust me'] },
    });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/classifies as unverified/);
  });

  it('stamps the checkedAt/sources it was given, not the candidate\'s own', () => {
    const c = candidate();
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
      checkedAt: '2026-08-20',
      sources: ['models.dev', 'openrouter'],
    });
    expect(result.promoted[0].verification).toMatchObject({
      status: 'verified',
      checkedAt: '2026-08-20',
      sources: ['models.dev', 'openrouter'],
    });
  });

  it('is pure: neither input array is mutated', () => {
    const queue = [candidate()];
    const registry: LlmRegistry = [];
    promoteCandidates(queue, registry, {
      ids: [queue[0].candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(queue).toHaveLength(1);
    expect(registry).toHaveLength(0);
  });
});

// The SOURCE half of the gate, exercised through the real promote path. The
// rules themselves are unit-tested in claimCheck.test.ts; what these prove is
// that promoteCandidates actually CONSULTS them — a check that exists but is
// never called is the hole this whole file is about.
describe('promoteCandidates — the deprecation claim (source-side gate)', () => {
  const empty: LlmRegistry = [];

  it('a live model claimed retired is refused', () => {
    // THE EXPLOIT, verbatim: gpt-4o-mini is very much alive, the replacement
    // gpt-4o is live and uncontradicted, and the evidence ref is well-formed.
    // classifyEntry() says `verified` — it only ever looked at the replacement.
    // Before the source-side check this PROMOTED, and the fix engine then
    // auto-rewrote every gpt-4o-mini call site in the user's repo.
    const exploitRef: EvidenceRef = {
      sourceUrl: 'https://platform.openai.com/docs/deprecations',
      contentHash: `sha256:${'c'.repeat(64)}`,
      retrievedAt: '2026-08-20T12:00:00.000Z',
      excerpt: 'gpt-4o-mini has been retired; use gpt-4o instead',
    };
    const c = candidate({
      provider: 'openai',
      deprecated: 'gpt-4o-mini',
      replacement: 'gpt-4o',
      status: 'retired',
      evidence: [exploitRef],
      candidateId: 'openai:gpt-4o-mini',
    });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: snapshotDirWith(exploitRef), // even WITH a real snapshot
    });

    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(
      /claims calls to "gpt-4o-mini" fail today; the catalogs say otherwise/,
    );
    // Nothing moved: the active registry is untouched and the candidate stays queued.
    expect(result.nextRegistry).toEqual(empty);
    expect(result.nextCandidates).toEqual([c]);
  });

  it('REFUSES a candidate with no status at all', () => {
    const c = candidate({ status: undefined });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/no "status".*unproven claim/);
  });

  it('REFUSES `deprecated` with no shutdownDate', () => {
    const c = candidate({ status: 'deprecated' });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/no "shutdownDate"/);
  });

  it('PROMOTES an announced deprecation: status + shutdownDate + a naming quote', () => {
    const c = candidate({ status: 'deprecated', shutdownDate: '2026-01-05' });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.refused).toEqual([]);
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].shutdownDate).toBe('2026-01-05');
  });

  it('REFUSES when no excerpt names the deprecated id', () => {
    const c = candidate({
      evidence: [{ ...EVIDENCE[0], excerpt: 'January 5, 2026 | some-other-model | claude-opus-4-8' }],
    });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(/no evidence excerpt quotes/);
  });

  it('REFUSES a ref with no snapshot on disk (unbacked evidence)', () => {
    const c = candidate();
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: snapshotDirWith(), // an empty evidence directory
    });
    expect(result.promoted).toEqual([]);
    expect(result.refused[0].reason).toMatch(
      /evidence ref is unbacked \(no snapshot stored for sha256:a{64}\) -- cannot be checked offline/,
    );
  });

  it('names the SOURCE as the problem, so nobody re-checks a replacement that is fine', () => {
    const c = candidate({ status: undefined });
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    expect(result.refused[0].reason).toContain(
      'this refusal is about "claude-3-opus-20240229", not "claude-opus-4-8"',
    );
  });

  it('stamps the boundary onto the promoted entry: coherent + quoted, NOT confirmed', () => {
    const c = candidate();
    const result = promoteCandidates([c], empty, {
      ids: [c.candidateId],
      oracles: ORACLES,
      snapshotDir: SNAPSHOT_DIR,
    });
    const reasons = result.promoted[0].verification?.reasons ?? [];
    expect(reasons.join(' ')).toMatch(/did NOT independently confirm the provider retired it/);
  });
});
