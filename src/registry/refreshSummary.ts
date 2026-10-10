// What a weekly registry-refresh run actually moved, in the words its PR is titled with.
//
// This lived inline in .github/workflows/registry-refresh.yml until 2026-10-09, where
// nothing could test it, and two defects went out in PR #40 unseen:
//
//   1. SDK versions were keyed by package NAME alone. `openai` is a package on npm AND on
//      PyPI, so the PyPI record overwrote the npm one: PR #40 said "5 SDK bumps" and
//      made six, and npm openai 7.23.0 -> 7.28.0 was in the diff but not in the body.
//      Keys are now ecosystem + name.
//   2. Model ids were counted from one flat list, so a spelling only OpenRouter lists
//      (`claude-sonnet-5.5`, `gpt-6.1-sol-pro`) was announced as a "new model id" in the
//      same breath as a provider's own. The catalog now keeps those apart
//      (catalog.ts, `openrouterOnly`), and so does this report: they are listed, never
//      counted as model ids, and never open a PR on their own.
//
// The workflow runs scripts/refresh-summary.mjs, which only reads the files and writes
// the step outputs; every decision is here.

/** The parts of a catalog file this reads. Parsed JSON, so nothing is trusted to be there. */
export interface CatalogLike {
  providers?: Record<string, unknown>;
  openrouterOnly?: Record<string, unknown>;
  sources?: { url?: string; ok?: boolean; note?: string }[];
}

/** The parts of an SDK release record this reads. */
export interface SdkLike {
  packages?: { ecosystem?: string; name?: string; latest?: string }[];
  sources?: { url?: string; ok?: boolean; note?: string }[];
}

export interface RefreshSide {
  catalog: CatalogLike;
  sdk: SdkLike;
}

export interface SdkBump {
  ecosystem: string;
  name: string;
  from: string;
  to: string;
}

export interface RefreshSummary {
  /** Direct-provider model ids, as `provider/id`. */
  added: string[];
  removed: string[];
  /** Spellings only OpenRouter lists, as `provider/id`. Reported; never counted as model ids. */
  routedAdded: string[];
  routedRemoved: string[];
  /** False when the comparison cannot be made (OpenRouter unread, or an older file without the list). */
  routedCompared: boolean;
  /** SDK packages whose latest version moved, keyed by ecosystem AND name. */
  bumped: SdkBump[];
  /** Every source, catalog or SDK, that this run could not read. */
  failedSources: string[];
  /** Did something a reviewer must look at move? Timestamps and OpenRouter-only spellings alone do not. */
  substantive: boolean;
  /** For the PR title and commit message: "+2 model ids, 6 SDK bumps", or "timestamps only". */
  summary: string;
  /** The PR body, markdown, ending in a newline. */
  body: string;
}

/** OpenRouter's catalog source url, matched loosely so a query string cannot hide it. */
const OPENROUTER_SOURCE = /openrouter\.ai\//;

/** `provider/id` for every id in one provider map, tolerating an array or an object of ids. */
function flatten(map: Record<string, unknown> | undefined): Set<string> {
  const out = new Set<string>();
  for (const [provider, list] of Object.entries(map ?? {})) {
    const ids = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.keys(list) : [];
    for (const m of ids) {
      const id = typeof m === 'string' ? m : (m as { id?: unknown })?.id;
      if (typeof id === 'string' && id) out.add(`${provider}/${id}`);
    }
  }
  return out;
}

const minus = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort();

/** ecosystem:name -> latest. The ecosystem is part of the key: `openai` exists on npm and PyPI. */
function latestByPackage(sdk: SdkLike): Map<string, SdkBump> {
  const out = new Map<string, SdkBump>();
  for (const p of sdk.packages ?? []) {
    if (!p?.name || !p.latest) continue;
    const ecosystem = p.ecosystem ?? 'unknown';
    out.set(`${ecosystem}:${p.name}`, { ecosystem, name: p.name, from: '', to: p.latest });
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** At most 40 bullet lines, then a count of the rest. */
function bullets(items: string[]): string {
  const shown = items.slice(0, 40).map((x) => `- \`${x}\``);
  if (items.length > 40) shown.push(`- … and ${items.length - 40} more`);
  return shown.join('\n');
}

/** Compare the files at HEAD (`was`) with the ones this run wrote (`now`). */
export function summarizeRefresh(was: RefreshSide, now: RefreshSide): RefreshSummary {
  const directWas = flatten(was.catalog.providers);
  const directNow = flatten(now.catalog.providers);
  const added = minus(directNow, directWas);
  const removed = minus(directWas, directNow);

  // OpenRouter-only spellings are compared only when both files record them and this run
  // actually read OpenRouter. An unread source would otherwise look like every spelling
  // being withdrawn at once.
  const openrouterRead = !(now.catalog.sources ?? []).some(
    (s) => OPENROUTER_SOURCE.test(s?.url ?? '') && s?.ok === false,
  );
  const routedCompared =
    was.catalog.openrouterOnly !== undefined && now.catalog.openrouterOnly !== undefined && openrouterRead;
  const routedWas = flatten(was.catalog.openrouterOnly);
  const routedNow = flatten(now.catalog.openrouterOnly);
  const routedAdded = routedCompared ? minus(routedNow, routedWas) : [];
  const routedRemoved = routedCompared ? minus(routedWas, routedNow) : [];

  const latestWas = latestByPackage(was.sdk);
  const bumped: SdkBump[] = [];
  for (const [key, pkg] of latestByPackage(now.sdk)) {
    const before = latestWas.get(key);
    if (before && before.to !== pkg.to) bumped.push({ ...pkg, from: before.to });
  }

  const failedSources = [...(now.catalog.sources ?? []), ...(now.sdk.sources ?? [])]
    .filter((s) => s?.ok === false)
    .map((s) => `${s.url ?? 'unknown source'}${s.note ? ` (${s.note})` : ''}`);

  const parts: string[] = [];
  if (added.length) parts.push(`+${plural(added.length, 'model id', 'model ids')}`);
  if (removed.length) parts.push(`-${plural(removed.length, 'model id', 'model ids')}`);
  if (bumped.length) parts.push(plural(bumped.length, 'SDK bump', 'SDK bumps'));
  const substantive = parts.length > 0;
  const routedMoved = routedAdded.length + routedRemoved.length > 0;
  const summary = substantive ? parts.join(', ') : routedMoved ? 'OpenRouter-only spellings only' : 'timestamps only';

  const sections: string[] = [];
  if (failedSources.length) {
    sections.push(
      `**Sources this run could not read (${failedSources.length})** — what they list is missing from this ` +
        `refresh, not withdrawn.\n\n${failedSources.map((s) => `- ${s}`).join('\n')}`,
    );
  }
  if (added.length) {
    sections.push(
      `**New model ids (${added.length})** — listed by the direct-provider source (models.dev), the only ` +
        `source whose ids can say a replacement is live.\n\n${bullets(added)}`,
    );
  }
  if (removed.length) {
    sections.push(
      `**No longer listed (${removed.length})** — the direct-provider source stopped listing these. That is NOT ` +
        `a retirement announcement; only the deprecation registry can say that.\n\n${bullets(removed)}`,
    );
  }
  if (bumped.length) {
    sections.push(
      `**SDK latest versions moved (${bumped.length})**\n\n` +
        bumped.map((b) => `- ${b.ecosystem} \`${b.name}\` ${b.from} → ${b.to}`).join('\n'),
    );
  }
  if (routedMoved) {
    const lines = [
      '**OpenRouter-only spellings** — kept apart from the model ids above, in `openrouterOnly`. A call ' +
        'routed through OpenRouter sends these; a direct call to the provider does not, and nothing reads ' +
        'them to decide that a replacement is live. Listed for the record; on their own they open no PR.',
    ];
    if (routedAdded.length) lines.push(`Newly listed (${routedAdded.length}):\n\n${bullets(routedAdded)}`);
    if (routedRemoved.length) lines.push(`No longer listed (${routedRemoved.length}):\n\n${bullets(routedRemoved)}`);
    sections.push(lines.join('\n\n'));
  }

  const body = sections.length
    ? `${sections.join('\n\n')}\n`
    : '_Only `fetchedAt` changed; no ids and no SDK versions moved._\n';

  return { added, removed, routedAdded, routedRemoved, routedCompared, bumped, failedSources, substantive, summary, body };
}
