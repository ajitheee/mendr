import { describe, expect, it } from 'vitest';
import {
  buildSdkReleases,
  majorOf,
  npmUrl,
  pypiUrl,
  SDK_PACKAGES,
  SDK_RELEASES_SCHEMA,
  serializeSdkReleases,
} from './sdkReleases.js';

// PLANE 1, BOX TWO — the first contract type that is not a model id.
//
// `openai` has shipped eight majors on npm and four on PyPI. A repository pinned to
// `openai@^0.28` is behind an API surface that was rewritten, and nothing in a lockfile
// says that major belonged to a provider rather than to any other dependency.
//
// This slice records what shipped and when each major first appeared. It does NOT decide
// what is breaking: "major means breaking" is a convention, and two of these packages are
// still 0.x, where the convention says minor bumps break instead.

const npmBody = (latest: string, time: Record<string, string>) =>
  JSON.stringify({ 'dist-tags': { latest }, time: { created: '2020-01-01T00:00:00Z', ...time }, versions: Object.fromEntries(Object.keys(time).map((v) => [v, {}])) });

const pypiBody = (version: string, releases: Record<string, string>) =>
  JSON.stringify({
    info: { version },
    releases: Object.fromEntries(Object.entries(releases).map(([v, iso]) => [v, [{ upload_time_iso_8601: iso }]])),
  });

/** url -> body, {status}, or Error. Anything unlisted answers 404. */
const stub = (routes: Record<string, string | { status: number } | Error>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) return { ok: false, status: 404, text: async () => '' } as Response;
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'object') return { ok: false, status: hit.status, text: async () => '' } as Response;
    return { ok: true, status: 200, text: async () => hit } as Response;
  }) as unknown as typeof fetch;

const NOW = new Date('2026-09-18T00:00:00.000Z');
const OPENAI_NPM = npmUrl('openai');
const OPENAI_PYPI = pypiUrl('openai');

describe('majorOf', () => {
  it('reads the leading segment', () => {
    expect(majorOf('7.18.0')).toBe(7);
    expect(majorOf('1.6.0')).toBe(1);
  });

  // Zero is a real major, not a missing one. Two of these SDKs have never left it.
  it('treats 0.x as major zero, not as absent', () => {
    expect(majorOf('0.126.0')).toBe(0);
  });

  it('declines anything it cannot read', () => {
    expect(majorOf('latest')).toBeNull();
    expect(majorOf('')).toBeNull();
  });
});

describe('collecting releases', () => {
  it('reads an npm package: latest, majors and release count', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_NPM]: npmBody('7.18.0', {
          '0.1.0': '2020-06-01T00:00:00Z',
          '1.0.0': '2023-08-16T00:00:00Z',
          '7.18.0': '2026-09-01T00:00:00Z',
        }),
      }),
    });
    const pkg = r.packages.find((p) => p.ecosystem === 'npm' && p.name === 'openai')!;
    expect(pkg.latest).toBe('7.18.0');
    expect(pkg.latestMajor).toBe(7);
    expect(pkg.releaseCount).toBe(3);
    expect(pkg.provider).toBe('openai');
  });

  it('reads a PyPI package from its own shape', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_PYPI]: pypiBody('3.15.0', { '0.27.0': '2023-03-01T00:00:00Z', '3.15.0': '2026-09-01T00:00:00Z' }),
      }),
    });
    const pkg = r.packages.find((p) => p.ecosystem === 'pypi')!;
    expect(pkg.latest).toBe('3.15.0');
    expect(pkg.latestMajor).toBe(3);
  });

  // The date that matters is when a major ARRIVED, not the last patch on it.
  it('records the earliest date each major appeared', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_NPM]: npmBody('1.9.0', {
          '1.5.0': '2023-11-01T00:00:00Z',
          '1.0.0': '2023-08-16T00:00:00Z',
          '1.9.0': '2024-02-01T00:00:00Z',
        }),
      }),
    });
    expect(r.packages[0]!.majorsFirstSeen['1']).toBe('2023-08-16T00:00:00Z');
  });

  it('orders majors numerically, not as strings', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_NPM]: npmBody('10.0.0', {
          '2.0.0': '2022-01-01T00:00:00Z',
          '10.0.0': '2026-01-01T00:00:00Z',
          '0.1.0': '2021-01-01T00:00:00Z',
        }),
      }),
    });
    expect(Object.keys(r.packages[0]!.majorsFirstSeen)).toEqual(['0', '2', '10']);
  });

  it('covers both generations of the Google SDK, because both are still published', () => {
    const names = SDK_PACKAGES.filter((p) => p.provider === 'google').map((p) => p.name);
    expect(names).toContain('@google/genai');
    expect(names).toContain('@google/generative-ai');
  });
});

describe('evidence and failure', () => {
  it('hashes the raw bytes of each package it read', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({ [OPENAI_NPM]: npmBody('7.0.0', { '7.0.0': '2026-01-01T00:00:00Z' }) }),
    });
    const ok = r.sources.find((s) => s.ok)!;
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names a package that failed and keeps the ones that did not', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_NPM]: { status: 503 },
        [OPENAI_PYPI]: pypiBody('3.15.0', { '3.15.0': '2026-09-01T00:00:00Z' }),
      }),
    });
    expect(r.count).toBe(1);
    expect(r.sources.some((s) => !s.ok && s.note.includes('503'))).toBe(true);
  });

  it('flags a package whose latest version cannot be read, rather than inventing one', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({
        [OPENAI_NPM]: JSON.stringify({ 'dist-tags': { latest: 'nightly' }, time: {}, versions: {} }),
        [OPENAI_PYPI]: pypiBody('3.0.0', { '3.0.0': '2026-01-01T00:00:00Z' }),
      }),
    });
    expect(r.packages.some((p) => p.ecosystem === 'npm')).toBe(false);
    expect(r.sources.some((s) => s.note.includes('no readable latest version'))).toBe(true);
  });

  // The same rule the catalog has: an empty record is not a small record, it is a lie.
  it('REFUSES to produce a record when nothing could be read', async () => {
    await expect(buildSdkReleases({ now: NOW, fetchImpl: stub({}) })).rejects.toThrow(
      /no SDK release source could be read/,
    );
  });
});

describe('the file it writes', () => {
  it('is deterministic and package-ordered', async () => {
    const fetchImpl = stub({
      [OPENAI_NPM]: npmBody('7.0.0', { '7.0.0': '2026-01-01T00:00:00Z' }),
      [OPENAI_PYPI]: pypiBody('3.0.0', { '3.0.0': '2026-01-01T00:00:00Z' }),
    });
    const a = serializeSdkReleases(await buildSdkReleases({ now: NOW, fetchImpl }));
    const b = serializeSdkReleases(await buildSdkReleases({ now: NOW, fetchImpl }));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('carries its schema and a seconds-precision timestamp', async () => {
    const r = await buildSdkReleases({
      now: NOW,
      fetchImpl: stub({ [OPENAI_NPM]: npmBody('7.0.0', { '7.0.0': '2026-01-01T00:00:00Z' }) }),
    });
    expect(r.schema).toBe(SDK_RELEASES_SCHEMA);
    expect(r.fetchedAt).toBe('2026-09-18T00:00:00Z');
  });
});
