import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSdkSpec, resolveSdk } from '../registry/graph.js';
import type { SdkReleases } from '../registry/sdkReleases.js';
import { lockedSdkLines } from '../report/auditReport.js';
import { readLockedSdks, type LockedSdkReport } from './lockedSdks.js';

// PLANE 2, SLICE 1 — the root package-lock.json, read for the provider SDKs the ROOT project
// declares, and resolved through the same contract graph `mendr resolve` uses.
//
// The rules these tests hold: a range is never an install; a copy nobody declared is not
// the team's SDK; anything not read is NAMED, never counted as "none"; a spec or resolved
// URL is never printed (either can carry a registry token); and nothing here can make the
// report sound like an alarm.

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-locked-'));
  created.push(dir);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

/** A lockfileVersion 3 lock: `declared` goes on the root project, `locked` under node_modules/. */
function lock(declared: Record<string, string>, locked: Record<string, object>, extra: Record<string, object> = {}) {
  const packages: Record<string, object> = { '': { name: 'app', version: '1.0.0', dependencies: declared } };
  for (const [name, entry] of Object.entries(locked)) packages[`node_modules/${name}`] = entry;
  return { name: 'app', lockfileVersion: 3, requires: true, packages: { ...packages, ...extra } };
}

const NOW = new Date('2026-09-19T00:00:00Z');
const RELEASES: SdkReleases = {
  schema: 'mendr-sdk-releases/v1',
  fetchedAt: '2026-09-18T03:44:22Z',
  sources: [],
  count: 2,
  packages: [
    {
      ecosystem: 'npm',
      name: 'openai',
      provider: 'openai',
      latest: '7.18.0',
      latestMajor: 7,
      majorsFirstSeen: {
        '3': '2022-06-07T20:28:50.838Z',
        '4': '2023-06-17T16:33:09.139Z',
        '5': '2024-12-20T21:13:59.486Z',
        '6': '2025-09-30T16:35:32.100Z',
        '7': '2026-07-27T21:56:56.615Z',
      },
      releaseCount: 388,
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
  ],
};

const row = (mark: string, label: string, detail: string): string => `${mark} ${label}: ${detail}`;
const render = (r: LockedSdkReport): string => lockedSdkLines(r, row).join('\n');

describe('reading the root package-lock.json', () => {
  it('resolves a declared SDK at its LOCKED version, not its declared range', () => {
    const dir = repo({ 'package-lock.json': lock({ openai: '^4.20.0' }, { openai: { version: '4.24.7' } }) });
    const r = readLockedSdks(dir, RELEASES, NOW);
    expect(r.state).toBe('read');
    expect(r.sdks).toHaveLength(1);
    expect(r.sdks[0]).toMatchObject({ name: 'openai', version: '4.24.7' });
    expect(r.sdks[0]!.resolution?.outcome).toBe('sdk_newer_majors');
  });

  // The audit and `mendr resolve` must never disagree about the same version.
  it("carries resolveSdk's reason word for word", () => {
    const dir = repo({ 'package-lock.json': lock({ openai: '4.24.7' }, { openai: { version: '4.24.7' } }) });
    const [sdk] = readLockedSdks(dir, RELEASES, NOW).sdks;
    expect(sdk!.reason).toBe(resolveSdk(RELEASES, parseSdkSpec('npm:openai@4.24.7')!, NOW).reason);
  });

  it('counts devDependencies, optionalDependencies and peerDependencies as declared too', () => {
    const l = lock({}, { openai: { version: '7.1.0' }, '@anthropic-ai/sdk': { version: '0.40.0' } });
    (l.packages[''] as Record<string, unknown>).devDependencies = { openai: '^7' };
    (l.packages[''] as Record<string, unknown>).peerDependencies = { '@anthropic-ai/sdk': '*' };
    (l.packages[''] as Record<string, unknown>).optionalDependencies = { '@google/genai': '^1' };
    l.packages['node_modules/@google/genai'] = { version: '1.9.0' };
    const r = readLockedSdks(repo({ 'package-lock.json': l }), RELEASES, NOW);
    expect(r.sdks.map((s) => s.name)).toEqual(['openai', '@anthropic-ai/sdk', '@google/genai']);
  });

  // A hoisted copy another package pulled in is that package's choice, not the team's.
  it('does not list an SDK the root project never declared, even when it is installed', () => {
    const dir = repo({
      'package-lock.json': lock({ langchain: '^0.3.0' }, { langchain: { version: '0.3.5' }, openai: { version: '4.24.7' } }),
    });
    const r = readLockedSdks(dir, RELEASES, NOW);
    expect(r.state).toBe('read');
    expect(r.sdks).toEqual([]);
  });

  it('reports a 0.x SDK as not checked, never as current', () => {
    const dir = repo({
      'package-lock.json': lock({ '@anthropic-ai/sdk': '^0.40.0' }, { '@anthropic-ai/sdk': { version: '0.40.1' } }),
    });
    expect(readLockedSdks(dir, RELEASES, NOW).sdks[0]!.resolution?.outcome).toBe('sdk_unchecked');
  });

  it('with no release record, checks nothing', () => {
    const dir = repo({ 'package-lock.json': lock({ openai: '7.1.0' }, { openai: { version: '7.1.0' } }) });
    expect(readLockedSdks(dir, null, NOW).sdks[0]!.resolution?.outcome).toBe('sdk_unchecked');
  });
});

describe('what it refuses to resolve', () => {
  // The shapes npm 11 actually writes. Each carries a registry-looking `version` — the
  // installed package.json's own — so only `resolved` can tell the source.
  it.each([
    ['a linked local package', { link: true, resolved: 'packages/openai' }, 'linked local package'],
    ['an npm alias for another package', { name: 'other-sdk', version: '9.0.0' }, 'alias for another package'],
    ['a vendored tarball', { version: '4.24.7', resolved: 'file:vendor/openai-4.24.7.tgz', integrity: 'sha512-x' }, 'not a registry release'],
    ['a git fork', { version: '4.24.7', resolved: 'git+ssh://git@github.com/acme/openai-fork.git#11c1fc3' }, 'not a registry release'],
    ['a directory installed with --install-links', { version: '4.24.7', resolved: 'file:vendored-openai' }, 'not a registry release'],
    ['a tarball downloaded from a plain URL', { version: '4.24.7', resolved: 'https://example.com/downloads/openai.tgz' }, 'not a registry release'],
  ])('%s', (_label, entry, words) => {
    const dir = repo({ 'package-lock.json': lock({ openai: 'x' }, { openai: entry }) });
    const [sdk] = readLockedSdks(dir, RELEASES, NOW).sdks;
    expect(sdk!.resolution).toBeNull();
    expect(sdk!.version).toBeNull();
    expect(sdk!.reason).toContain(words);
    expect(sdk!.reason).toContain('NOT resolved');
  });

  // A peer-only declaration with nothing installed: the header must not call it "locked".
  it('a declared SDK with no locked copy, counted as declared and not resolved', () => {
    const r = readLockedSdks(repo({ 'package-lock.json': lock({ openai: '^4' }, {}) }), RELEASES, NOW);
    expect(r.sdks[0]!.reason).toContain('records no installed copy');
    expect(render(r)).toContain('1 declared by the root project in package-lock.json, 1 not resolved');
    expect(render(r)).not.toContain('locked in package-lock.json');
  });
});

describe('what counts as a registry release', () => {
  it.each([
    ['the public registry', 'openai', 'https://registry.npmjs.org/openai/-/openai-4.24.7.tgz'],
    ['a scoped package', '@anthropic-ai/sdk', 'https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-0.40.1.tgz'],
    ['a private registry', 'openai', 'https://npm.corp.example/api/npm/openai/-/openai-4.24.7.tgz'],
    ['a lockfile that omits resolved', 'openai', undefined],
  ])('%s is resolved', (_label, name, resolved) => {
    const version = name === 'openai' ? '4.24.7' : '0.40.1';
    const dir = repo({ 'package-lock.json': lock({ [name]: '*' }, { [name]: { version, resolved } }) });
    expect(readLockedSdks(dir, RELEASES, NOW).sdks[0]!.resolution).not.toBeNull();
  });
});

describe('an SDK declared under an npm alias', () => {
  // "openai-v3": "npm:openai@3.3.0" — the key is not an SDK name, the lock entry's `name` is.
  const aliased = { name: 'openai', version: '3.3.0', resolved: 'https://registry.npmjs.org/openai/-/openai-3.3.0.tgz' };

  it('is found and resolved under the SDK name, never reported as "none"', () => {
    const r = readLockedSdks(repo({ 'package-lock.json': lock({ 'openai-v3': 'npm:openai@3.3.0' }, { 'openai-v3': aliased }) }), RELEASES, NOW);
    expect(r.sdks).toHaveLength(1);
    expect(r.sdks[0]).toMatchObject({ name: 'openai', alias: 'openai-v3', version: '3.3.0' });
    expect(render(r)).toContain('openai 3.3.0 (as openai-v3)');
    expect(render(r)).not.toContain('declares none');
  });

  // The migration pattern: the current SDK and the old one side by side. Both are listed.
  it('lists both copies when an old major is kept beside the current one', () => {
    const r = readLockedSdks(
      repo({
        'package-lock.json': lock(
          { openai: '4.24.7', 'openai-v3': 'npm:openai@3.3.0' },
          { openai: { version: '4.24.7' }, 'openai-v3': aliased },
        ),
      }),
      RELEASES,
      NOW,
    );
    expect(r.sdks.map((s) => `${s.name} ${s.version}${s.alias ? ` as ${s.alias}` : ''}`)).toEqual([
      'openai 4.24.7',
      'openai 3.3.0 as openai-v3',
    ]);
  });
});

describe('what it does not read, and says so', () => {
  it('names nested lockfiles and other formats instead of calling them "none"', () => {
    const dir = repo({
      'package-lock.json': lock({}, {}),
      'apps/web/package-lock.json': lock({ openai: '^5' }, { openai: { version: '5.1.0' } }),
      'server/yarn.lock': '# yarn lockfile v1\n',
      'py/uv.lock': 'version = 1\n',
      'py/requirements-dev.txt': 'openai==0.28.1\n',
    });
    const r = readLockedSdks(dir, RELEASES, NOW);
    expect(r.otherLockfiles).toEqual({
      'package-lock.json in subdirectories': 1,
      'yarn.lock': 1,
      'uv.lock': 1,
      'requirements*.txt': 1,
    });
    expect(render(r)).toContain('not read: package-lock.json in subdirectories (1), requirements*.txt (1), uv.lock (1), yarn.lock (1)');
  });

  it('skips the directories the configuration scan skips', () => {
    const dir = repo({
      'package-lock.json': lock({}, {}),
      'node_modules/pkg/package-lock.json': lock({}, {}),
      'dist/yarn.lock': '',
    });
    expect(readLockedSdks(dir, RELEASES, NOW).otherLockfiles).toEqual({});
  });

  // A monorepo whose SDKs live in a workspace must read "not read", never "none".
  it('counts workspace packages whose own dependencies were not read', () => {
    const dir = repo({
      'package-lock.json': lock({}, {}, {
        'packages/api': { name: '@app/api', dependencies: { openai: '^5' } },
        'packages/web': { name: '@app/web' },
        'node_modules/@app/api': { resolved: 'packages/api', link: true },
      }),
    });
    const r = readLockedSdks(dir, RELEASES, NOW);
    expect(r.localPackagesNotRead).toBe(2);
    expect(render(r)).toContain('not read: 2 local packages in package-lock.json (workspaces or linked directories)');
  });

  it.each([
    ['no root lockfile', {}, 'absent', 'no package-lock.json at the repository root'],
    ['a root npm-shrinkwrap.json', { 'npm-shrinkwrap.json': '{}', 'package-lock.json': '{}' }, 'shrinkwrap', 'takes precedence'],
    ['lockfileVersion 1', { 'package-lock.json': { lockfileVersion: 1, dependencies: {} } }, 'unsupported', 'lockfileVersion 1'],
    ['a lockfile that is not JSON', { 'package-lock.json': '{ not json' }, 'failed', 'could not be read (not valid JSON)'],
  ])('%s', (_label, files, state, words) => {
    const r = readLockedSdks(repo(files as Record<string, string | object>), RELEASES, NOW);
    expect(r.state).toBe(state);
    expect(render(r)).toContain(words);
  });
});

describe('what the report may say', () => {
  // A spec or a resolved URL can carry a registry token. Neither is ever printed.
  it('never prints a spec, a resolved URL or an integrity hash', () => {
    const dir = repo({
      'package-lock.json': lock(
        { openai: 'git+https://x-access-token:ghs_SECRET@github.com/o/r.git' },
        {
          openai: {
            version: '4.24.7',
            resolved: 'https://u:npm_SECRETTOKEN@registry.example.com/openai/-/openai-4.24.7.tgz',
            integrity: 'sha512-SECRETINTEGRITY',
          },
        },
      ),
    });
    const text = render(readLockedSdks(dir, RELEASES, NOW));
    expect(text).toContain('openai 4.24.7');
    expect(text).not.toMatch(/SECRET|ghs_|npm_|registry\.example|sha512|git\+https/);
  });

  // It is information beside an audit about retiring model ids: never an alarm, never advice.
  it('never words a result as an alarm or a recommendation', () => {
    const reports: LockedSdkReport[] = [
      readLockedSdks(repo({ 'package-lock.json': lock({ openai: '4' }, { openai: { version: '4.24.7' } }) }), RELEASES, NOW),
      readLockedSdks(repo({ 'package-lock.json': lock({ openai: '7' }, { openai: { version: '7.1.0' } }) }), RELEASES, NOW),
      readLockedSdks(repo({ 'package-lock.json': '{ nope' }), RELEASES, NOW),
      readLockedSdks(repo({}), RELEASES, NOW),
    ];
    for (const r of reports) {
      const text = render(r);
      expect(text).not.toMatch(/outdated|behind|upgrade|vulnerab|breaking change|EXPOSURE|up.to.date|\bclean\b|\bsafe\b/i);
      if (r.state === 'read' || r.state === 'failed') expect(text).toContain('information only, never part of the conclusion');
    }
  });
});
