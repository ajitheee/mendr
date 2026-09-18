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
import { DEFAULT_MAX_AGE_DAYS } from './freshRegistry.js';
import { SDK_RELEASES_SCHEMA, type SdkReleases } from './sdkReleases.js';
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
  /** SDK: the record has seen at least one major line after the one named. */
  | 'sdk_newer_majors'
  /** SDK: the named major is the newest line the (fresh) record has seen. Minors not compared. */
  | 'sdk_latest_major'
  /** SDK: the record cannot answer — a 0.x package, a stale record, or no record at all. */
  | 'sdk_unchecked'
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

// ---------------------------------------------------------------------------------------
// SLICE 4 — THE SDK CONTRACT TYPE.
//
// A model id is one contract a provider changes underneath you; the SDK it is called
// through is another. Slice 2 recorded what each first-party SDK has shipped. This walks a
// named SDK major forward through that record, the way resolveSuccessor walks a model id.
//
// Three things it will not say, because the record cannot support them:
//   * that a newer major BREAKS anything — "major means breaking" is a convention;
//   * anything about a package that never left 0.x — there a minor may break, and the
//     record tracks majors only;
//   * that a major is the newest one, from a record too old to know.
// And every date it prints is when a major was FIRST SEEN, pre-releases included: npm
// openai 4 is dated 2023-06-17 (4.0.0-beta.0), two months before 4.0.0 shipped.
//
// SDK names never pass through canonicalizeId, which turns '@google/genai' into 'genai'
// and '@anthropic-ai/sdk' into 'sdk'. They are compared as published.

export interface SdkSpec {
  ecosystem: 'npm' | 'pypi';
  name: string;
  major: number;
  /** Exactly what the person typed. */
  spec: string;
}

/**
 * npm: a version, or a range that cannot leave its major — an optional ^ ~ or =, an optional
 * v, then either up to three components (digits or an x/* wildcard) or a full x.y.z with its
 * pre-release and build. Everything else is a dist-tag or a multi-major range to npm itself:
 * `latest`, `>=4`, `^3 || ^4`, `3.0.0 - 5.0.0`, and the space-free look-alikes `3.x-5.x`,
 * `7.beta`, `4.` and `V7.1.0` that npm-package-arg reads as TAGS, which can point anywhere.
 */
const NUM = '(?:0|[1-9]\\d*)'; // semver: no leading zeros, or npm reads it as a tag
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const NPM_VERSION = new RegExp(
  `^[\\^~=]?v?(${NUM})(?:(?:\\.(?:${NUM}|[xX*])){0,2}|\\.${NUM}\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)$`,
);

/** PyPI: one canonical PEP 440 release — 0.28.1, 1.0.0b1, 1.0.0rc2, 2.0.0.post1, 2.0.dev3. */
const PYPI_VERSION = /^v?(\d+)(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

/**
 * Read `npm:<name>@<version>` or `pypi:<name>@<version>`, where the version can name only
 * one major. Anything that could admit more than one is refused, never read as its first
 * number: that would answer for a version the person never pinned.
 */
export function parseSdkSpec(spec: string): SdkSpec | null {
  const m = /^(npm|pypi):(\S+)@([^@\s]+)$/i.exec(spec.trim());
  if (!m) return null;
  const ecosystem = m[1]!.toLowerCase() as 'npm' | 'pypi';
  const version = (ecosystem === 'npm' ? NPM_VERSION : PYPI_VERSION).exec(m[3]!);
  if (!version) return null;
  return { ecosystem, name: m[2]!, major: Number(version[1]), spec };
}

const DAY_MS = 86_400_000;

/** PyPI treats `Google_GenerativeAI` and `google-generativeai` as one project (PEP 503). */
const pypiName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/** Walk a named SDK major forward through the release record and say where it stands. */
export function resolveSdk(releases: SdkReleases | null, spec: SdkSpec, now: Date = new Date()): Resolution {
  const from = spec.spec;
  const named = `${spec.ecosystem}:${spec.name}@${spec.major}`;
  if (!releases || releases.schema !== SDK_RELEASES_SCHEMA) {
    return {
      from,
      path: [named],
      terminal: null,
      outcome: 'sdk_unchecked',
      reason: 'no SDK release record was supplied (or it has another schema), so NOT checked',
    };
  }
  const fetched = `record fetched ${releases.fetchedAt}`;

  const pkg = releases.packages.find(
    (p) =>
      p.ecosystem === spec.ecosystem &&
      (spec.ecosystem === 'pypi' ? pypiName(p.name) === pypiName(spec.name) : p.name === spec.name),
  );
  if (!pkg) {
    return {
      from,
      path: [named],
      terminal: null,
      outcome: 'unknown',
      reason: `${spec.ecosystem} package "${spec.name}" is not one of the ${releases.packages.length} SDK packages in the release record`,
    };
  }

  const id = `${pkg.ecosystem}:${pkg.name}`;
  const majors = Object.keys(pkg.majorsFirstSeen)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (!majors.includes(spec.major)) {
    return {
      from,
      path: [`${id}@${spec.major}`],
      terminal: null,
      outcome: 'unknown',
      reason: `the record has never seen a major ${spec.major} for ${id} (majors seen: ${majors.join(', ')}; latest ${pkg.latest}; ${fetched})`,
    };
  }

  const newer = majors.filter((m) => m > spec.major);
  const path = [spec.major, ...newer].map((m) => `${id}@${m}`);
  const ageDays = (now.getTime() - Date.parse(releases.fetchedAt)) / DAY_MS;
  // An unreadable date, or one more than a day in the future, is not a date to trust.
  const fresh = Number.isFinite(ageDays) && ageDays >= -1 && ageDays <= DEFAULT_MAX_AGE_DAYS;

  // A stale record can still prove a newer major exists. It can never prove there is none.
  if (newer.length > 0) {
    const dated = newer.map((m) => `${m} (${(pkg.majorsFirstSeen[String(m)] ?? '').slice(0, 10)})`).join(', ');
    const count = `${fresh ? '' : 'at least '}${newer.length} newer major line${newer.length === 1 ? '' : 's'} seen`;
    return {
      from,
      path,
      terminal: `${id}@${pkg.latest}`,
      outcome: 'sdk_newer_majors',
      reason:
        `${count}: ${dated} — each date is when that major was first seen, pre-releases included; ` +
        `latest ${pkg.latest}; whether any of them breaks your code is not decided here (${fetched})`,
    };
  }

  if (spec.major === 0) {
    return {
      from,
      path,
      terminal: null,
      outcome: 'sdk_unchecked',
      reason: `${id} has never been seen above major 0; on 0.x a minor may break and the record tracks majors only, so NOT checked (latest ${pkg.latest}; ${fetched})`,
    };
  }

  if (!fresh) {
    const age =
      Number.isFinite(ageDays) && ageDays >= -1
        ? `${ageDays.toFixed(1)} days old (max ${DEFAULT_MAX_AGE_DAYS})`
        : `dated "${releases.fetchedAt}", which cannot be trusted`;
    return {
      from,
      path,
      terminal: null,
      outcome: 'sdk_unchecked',
      reason: `the release record is ${age}; a newer major may have shipped since, so whether ${spec.major} is the newest was NOT checked`,
    };
  }

  return {
    from,
    path,
    terminal: `${id}@${pkg.latest}`,
    outcome: 'sdk_latest_major',
    reason: `${spec.major} is the newest major line seen (latest ${pkg.latest}); releases inside ${spec.major}.x were not compared (${fetched})`,
  };
}
