// PLANE 1's terminal node: "Contract and change graph".
//
// Slices 1 and 2 added two artifacts beside the deprecation registry — a catalog of what
// each provider currently publishes, and a record of what their SDKs have shipped. Three
// flat files that never speak to each other. The diagram has them converging into a graph,
// and the graph is what answers a question none of them can answer alone:
//
//     this id is dying — where does it actually lead, and is that destination real?
//
// The registry already refuses a replacement that is ITSELF deprecated (verify.ts, the
// chained check). That is one hop. A chain can be longer than one hop, and the end of it
// can be an id that nothing in the world publishes — which the registry cannot see, because
// the registry only knows about retirements. The catalog is what makes the end of a chain
// checkable.
//
// THE GRAPH IS DERIVED, NOT PUBLISHED. It is a view over two already-signed inputs, so it
// inherits their integrity; writing it to disk as a third artifact would only add a way for
// it to disagree with them.

import type { LlmRegistry } from '../types.js';
import type { ModelCatalog } from './catalog.js';
import { addLiveId } from './oracles.js';
import { canonicalizeId, inferModelClass, isCatalogVerifiableClass, isLiveId } from './normalize.js';

export interface GraphNode {
  /** The id as the registry spells it. */
  id: string;
  provider: string;
  deprecated: boolean;
  shutdownDate: string | null;
  /** The successor the registry proposes, or null when it proposes none. */
  replacement: string | null;
  /** Does a public catalog still list this id? */
  inCatalog: boolean;
}

export interface ContractGraph {
  /** canonical id -> node, for every id the registry mentions on either side of an edge. */
  nodes: Map<string, GraphNode>;
  /** Canonical + family forms of every catalog id, for membership tests. */
  liveIds: ReadonlySet<string>;
  /** True when no catalog was supplied — every `inCatalog` is then unknowable, not false. */
  catalogMissing: boolean;
}

export type ResolveOutcome =
  /** Not in the registry at all — nothing is known about it here. */
  | 'unknown'
  /** In the registry but not retiring: there is nothing to resolve. */
  | 'not_deprecated'
  /** Walked to an id that is neither deprecated nor missing from the catalog. */
  | 'live_successor'
  /** The chain ends somewhere no public catalog lists. Real, and worth saying out loud. */
  | 'unlisted_successor'
  /**
   * The chain ends on an id the catalogs do not list, of a class they list only partly
   * (moderation, image, audio). That absence says nothing, so this is NOT a problem
   * report — it is an honest "could not check".
   */
  | 'uncovered_successor'
  /** The chain ends on an id that is still deprecated and proposes nothing further. */
  | 'dead_end'
  /** The chain revisits an id it has already been through. */
  | 'cycle';

export interface Resolution {
  from: string;
  /** Every id walked, starting at `from`. */
  path: string[];
  terminal: string | null;
  outcome: ResolveOutcome;
  reason: string;
}

/** A chain longer than this is a data problem, not a migration. */
export const MAX_CHAIN = 12;

/**
 * Index the registry by canonical id, preferring the SOONEST-shutting entry when one id
 * carries several — the same rule investigation.ts uses, because the nearest deadline is
 * the one a reader needs to act on.
 */
function indexRegistry(registry: LlmRegistry): Map<string, GraphNode> {
  const byId = new Map<string, GraphNode>();
  for (const entry of registry) {
    if (entry.kind !== 'model_id') continue;
    const key = canonicalizeId(entry.deprecated);
    if (!key) continue;
    const shutdownDate = entry.shutdownDate ?? null;
    const held = byId.get(key);
    if (held) {
      const heldDate = held.shutdownDate;
      const sooner = shutdownDate && (!heldDate || shutdownDate < heldDate);
      if (!sooner) continue;
    }
    byId.set(key, {
      id: entry.deprecated,
      provider: entry.provider,
      deprecated: true,
      shutdownDate,
      replacement: entry.replacement || null,
      inCatalog: false,
    });
  }
  return byId;
}

/** Build the graph from the registry and, when available, the live catalog. */
export function buildContractGraph(registry: LlmRegistry, catalog?: ModelCatalog | null): ContractGraph {
  const nodes = indexRegistry(registry);

  const liveIds = new Set<string>();
  if (catalog) {
    for (const ids of Object.values(catalog.providers)) {
      for (const id of ids) addLiveId(liveIds, id);
    }
  }

  // Every id a replacement points AT is a node too, even when the registry says nothing
  // else about it — that is precisely the node whose reality the catalog can confirm.
  for (const node of [...nodes.values()]) {
    node.inCatalog = catalog ? isLiveId(node.id, liveIds) : false;
    const next = node.replacement;
    if (!next) continue;
    const key = canonicalizeId(next);
    if (!key || nodes.has(key)) continue;
    nodes.set(key, {
      id: next,
      provider: node.provider,
      deprecated: false,
      shutdownDate: null,
      replacement: null,
      inCatalog: catalog ? isLiveId(next, liveIds) : false,
    });
  }

  return { nodes, liveIds, catalogMissing: !catalog };
}

/**
 * Walk the replacement chain from `id` and say where it lands.
 *
 * Stops on the first id that is not deprecated. Whether that landing is GOOD is then a
 * separate question, and the catalog answers it: an id no public catalog lists is reported
 * as `unlisted_successor` rather than quietly called a success. Without a catalog the
 * distinction cannot be drawn at all, and the reason says so instead of guessing.
 */
export function resolveSuccessor(graph: ContractGraph, id: string): Resolution {
  const start = canonicalizeId(id);
  const first = graph.nodes.get(start);
  if (!first) {
    return { from: id, path: [id], terminal: null, outcome: 'unknown', reason: 'not present in the registry' };
  }
  if (!first.deprecated) {
    return {
      from: id,
      path: [first.id],
      terminal: first.id,
      outcome: 'not_deprecated',
      reason: 'the registry does not record this id as retiring',
    };
  }

  const path: string[] = [first.id];
  const seen = new Set<string>([start]);
  let node = first;

  while (node.deprecated && node.replacement && path.length < MAX_CHAIN) {
    const nextKey = canonicalizeId(node.replacement);
    if (seen.has(nextKey)) {
      path.push(node.replacement);
      return {
        from: id,
        path,
        terminal: null,
        outcome: 'cycle',
        reason: `the chain returns to "${node.replacement}", which it has already been through`,
      };
    }
    seen.add(nextKey);
    const next = graph.nodes.get(nextKey);
    path.push(next ? next.id : node.replacement);
    if (!next) break;
    node = next;
  }

  const terminal = path[path.length - 1]!;
  const terminalNode = graph.nodes.get(canonicalizeId(terminal));

  if (terminalNode?.deprecated) {
    return {
      from: id,
      path,
      terminal,
      outcome: 'dead_end',
      reason:
        path.length >= MAX_CHAIN
          ? `the chain is still deprecated after ${MAX_CHAIN} hops`
          : `"${terminal}" is itself retiring and the registry proposes nothing after it`,
    };
  }

  if (graph.catalogMissing) {
    return {
      from: id,
      path,
      terminal,
      outcome: 'unlisted_successor',
      reason: 'no catalog was supplied, so whether the destination is live could not be checked',
    };
  }

  if (isLiveId(terminal, graph.liveIds)) {
    return {
      from: id,
      path,
      terminal,
      outcome: 'live_successor',
      reason: `"${terminal}" is not retiring and a public catalog lists it`,
    };
  }

  // Past here the destination is ABSENT from the catalogs. For a chat model that absence is
  // evidence. For a moderation, image or audio model it is not: the catalogs carry those
  // classes only partly (gpt-image-2 is listed, omni-moderation-latest is not), so a listing
  // proves a destination is live but a missing one proves nothing.
  const terminalClass = inferModelClass(terminal);
  if (!isCatalogVerifiableClass(terminalClass)) {
    return {
      from: id,
      path,
      terminal,
      outcome: 'uncovered_successor',
      reason: `"${terminal}" is a ${terminalClass} model; the public catalogs do not reliably list that class, so its absence was not checked`,
    };
  }

  return {
    from: id,
    path,
    terminal,
    outcome: 'unlisted_successor',
    reason: `no public catalog lists "${terminal}"`,
  };
}

export interface GraphAudit {
  /** How many retiring ids were walked. */
  retiring: number;
  /** Chains that do NOT end somewhere live. The integrity report. */
  problems: Resolution[];
  /**
   * Chains that end on a class no catalog carries. Kept apart from `problems` and from
   * the passes, so "could not check" is never counted as either.
   */
  unchecked: Resolution[];
}

const byOutcomeThenId = (a: Resolution, b: Resolution) =>
  a.outcome.localeCompare(b.outcome) || a.from.localeCompare(b.from);

/** Walk every retiring id and sort the results into passed, problems and unchecked. */
export function auditGraph(graph: ContractGraph): GraphAudit {
  const problems: Resolution[] = [];
  const unchecked: Resolution[] = [];
  let retiring = 0;
  for (const node of graph.nodes.values()) {
    if (!node.deprecated) continue;
    retiring++;
    const r = resolveSuccessor(graph, node.id);
    if (r.outcome === 'live_successor') continue;
    (r.outcome === 'uncovered_successor' ? unchecked : problems).push(r);
  }
  return { retiring, problems: problems.sort(byOutcomeThenId), unchecked: unchecked.sort(byOutcomeThenId) };
}
