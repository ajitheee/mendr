import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import type { ModelCatalog } from './catalog.js';
import {
  auditGraph,
  buildContractGraph,
  MAX_CHAIN,
  parseSdkSpec,
  resolveSdk,
  resolveSuccessor,
  type SdkSpec,
} from './graph.js';
import { canonicalizeId } from './normalize.js';
import type { SdkReleases } from './sdkReleases.js';

// PLANE 1, THE GRAPH — where the three flat artifacts finally meet.
//
// The registry knows what is dying and what it says to move to. The catalog knows what
// still exists. Neither alone can answer "this id is dying: does its replacement chain
// end somewhere real?" — and a migration PR that points at a successor nothing publishes
// is a confident, wrong edit.
//
// The live run found the case these tests are shaped around: two moderation ids whose
// successor is absent from every catalog — not because it is fake, but because the
// catalogs only carry chat models. "Could not check" must never read as either a pass
// or a problem.

function entry(deprecated: string, replacement: string, over: Partial<LlmModelIdDeprecation> = {}): LlmModelIdDeprecation {
  return { provider: 'openai', kind: 'model_id', deprecated, replacement, status: 'deprecated', ...over };
}

function catalog(...ids: string[]): ModelCatalog {
  return {
    schema: 'mendr-model-catalog/v1',
    fetchedAt: '2026-09-17T00:00:00Z',
    sources: [],
    providers: { openai: ids },
    count: ids.length,
  };
}

const LIVE = catalog('gpt-5.6-sol', 'gpt-4o-mini', 'o4-mini');

describe('resolving one id', () => {
  it('follows one hop to a successor the catalog lists', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], LIVE);
    const r = resolveSuccessor(g, 'gpt-4-0613');
    expect(r.outcome).toBe('live_successor');
    expect(r.path).toEqual(['gpt-4-0613', 'gpt-5.6-sol']);
    expect(r.terminal).toBe('gpt-5.6-sol');
  });

  // The case the registry's own chained check cannot see: it looks one hop ahead.
  it('walks a multi-hop chain to its end, not just to the first replacement', () => {
    const registry: LlmRegistry = [
      entry('gpt-4-0613', 'gpt-4o-mini'),
      entry('gpt-4o-mini', 'gpt-5.6-sol', { shutdownDate: '2026-10-23' }),
    ];
    const r = resolveSuccessor(buildContractGraph(registry, LIVE), 'gpt-4-0613');
    expect(r.outcome).toBe('live_successor');
    expect(r.path).toEqual(['gpt-4-0613', 'gpt-4o-mini', 'gpt-5.6-sol']);
  });

  it('reports a successor no public catalog lists, instead of calling it a success', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-9-imaginary')], LIVE);
    const r = resolveSuccessor(g, 'gpt-4-0613');
    expect(r.outcome).toBe('unlisted_successor');
    expect(r.reason).toContain('gpt-9-imaginary');
  });

  it('calls a chain a dead end when it stops on an id that is itself retiring', () => {
    const registry: LlmRegistry = [entry('gpt-4-0613', 'gpt-4o-mini'), entry('gpt-4o-mini', '')];
    const r = resolveSuccessor(buildContractGraph(registry, LIVE), 'gpt-4-0613');
    expect(r.outcome).toBe('dead_end');
    expect(r.terminal).toBe('gpt-4o-mini');
  });

  it('detects a cycle instead of walking it forever', () => {
    const registry: LlmRegistry = [entry('model-a', 'model-b'), entry('model-b', 'model-a')];
    const r = resolveSuccessor(buildContractGraph(registry, LIVE), 'model-a');
    expect(r.outcome).toBe('cycle');
    expect(r.terminal).toBeNull();
    expect(r.path).toEqual(['model-a', 'model-b', 'model-a']);
  });

  it(`gives up after ${MAX_CHAIN} hops and says so`, () => {
    const registry: LlmRegistry = Array.from({ length: MAX_CHAIN + 5 }, (_, i) => entry(`m-${i}`, `m-${i + 1}`));
    const r = resolveSuccessor(buildContractGraph(registry, LIVE), 'm-0');
    expect(r.outcome).toBe('dead_end');
    expect(r.path).toHaveLength(MAX_CHAIN);
    expect(r.reason).toContain(`after ${MAX_CHAIN} hops`);
  });

  it('says an id is unknown when the registry has never heard of it', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], LIVE);
    expect(resolveSuccessor(g, 'claude-nonexistent').outcome).toBe('unknown');
  });

  it('says there is nothing to resolve for an id that is only ever a destination', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], LIVE);
    expect(resolveSuccessor(g, 'gpt-5.6-sol').outcome).toBe('not_deprecated');
  });

  it('finds the same node whether the id is spelled with a dot or a dash', () => {
    const g = buildContractGraph([entry('gpt-3.5-turbo-0613', 'gpt-5.6-sol')], LIVE);
    expect(resolveSuccessor(g, 'gpt-3-5-turbo-0613').outcome).toBe('live_successor');
  });
});

describe('what the catalog can and cannot say', () => {
  // THE LIVE FINDING. omni-moderation-latest is real; the catalogs are chat catalogs.
  it('does NOT report a moderation successor as unlisted — it reports it as unchecked', () => {
    const g = buildContractGraph([entry('text-moderation-latest', 'omni-moderation-latest')], LIVE);
    const r = resolveSuccessor(g, 'text-moderation-latest');
    expect(r.outcome).toBe('uncovered_successor');
    expect(r.reason).toContain('moderation');
    expect(r.reason).toContain('not checked');
  });

  // The first version of the rule above excused the whole class and so threw away a real
  // pass: the catalogs DO list gpt-image-2. A listing is proof; only an absence is excused.
  it('still counts a listed image successor as live — coverage is partial, not zero', () => {
    const g = buildContractGraph([entry('dall-e-3', 'gpt-image-2')], catalog('gpt-image-2'));
    expect(resolveSuccessor(g, 'dall-e-3').outcome).toBe('live_successor');
  });

  it('with no catalog, never claims a destination is live', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], null);
    expect(g.catalogMissing).toBe(true);
    const r = resolveSuccessor(g, 'gpt-4-0613');
    expect(r.outcome).toBe('unlisted_successor');
    expect(r.reason).toContain('no catalog was supplied');
  });

  it('marks which nodes a catalog lists', () => {
    const g = buildContractGraph([entry('gpt-4o-mini', 'gpt-9-imaginary')], LIVE);
    expect(g.nodes.get('gpt-4o-mini')!.inCatalog).toBe(true);
    expect(g.nodes.get('gpt-9-imaginary')!.inCatalog).toBe(false);
  });
});

describe('building the graph', () => {
  // The nearest deadline is the one a reader has to act on first.
  it('keeps the SOONEST-shutting entry when one id appears twice', () => {
    const registry: LlmRegistry = [
      entry('gpt-4-0613', 'gpt-9-imaginary', { shutdownDate: '2027-01-01' }),
      entry('gpt-4-0613', 'gpt-5.6-sol', { shutdownDate: '2026-10-01' }),
    ];
    const node = buildContractGraph(registry, LIVE).nodes.get('gpt-4-0613')!;
    expect(node.shutdownDate).toBe('2026-10-01');
    expect(node.replacement).toBe('gpt-5.6-sol');
  });

  it('adds every replacement target as a node, even one the registry says nothing else about', () => {
    const g = buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], LIVE);
    // Keyed canonically: the dotted and dashed spellings are one node.
    const target = g.nodes.get(canonicalizeId('gpt-5.6-sol'))!;
    expect(target.id).toBe('gpt-5.6-sol');
    expect(target.deprecated).toBe(false);
    expect(target.replacement).toBeNull();
  });
});

describe('auditing every retiring id', () => {
  const registry: LlmRegistry = [
    entry('gpt-4-0613', 'gpt-5.6-sol'),
    entry('gpt-4-0314', 'gpt-9-imaginary'),
    entry('text-moderation-latest', 'omni-moderation-latest'),
    entry('model-a', 'model-b'),
    entry('model-b', 'model-a'),
  ];

  it('keeps passes, problems and could-not-check in three separate piles', () => {
    const audit = auditGraph(buildContractGraph(registry, LIVE));
    expect(audit.retiring).toBe(5);
    expect(audit.problems.map((p) => p.from)).toEqual(['model-a', 'model-b', 'gpt-4-0314']);
    expect(audit.unchecked.map((u) => u.from)).toEqual(['text-moderation-latest']);
    // gpt-4-0613 passed, so it is in neither pile.
    const named = [...audit.problems, ...audit.unchecked].map((r) => r.from);
    expect(named).not.toContain('gpt-4-0613');
  });

  it('comes back empty-handed only when every chain really ends somewhere live', () => {
    const audit = auditGraph(buildContractGraph([entry('gpt-4-0613', 'gpt-5.6-sol')], LIVE));
    expect(audit).toEqual({ retiring: 1, problems: [], unchecked: [] });
  });
});

// ---------------------------------------------------------------------------------------
// SLICE 4 — the SDK contract type.
//
// The dates below are the shipped record's own, and three of them are PRE-RELEASES:
// npm openai 4 (4.0.0-beta.0, GA 2023-08-16), npm openai 5 (5.0.0-alpha.0, GA 2025-05-29)
// and PyPI openai 1 (1.0.0b1, GA 2023-11-06). Checked against both registries. Any
// sentence that calls a first-seen date a release date is therefore false, and the tests
// hold every reason to "first seen, pre-releases included".

const FETCHED = '2026-09-18T03:44:22Z';
const FRESH_NOW = new Date('2026-09-19T00:00:00Z');
const STALE_NOW = new Date('2026-10-15T00:00:00Z'); // 26 days later: past the 14-day limit

function releases(over: Partial<SdkReleases> = {}): SdkReleases {
  const packages: SdkReleases['packages'] = [
    {
      ecosystem: 'npm',
      name: 'openai',
      provider: 'openai',
      latest: '7.18.0',
      latestMajor: 7,
      majorsFirstSeen: {
        '0': '2020-07-09T13:31:41.493Z',
        '3': '2022-06-07T20:28:50.838Z',
        '4': '2023-06-17T16:33:09.139Z',
        '5': '2024-12-20T21:13:59.486Z',
        '6': '2025-09-30T16:35:32.100Z',
        '7': '2026-07-27T21:56:56.615Z',
      },
      releaseCount: 388,
    },
    {
      ecosystem: 'pypi',
      name: 'openai',
      provider: 'openai',
      latest: '3.15.0',
      latestMajor: 3,
      majorsFirstSeen: {
        '0': '2020-02-18T19:41:36.681685Z',
        '1': '2023-09-29T20:33:07.738021Z',
        '2': '2025-09-30T17:35:54.695224Z',
        '3': '2026-08-12T01:55:48.678603Z',
      },
      releaseCount: 427,
    },
    {
      ecosystem: 'npm',
      name: '@anthropic-ai/sdk',
      provider: 'anthropic',
      latest: '0.126.0',
      latestMajor: 0,
      majorsFirstSeen: { '0': '2023-01-31T15:44:00.296Z' },
      releaseCount: 206,
    },
    {
      ecosystem: 'npm',
      name: '@google/genai',
      provider: 'google',
      latest: '2.23.0',
      latestMajor: 2,
      majorsFirstSeen: { '0': '2025-03-11T00:45:27.001Z', '1': '2025-05-19T22:26:30.471Z', '2': '2026-05-07T20:13:20.123Z' },
      releaseCount: 100,
    },
    {
      ecosystem: 'pypi',
      name: 'google-generativeai',
      provider: 'google',
      latest: '0.8.6',
      latestMajor: 0,
      majorsFirstSeen: { '0': '2023-05-03T23:00:52.602677Z' },
      releaseCount: 28,
    },
  ];
  return { schema: 'mendr-sdk-releases/v1', fetchedAt: FETCHED, sources: [], packages, count: packages.length, ...over };
}

const spec = (s: string): SdkSpec => {
  const parsed = parseSdkSpec(s);
  if (!parsed) throw new Error(`fixture spec did not parse: ${s}`);
  return parsed;
};

describe('reading an SDK spec', () => {
  it('reads a scoped npm name up to the LAST @', () => {
    expect(parseSdkSpec('npm:@anthropic-ai/sdk@0.20.0')).toMatchObject({ ecosystem: 'npm', name: '@anthropic-ai/sdk', major: 0 });
  });

  // What people copy out of package.json and requirements files. None of these can leave its major.
  it.each([
    ['npm:openai@^4.28.0', 4],
    ['npm:openai@~0.28', 0],
    ['npm:openai@v7.1.0', 7],
    ['npm:openai@=3', 3],
    ['npm:openai@4.x', 4],
    ['npm:openai@4.0.0-beta.0', 4],
    ['pypi:openai@1.0.0b1', 1],
    ['pypi:openai@0.28.1', 0],
  ])('reads %s as major %i', (s, major) => {
    expect(parseSdkSpec(s)?.major).toBe(major);
  });

  // Each of these can admit more than one major. Reading its first number would silently
  // answer for one version the person never pinned.
  it.each([
    'npm:openai@latest',
    'npm:openai@*',
    'npm:openai@^3.0.0 || ^4.0.0',
    'npm:openai@3.0.0 - 5.0.0',
    'npm:openai@>=1 <3',
    'npm:openai',
    'npm:@anthropic-ai/sdk',
    'pypi:openai==0.28.1',
    'gem:openai@1.0.0',
    // Comparators on their own, with no space to trip on.
    'npm:openai@>=4',
    'npm:openai@>4',
    'npm:openai@<5',
    'pypi:openai@>=1.0',
    'pypi:openai@~=1.0',
    // Space-free look-alikes that npm reads as DIST-TAGS, which can point at any major.
    'npm:openai@3.x-5.x',
    'npm:openai@3.0-5.0',
    'npm:openai@7.beta',
    'npm:openai@6.x-lts',
    'npm:openai@4.',
    'npm:openai@V7.1.0',
    // Leading zeros: npm's strict parser rejects them, so npm reads each one as a tag too.
    'npm:openai@04',
    'npm:openai@4.01',
    'npm:openai@4.2.3-01',
  ])('refuses %s', (s) => {
    expect(parseSdkSpec(s)).toBeNull();
  });
});

describe('resolving an SDK major', () => {
  it('walks to every newer major the record has seen, dated as first seen, pre-releases included', () => {
    const r = resolveSdk(releases(), spec('npm:openai@^4.28.0'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_newer_majors');
    expect(r.path).toEqual(['npm:openai@4', 'npm:openai@5', 'npm:openai@6', 'npm:openai@7']);
    expect(r.terminal).toBe('npm:openai@7.18.0');
    expect(r.reason).toContain('3 newer major lines seen: 5 (2024-12-20), 6 (2025-09-30), 7 (2026-07-27)');
    expect(r.reason).toContain('pre-releases included');
    expect(r.reason).toContain('not decided here');
  });

  // A stale record can prove a newer major exists — never that there is no other.
  it('still reports newer majors from a stale record, as a floor', () => {
    const r = resolveSdk(releases(), spec('pypi:openai@0.28.1'), STALE_NOW);
    expect(r.outcome).toBe('sdk_newer_majors');
    expect(r.reason).toContain('at least 3 newer major lines seen');
  });

  it('on the newest major, says what it did not compare — never a bare pass', () => {
    const r = resolveSdk(releases(), spec('npm:openai@7.1.0'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_latest_major');
    expect(r.reason).toContain('releases inside 7.x were not compared');
  });

  it('refuses to call a major the newest from a record past the age limit', () => {
    const r = resolveSdk(releases(), spec('npm:openai@7.1.0'), STALE_NOW);
    expect(r.outcome).toBe('sdk_unchecked');
    expect(r.reason).toContain('26.8 days old (max 14)');
    expect(r.reason).toContain('NOT checked');
  });

  it.each([
    ['an unreadable date', 'not-a-date'],
    ['a date days in the future', '2026-09-25T00:00:00Z'],
  ])('treats %s as unknown age, not as fresh', (_label, fetchedAt) => {
    const r = resolveSdk(releases({ fetchedAt }), spec('npm:openai@7.1.0'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_unchecked');
  });

  // The limits themselves: 14 days old, and up to one day of clock skew ahead.
  it.each([
    // Measured from FRESH_NOW, 2026-09-19T00:00:00Z.
    ['13.9 days old', 'sdk_latest_major', '2026-09-05T03:00:00Z'],
    ['14.1 days old', 'sdk_unchecked', '2026-09-04T21:00:00Z'],
    ['half a day ahead', 'sdk_latest_major', '2026-09-19T12:00:00Z'],
    ['a day and a half ahead', 'sdk_unchecked', '2026-09-20T12:00:00Z'],
  ])('a record %s gives %s', (_label, outcome, fetchedAt) => {
    expect(resolveSdk(releases({ fetchedAt }), spec('npm:openai@7.1.0'), FRESH_NOW).outcome).toBe(outcome);
  });

  // THE 0.x TRAP. @anthropic-ai/sdk is at 0.126.0: "no newer major" says nothing there.
  it('does NOT check a package that has never been seen above major 0', () => {
    const r = resolveSdk(releases(), spec('npm:@anthropic-ai/sdk@0.20.0'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_unchecked');
    expect(r.reason).toContain('NOT checked');
  });

  // Decided from the majors actually seen, not from `latestMajor`: a pre-release 1.x is
  // still a newer line, even while latest stays on 0.x.
  it('reports a pre-release-only major 1 on a 0.x package as a newer line', () => {
    const base = releases();
    const pkgs = base.packages.map((p) =>
      p.name === '@anthropic-ai/sdk' ? { ...p, majorsFirstSeen: { ...p.majorsFirstSeen, '1': '2026-09-01T00:00:00Z' } } : p,
    );
    const r = resolveSdk({ ...base, packages: pkgs }, spec('npm:@anthropic-ai/sdk@0.20.0'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_newer_majors');
    expect(r.reason).toContain('latest 0.126.0');
  });

  // Same package name, different ecosystems, different histories.
  it('keeps npm and PyPI apart', () => {
    expect(resolveSdk(releases(), spec('npm:openai@3.0.0'), FRESH_NOW).outcome).toBe('sdk_newer_majors');
    expect(resolveSdk(releases(), spec('pypi:openai@3.0.0'), FRESH_NOW).outcome).toBe('sdk_latest_major');
  });

  // canonicalizeId would collapse both of these to 'genai' / 'generative-ai'-style stubs.
  it('keeps scoped names as published', () => {
    expect(resolveSdk(releases(), spec('npm:@google/genai@2.0.0'), FRESH_NOW).path).toEqual(['npm:@google/genai@2']);
    expect(resolveSdk(releases(), spec('npm:@google/generative-ai@0.24.1'), FRESH_NOW).outcome).toBe('unknown');
    // canonicalizeId('@google/genai') is 'genai' and ('@anthropic-ai/sdk') is 'sdk'. Neither
    // bare name is a package in the record, and neither may borrow a scoped one's history.
    expect(resolveSdk(releases(), spec('npm:genai@1.0.0'), FRESH_NOW).outcome).toBe('unknown');
    expect(resolveSdk(releases(), spec('npm:sdk@0.1.0'), FRESH_NOW).outcome).toBe('unknown');
    // PEP 503 is PyPI's rule, not npm's.
    expect(resolveSdk(releases(), spec('npm:OpenAI@4.0.0'), FRESH_NOW).outcome).toBe('unknown');
  });

  it('finds a PyPI project however its name is spelled (PEP 503)', () => {
    const r = resolveSdk(releases(), spec('pypi:Google_GenerativeAI@0.8.3'), FRESH_NOW);
    expect(r.outcome).toBe('sdk_unchecked');
    expect(r.path).toEqual(['pypi:google-generativeai@0']);
  });

  it('says unknown for a package the record does not carry', () => {
    const r = resolveSdk(releases(), spec('npm:anthropic@1.0.0'), FRESH_NOW);
    expect(r.outcome).toBe('unknown');
    expect(r.reason).toContain('not one of the 5 SDK packages');
  });

  it('says unknown for a major the record has never seen', () => {
    const r = resolveSdk(releases(), spec('pypi:openai@4.0.0'), FRESH_NOW);
    expect(r.outcome).toBe('unknown');
    expect(r.reason).toContain('never seen a major 4');
  });

  it('with no record, or one of another schema, checks nothing', () => {
    expect(resolveSdk(null, spec('npm:openai@7.1.0'), FRESH_NOW).outcome).toBe('sdk_unchecked');
    expect(resolveSdk(releases({ schema: 'mendr-sdk-releases/v2' }), spec('npm:openai@7.1.0'), FRESH_NOW).outcome).toBe(
      'sdk_unchecked',
    );
  });

  // Never a bare "clean", and never a first-seen date passed off as a release date.
  it('never words any SDK result as clean, current or released-on', () => {
    const specs = [
      'npm:openai@4.28.0',
      'npm:openai@7.1.0',
      'pypi:openai@0.28.1',
      'pypi:openai@3.0.0',
      'npm:@anthropic-ai/sdk@0.20.0',
      'npm:@google/genai@2.0.0',
      'pypi:google-generativeai@0.8.3',
      'npm:anthropic@1.0.0',
    ];
    for (const now of [FRESH_NOW, STALE_NOW]) {
      for (const s of specs) {
        const { reason } = resolveSdk(releases(), spec(s), now);
        expect(reason, s).not.toMatch(/\b(clean|up.to.date|current|safe)\b/i);
        expect(reason, s).not.toMatch(/first released|released on|not been the current/i);
      }
    }
  });
});
