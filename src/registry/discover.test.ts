import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CandidateEntry, LlmRegistry } from '../types.js';
import {
  candidateIdFor,
  discoverCandidates,
  extractRows,
  parseShutdownDate,
  PROVIDER_SOURCES,
} from './discover.js';

// Hermetic discovery tests. The parser is fed fixture markup shaped like the
// real provider pages (same column headers, same messy cells), and the one
// network call goes through an injected fetch stub.

/** OpenAI-shaped page: one clean table, one ambiguous, one that is not a table of models. */
const OPENAI_HTML = `
<h2>Model deprecations</h2>
<table>
  <tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr>
  <tr><td>2026-09-28</td><td>gpt-3.5-turbo-instruct</td><td>gpt-5.6-terra</td></tr>
  <tr><td>Jan 20, 2027</td><td>gpt-realtime</td><td>gpt-realtime-2.1</td></tr>
  <tr><td>2026&#8209;03&#8209;26</td><td>gpt-4-0314</td><td>gpt-5 or gpt-4.1*</td></tr>
  <tr><td>2026-09-24</td><td>Videos API</td><td>---</td></tr>
  <tr><td>2026-01-01</td><td>gpt-4o</td><td>gpt-4o</td></tr>
</table>
<table>
  <tr><th>Shutdown date</th><th>Model snapshot</th><th>Substitute model</th></tr>
  <tr><td>October 23, 2026</td><td>gpt-4-0613 | gpt-4 , gpt-4-completions</td><td>gpt-5.6-sol</td></tr>
</table>
<table>
  <tr><th>Date</th><th>Update</th></tr>
  <tr><td>June 3, 2026</td><td>Deprecation announced for the Evals platform.</td></tr>
</table>
`;

/** Anthropic-shaped page: an "active models" table (no replacement column) plus a real one. */
const ANTHROPIC_HTML = `
<table>
  <tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr>
  <tr><td>claude-opus-4-8</td><td>Active</td><td>N/A</td><td>Not sooner than May 28, 2027</td></tr>
</table>
<table>
  <tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr>
  <tr><td>January 5, 2026</td><td>claude-3-opus-20240229</td><td>claude-opus-4-8</td></tr>
</table>
`;

const FIXED_NOW = () => '2026-08-20T12:00:00.000Z';

/** A fetch stub keyed by URL, so a multi-provider run stays deterministic. */
function stubFetch(bodies: Record<string, string>): typeof fetch {
  return (async (url: string | URL) => {
    const body = bodies[String(url)];
    if (body === undefined) throw new Error(`unstubbed url: ${String(url)}`);
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('parseShutdownDate', () => {
  it('reads an ISO date', () => {
    expect(parseShutdownDate('2026-09-28')).toBe('2026-09-28');
  });

  it('reads a named month, short or long', () => {
    expect(parseShutdownDate('Jan 20, 2027')).toBe('2027-01-20');
    expect(parseShutdownDate('October 23, 2026')).toBe('2026-10-23');
  });

  it('reads a date written with non-breaking hyphens', () => {
    expect(parseShutdownDate('2026‑3‑26')).toBeUndefined();
    expect(parseShutdownDate('2026‑03‑26')).toBe('2026-03-26');
  });

  it('returns undefined when the cell announces no date', () => {
    expect(parseShutdownDate('No shutdown date announced')).toBeUndefined();
  });
});

describe('extractRows — reads what it can, SKIPS what it cannot', () => {
  const { rows, skipped } = extractRows(OPENAI_HTML, 'openai');
  const byId = new Map(rows.map((r) => [r.deprecated, r]));

  it('reads an unambiguous one-to-one row', () => {
    expect(byId.get('gpt-3.5-turbo-instruct')).toMatchObject({
      replacement: 'gpt-5.6-terra',
      shutdownDate: '2026-09-28',
    });
  });

  it('normalizes a named-month shutdown date', () => {
    expect(byId.get('gpt-realtime')?.shutdownDate).toBe('2027-01-20');
  });

  it('SKIPS a row whose replacement cell offers a choice', () => {
    expect(byId.has('gpt-4-0314')).toBe(false);
    expect(skipped.map((s) => s.reason).join('\n')).toMatch(/replacement cell offers 2 model ids/);
  });

  it('SKIPS a row whose deprecated cell names several ids', () => {
    expect(byId.has('gpt-4-0613')).toBe(false);
    expect(skipped.map((s) => s.reason).join('\n')).toMatch(/deprecated cell names 3 model ids/);
  });

  it('ignores a product/endpoint row that is not a model id at all', () => {
    // "Videos API" -> "---" never becomes a candidate AND never becomes noise:
    // a row with no model id in the deprecated cell is not a claim to skip.
    expect(rows.some((r) => /videos/i.test(r.deprecated))).toBe(false);
  });

  it('SKIPS a row that maps a model to itself', () => {
    expect(skipped.map((s) => s.reason).join('\n')).toMatch(/maps a model id to itself/);
  });

  it('SKIPS a whole table with no replacement column instead of inventing one', () => {
    const anthropic = extractRows(ANTHROPIC_HTML, 'anthropic');
    expect(anthropic.rows).toHaveLength(1);
    expect(anthropic.rows[0]).toMatchObject({
      deprecated: 'claude-3-opus-20240229',
      replacement: 'claude-opus-4-8',
      shutdownDate: '2026-01-05',
    });
    expect(anthropic.skipped.map((s) => s.reason).join('\n')).toMatch(
      /0 replacement columns \(need exactly 1\)/,
    );
  });

  it('is deterministic: the same html yields the identical result twice', () => {
    expect(extractRows(OPENAI_HTML, 'openai')).toEqual(extractRows(OPENAI_HTML, 'openai'));
  });

  it('rejects ids that do not carry the provider prefix', () => {
    // The anthropic parser must not adopt OpenAI's table.
    expect(extractRows(OPENAI_HTML, 'anthropic').rows).toHaveLength(0);
  });
});

describe('discoverCandidates', () => {
  const fetchImpl = stubFetch({
    [PROVIDER_SOURCES.openai]: OPENAI_HTML,
    [PROVIDER_SOURCES.anthropic]: ANTHROPIC_HTML,
  });

  it('produces candidates stamped `discovery`, with evidence and NO verification', async () => {
    const result = await discoverCandidates(['openai'], {
      activeRegistry: [],
      existingCandidates: [],
      fetchImpl,
      now: FIXED_NOW,
    });
    const first = result.candidates.find((c) => c.deprecated === 'gpt-3.5-turbo-instruct')!;
    expect(first.proposedBy).toBe('discovery');
    expect(first.proposedAt).toBe('2026-08-20T12:00:00.000Z');
    expect(first.candidateId).toBe(candidateIdFor('openai', 'gpt-3.5-turbo-instruct'));
    expect(first.sourceUrl).toBe(PROVIDER_SOURCES.openai);
    // Discovery states what a page said; it never claims trust.
    expect(first.verification).toBeUndefined();
    expect(first.evidence).toHaveLength(1);
    expect(first.evidence![0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.evidence![0].excerpt).toMatch(/gpt-3\.5-turbo-instruct/);
  });

  it('derives lifecycle from the injected clock, never from the wall clock', async () => {
    const result = await discoverCandidates(['openai'], {
      activeRegistry: [],
      existingCandidates: [],
      fetchImpl,
      now: FIXED_NOW,
    });
    // 2026-09-28 is after the injected 2026-08-20 -> still live, dying later.
    expect(result.candidates.find((c) => c.deprecated === 'gpt-3.5-turbo-instruct')?.status).toBe(
      'deprecated',
    );
    // 2027-01-20 likewise.
    expect(result.candidates.find((c) => c.deprecated === 'gpt-realtime')?.status).toBe('deprecated');
  });

  it('dedupes against the ACTIVE registry', async () => {
    const active: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-3.5-turbo-instruct',
        replacement: 'gpt-5.6-terra',
      },
    ];
    const result = await discoverCandidates(['openai'], {
      activeRegistry: active,
      existingCandidates: [],
      fetchImpl,
      now: FIXED_NOW,
    });
    expect(result.candidates.some((c) => c.deprecated === 'gpt-3.5-turbo-instruct')).toBe(false);
  });

  it('dedupes against the EXISTING queue', async () => {
    const existing: CandidateEntry[] = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-realtime',
        replacement: 'gpt-realtime-2.1',
        candidateId: 'openai:gpt-realtime',
        proposedBy: 'human',
        proposedAt: '2026-07-01T00:00:00.000Z',
      },
    ];
    const result = await discoverCandidates(['openai'], {
      activeRegistry: [],
      existingCandidates: existing,
      fetchImpl,
      now: FIXED_NOW,
    });
    expect(result.candidates.some((c) => c.deprecated === 'gpt-realtime')).toBe(false);
  });

  it('notes a failing provider instead of aborting the whole run', async () => {
    const flaky = stubFetch({ [PROVIDER_SOURCES.anthropic]: ANTHROPIC_HTML });
    const result = await discoverCandidates(['openai', 'anthropic'], {
      activeRegistry: [],
      existingCandidates: [],
      fetchImpl: flaky,
      now: FIXED_NOW,
    });
    expect(result.notes.join('\n')).toMatch(/openai FAILED/);
    expect(result.candidates.some((c) => c.provider === 'anthropic')).toBe(true);
  });

  it('hands back the fetched documents so the caller can commit snapshots', async () => {
    const result = await discoverCandidates(['anthropic'], {
      activeRegistry: [],
      existingCandidates: [],
      fetchImpl,
      now: FIXED_NOW,
    });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].text).toBe(ANTHROPIC_HTML);
  });
});

describe('discover CANNOT reach the active registry (structural guard)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const discoverSource = readFileSync(join(here, 'discover.ts'), 'utf8');
  const cliSource = readFileSync(join(here, '..', 'cli.ts'), 'utf8');

  it('discover.ts never names the active registry file', () => {
    expect(discoverSource).not.toMatch(/llm-deprecations/);
  });

  it('discover.ts imports no filesystem API at all, so it cannot write anywhere', () => {
    // The strongest available form of "it cannot touch the registry": it cannot
    // touch ANY file. Everything it produces leaves as returned data.
    expect(discoverSource).not.toMatch(/from 'node:fs'/);
    expect(discoverSource).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/);
  });

  it('the discover CLI action holds no active-registry write path', () => {
    // The active-registry write lives behind `candidates promote` alone. Slice
    // the discover action out of cli.ts and assert it is inert toward it.
    const start = cliSource.indexOf(".command('discover')");
    const end = cliSource.indexOf(".command('scan')", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const action = cliSource.slice(start, end);
    expect(action).not.toMatch(/writeFileSync/);
    expect(action).not.toMatch(/resolveRegistryPath/);
    // It DOES write the candidate queue -- that is its whole job.
    expect(action).toMatch(/saveCandidates/);
  });
});
