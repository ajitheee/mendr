import { describe, expect, it } from 'vitest';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import type { ModelCatalog } from './catalog.js';
import { auditGraph, buildContractGraph, MAX_CHAIN, resolveSuccessor } from './graph.js';
import { canonicalizeId } from './normalize.js';

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
