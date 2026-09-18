// PLANE 1, box two: "OpenAPI, GraphQL, protobuf and SDK releases".
//
// SLICE 2 takes the narrowest real cut of that box: the provider SDKs themselves.
// A model id is not the only thing a provider changes underneath you. `openai` on npm
// is at 7.x and on PyPI at 3.x; a repository pinned to `openai@^0.28` is six majors
// behind an API surface that was rewritten. That breaks code exactly the way a retired
// model id does, and nothing in a lockfile tells you a major was your provider's.
//
// WHAT THIS SLICE DOES: record what each first-party SDK has published, and when each
// major first appeared. Facts, with evidence.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * It does not decide what is BREAKING. "Major means breaking" is a convention, not
//     a fact, and two of these packages are still 0.x where the convention says minor
//     bumps break instead. Classifying that needs a human reading changelogs, which is
//     the curation gate the deprecation registry already has. Collect now, classify later.
//   * It does not look at your repository. Comparing a pinned version against this is
//     plane 2, and it needs this artifact to exist first.
//   * It does not judge one SDK as superseding another. Google publishes BOTH
//     `@google/genai` and `@google/generative-ai` right now; recording both is the fact,
//     deciding which is legacy is curation.
//
// Duplicates the fetch-and-hash shape from catalog.ts. That is the second time; a third
// caller would earn a shared helper, and this one does not.

import { createHash } from 'node:crypto';

/** Bumped only on a breaking shape change. */
export const SDK_RELEASES_SCHEMA = 'mendr-sdk-releases/v1';

/**
 * The first-party SDKs. Every name here was confirmed to resolve on 2026-09-18 rather
 * than guessed — `@google/generative-ai` and `google-generativeai` are the older Google
 * clients and are still published, which is why both generations are listed.
 */
export const SDK_PACKAGES: ReadonlyArray<{ ecosystem: 'npm' | 'pypi'; name: string; provider: string }> = [
  { ecosystem: 'npm', name: 'openai', provider: 'openai' },
  { ecosystem: 'npm', name: '@anthropic-ai/sdk', provider: 'anthropic' },
  { ecosystem: 'npm', name: '@google/genai', provider: 'google' },
  { ecosystem: 'npm', name: '@google/generative-ai', provider: 'google' },
  { ecosystem: 'pypi', name: 'openai', provider: 'openai' },
  { ecosystem: 'pypi', name: 'anthropic', provider: 'anthropic' },
  { ecosystem: 'pypi', name: 'google-genai', provider: 'google' },
  { ecosystem: 'pypi', name: 'google-generativeai', provider: 'google' },
];

export interface SdkSource {
  url: string;
  ok: boolean;
  /** sha256 of the exact response body, or null when the fetch failed. */
  sha256: string | null;
  note: string;
}

export interface SdkPackage {
  ecosystem: 'npm' | 'pypi';
  name: string;
  provider: string;
  /** The version the registry currently serves as latest. */
  latest: string;
  /** Leading numeric segment of `latest`. Zero is meaningful, not missing. */
  latestMajor: number;
  /** major -> ISO date that major first appeared. Sorted numerically when serialized. */
  majorsFirstSeen: Record<string, string>;
  /** Total published versions, a rough measure of how fast the surface moves. */
  releaseCount: number;
}

export interface SdkReleases {
  schema: string;
  fetchedAt: string;
  sources: SdkSource[];
  packages: SdkPackage[];
  count: number;
}

export interface BuildSdkOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
}

export const npmUrl = (name: string): string =>
  `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
export const pypiUrl = (name: string): string => `https://pypi.org/pypi/${name}/json`;

/** Leading numeric segment, or null when the string is not a version we can read. */
export function majorOf(version: string): number | null {
  const m = /^(\d+)\./.exec(String(version).trim());
  return m ? Number(m[1]) : null;
}

/** Earliest ISO date per major, from a version -> date map. */
function foldMajors(versionDates: Array<[string, string]>): Record<string, string> {
  const first = new Map<number, string>();
  for (const [version, iso] of versionDates) {
    const major = majorOf(version);
    if (major === null || !iso) continue;
    const held = first.get(major);
    if (!held || iso < held) first.set(major, iso);
  }
  return Object.fromEntries([...first.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
}

async function readSource(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; sha256: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Collect what every first-party SDK has published.
 *
 * A package failing is tolerated and named. EVERY package failing THROWS, for the same
 * reason the catalog does: an empty release record is indistinguishable from "these
 * SDKs have never shipped", and that file would be read as fact by everything downstream.
 */
export async function buildSdkReleases(opts: BuildSdkOptions = {}): Promise<SdkReleases> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fetchedAt = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sources: SdkSource[] = [];
  const packages: SdkPackage[] = [];

  for (const pkg of SDK_PACKAGES) {
    const url = pkg.ecosystem === 'npm' ? npmUrl(pkg.name) : pypiUrl(pkg.name);
    const got = await readSource(url, fetchImpl);
    if ('error' in got) {
      sources.push({ url, ok: false, sha256: null, note: `${pkg.name} failed: ${got.error}` });
      continue;
    }
    try {
      let latest: string | undefined;
      let versionDates: Array<[string, string]> = [];
      let releaseCount = 0;

      if (pkg.ecosystem === 'npm') {
        const j = JSON.parse(got.text) as {
          'dist-tags'?: { latest?: string };
          time?: Record<string, string>;
          versions?: Record<string, unknown>;
        };
        latest = j['dist-tags']?.latest;
        const time = j.time ?? {};
        versionDates = Object.entries(time).filter(([v]) => v !== 'created' && v !== 'modified');
        releaseCount = Object.keys(j.versions ?? {}).length;
      } else {
        const j = JSON.parse(got.text) as {
          info?: { version?: string };
          releases?: Record<string, Array<{ upload_time_iso_8601?: string }>>;
        };
        latest = j.info?.version;
        const releases = j.releases ?? {};
        versionDates = Object.entries(releases)
          .map(([v, files]) => [v, files?.[0]?.upload_time_iso_8601 ?? ''] as [string, string])
          .filter(([, iso]) => iso !== '');
        releaseCount = Object.keys(releases).length;
      }

      const major = latest ? majorOf(latest) : null;
      if (!latest || major === null) {
        sources.push({ url, ok: false, sha256: got.sha256, note: `${pkg.name}: no readable latest version` });
        continue;
      }

      packages.push({
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        provider: pkg.provider,
        latest,
        latestMajor: major,
        majorsFirstSeen: foldMajors(versionDates),
        releaseCount,
      });
      sources.push({ url, ok: true, sha256: got.sha256, note: `${pkg.name} ${latest} (${releaseCount} releases)` });
    } catch (err) {
      sources.push({ url, ok: false, sha256: got.sha256, note: `${pkg.name} unparseable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (packages.length === 0) {
    throw new Error(
      `mendr: no SDK release source could be read (${sources.map((s) => s.note).join('; ')}). ` +
        'Refusing to write an empty release record: it would read as "these SDKs have never shipped".',
    );
  }

  packages.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  return { schema: SDK_RELEASES_SCHEMA, fetchedAt, sources, packages, count: packages.length };
}

/** The exact bytes written to disk: 2-space JSON with a trailing newline. */
export function serializeSdkReleases(r: SdkReleases): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
