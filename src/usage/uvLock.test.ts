import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSdkSpec, resolveSdk } from '../registry/graph.js';
import type { SdkReleases } from '../registry/sdkReleases.js';
import { pythonSdkLines } from '../report/auditReport.js';
import { readPinnedRequirements } from './pinnedRequirements.js';
import { readUvLock, type UvLockReport } from './uvLock.js';

// PLANE 2, SLICE 4 — the root uv.lock, read without a TOML dependency.
//
// The rules these tests hold: the reader FAILS CLOSED on any shape it does not recognise,
// because a missed line would become a confident "no provider SDK here"; an SDK locked but
// not declared by the root project is named and counted, never resolved and never "none";
// and only a registry-sourced copy is resolved.

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-uv-'));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const NOW = new Date('2026-09-19T00:00:00Z');
const RELEASES: SdkReleases = {
  schema: 'mendr-sdk-releases/v1',
  fetchedAt: '2026-09-18T03:44:22Z',
  sources: [],
  count: 2,
  packages: [
    {
      ecosystem: 'pypi',
      name: 'openai',
      provider: 'openai',
      latest: '3.15.0',
      latestMajor: 3,
      majorsFirstSeen: { '1': '2023-09-29T00:00:00Z', '2': '2025-09-30T00:00:00Z', '3': '2026-08-12T00:00:00Z' },
      releaseCount: 427,
    },
    {
      ecosystem: 'pypi',
      name: 'anthropic',
      provider: 'anthropic',
      latest: '1.6.0',
      latestMajor: 1,
      majorsFirstSeen: { '0': '2023-02-09T00:00:00Z', '1': '2026-08-20T00:00:00Z' },
      releaseCount: 218,
    },
  ],
};

/** The shape uv writes: a header, the root project, then one block per locked package. */
const HEADER = 'version = 1\nrevision = 3\nrequires-python = ">=3.11"\n';
const root = (deps: string[], extra = ''): string =>
  `\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [\n${deps.map((d) => `    { name = "${d}" },\n`).join('')}]\n${extra}`;
const pkg = (name: string, version: string, source = 'registry = "https://pypi.org/simple"'): string =>
  `\n[[package]]\nname = "${name}"\nversion = "${version}"\nsource = { ${source} }\nsdist = { url = "https://files.pythonhosted.org/x.tar.gz", hash = "sha256:aa", size = 1 }\nwheels = [\n    { url = "https://files.pythonhosted.org/y.whl", hash = "sha256:bb", size = 2 },\n]\n`;

const read = (lock: string, files: Record<string, string | Buffer> = {}): UvLockReport =>
  readUvLock(repo({ 'uv.lock': lock, ...files }), RELEASES, NOW);
const row = (mark: string, label: string, detail: string): string => `${mark} ${label}: ${detail}`;
const render = (uv: UvLockReport, dir?: string): string =>
  pythonSdkLines({ reqs: dir ? readPinnedRequirements(dir, RELEASES, NOW) : undefined, uv }, row).join('\n');

describe('an SDK the root project declares', () => {
  it('is resolved at its locked version, with resolveSdk’s reason word for word', () => {
    const r = read(HEADER + root(['openai']) + pkg('openai', '2.29.0'));
    expect(r.state).toBe('read');
    expect(r.sdks[0]).toMatchObject({ name: 'openai', version: '2.29.0' });
    expect(r.sdks[0]!.reason).toBe(resolveSdk(RELEASES, parseSdkSpec('pypi:openai@2.29.0')!, NOW).reason);
  });

  it('counts optional and dev dependency groups, including a group named with a digit', () => {
    const groups = '\n[package.optional-dependencies]\ns3 = [\n    { name = "openai" },\n]\n\n[package.dev-dependencies]\ndev = [\n    { name = "anthropic" },\n]\n';
    const r = read(HEADER + root([], groups) + pkg('openai', '2.29.0') + pkg('anthropic', '0.86.0'));
    expect(r.state).toBe('read');
    expect(r.sdks.map((s) => s.name)).toEqual(['openai', 'anthropic']);
  });

  it.each([
    ['a git source', 'git = "https://github.com/acme/openai?rev=abc"'],
    ['a directory source', 'directory = "vendor/openai"'],
    ['a URL source', 'url = "https://example.com/openai.whl"'],
  ])('is refused when it comes from %s', (_label, source) => {
    const r = read(HEADER + root(['openai']) + pkg('openai', '2.29.0', source));
    expect(r.sdks[0]!.resolution).toBeNull();
    expect(r.sdks[0]!.reason).toContain('not a registry release');
  });

  it('says so when the lock records no copy of it at all', () => {
    expect(read(HEADER + root(['openai'])).sdks[0]!.reason).toContain('the lock records no copy');
  });
});

describe('an SDK locked but not declared by the root project', () => {
  // langflow and otari: another package asked for it. Not the team's dependency, and not "none".
  it('is named and counted, never resolved, and never leaves a bare tick', () => {
    const r = read(HEADER + root(['some-framework']) + pkg('some-framework', '1.0.0') + pkg('openai', '2.29.0'));
    expect(r.sdks).toEqual([]);
    expect(r.lockedNotDeclared).toEqual(['openai']);
    const text = render(r);
    expect(text).toContain('1 locked in uv.lock that the root project does not declare (openai)');
    expect(text).toContain('another package asked for them');
    expect(text).not.toMatch(/✓/);
  });
});

describe('it fails closed', () => {
  it.each([
    ['a line it does not recognise in the root project', HEADER + root(['openai'], 'mystery-field\n') + pkg('openai', '2.29.0')],
    ['a dependency entry it does not recognise', HEADER + '\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [\n    "openai",\n]\n'],
    ['an array that never closes', HEADER + '\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [\n    { name = "openai" },\n'],
    ['no root project', HEADER + pkg('openai', '2.29.0')],
    ['no lock-format version', 'revision = 3\n' + root(['openai']) + pkg('openai', '2.29.0')],
  ])('on %s', (_label, lock) => {
    const r = read(lock);
    expect(r.state).toBe('failed');
    expect(r.sdks).toEqual([]);
    expect(render(r)).not.toMatch(/✓/);
  });

  it('on a lock-format version it does not know', () => {
    const r = read('version = 99\n' + root(['openai']) + pkg('openai', '2.29.0'));
    expect(r.state).toBe('unsupported');
    expect(r.note).toContain('99');
  });

  it('on a file that is not text', () => {
    expect(read('').state).toBe('failed'); // empty: no version header
    expect(readUvLock(repo({ 'uv.lock': Buffer.from([0x76, 0x00, 0x31]) }), RELEASES, NOW).state).toBe('failed');
  });

  it('but reads a file with no uv.lock at all as simply absent', () => {
    expect(readUvLock(repo({ 'pyproject.toml': '[project]\n' }), RELEASES, NOW).state).toBe('absent');
  });
});

describe('what the row says beside the requirements row', () => {
  it('names both sources and tags every line with its file', () => {
    const dir = repo({
      'uv.lock': HEADER + root(['openai']) + pkg('openai', '2.29.0'),
      'requirements.txt': 'anthropic==0.39.0\n',
    });
    const text = pythonSdkLines({ reqs: readPinnedRequirements(dir, RELEASES, NOW), uv: readUvLock(dir, RELEASES, NOW) }, row).join('\n');
    expect(text).toContain('2 listed in the root requirements*.txt and uv.lock');
    expect(text).toContain('anthropic 0.39.0 (requirements.txt)');
    expect(text).toContain('openai 2.29.0 (uv.lock)');
  });

  // Slice 3 named uv.lock as "not read". Now that this row speaks for it, it must not say both.
  it('stops naming uv.lock as not read once this row speaks for it', () => {
    const dir = repo({ 'uv.lock': HEADER + root(['openai']) + pkg('openai', '2.29.0'), 'requirements.txt': 'requests==2.31.0\n' });
    const text = pythonSdkLines({ reqs: readPinnedRequirements(dir, RELEASES, NOW), uv: readUvLock(dir, RELEASES, NOW) }, row).join('\n');
    expect(text).not.toMatch(/not read:.*uv\.lock/);
  });

  it('names uv.lock, once, when it could not be read', () => {
    const dir = repo({ 'uv.lock': 'version = 1\nnonsense\n', 'requirements.txt': 'requests==2.31.0\n' });
    const text = pythonSdkLines({ reqs: readPinnedRequirements(dir, RELEASES, NOW), uv: readUvLock(dir, RELEASES, NOW) }, row).join('\n');
    expect(text.match(/uv\.lock/g)).toHaveLength(1);
    expect(text).not.toMatch(/✓/);
  });

  it('counts workspace members whose own dependencies were not read', () => {
    const lock = HEADER + root(['openai']) + pkg('openai', '2.29.0') + '\n[[package]]\nname = "member"\nversion = "0.1.0"\nsource = { editable = "packages/member" }\n';
    const r = read(lock);
    expect(r.localPackagesNotRead).toBe(1);
    expect(render(r)).toContain('1 local package in uv.lock');
  });

  it('never words a locked version as declared, installed or used, nor as advice', () => {
    for (const text of [
      render(read(HEADER + root(['openai']) + pkg('openai', '2.29.0'))),
      render(read(HEADER + root(['x']) + pkg('x', '1.0.0') + pkg('openai', '2.29.0'))),
      render(read('version = 1\nnonsense\n')),
    ]) {
      expect(text).not.toMatch(/\b(installed|used|unused|upgrade|outdated|vulnerab|should|recommend|clean|safe)\b/i);
    }
  });
});

// ---------------------------------------------------------------------------------------
// What the adversarial review found, each pinned by a test.

describe('metadata tables never decide whether the lock can be read', () => {
  // onyx-dot-app/onyx: uv writes a single-element dependency group inline, and that inline
  // table carries its own "]" — which used to fail the whole file.
  it('reads a root project whose metadata holds a one-line array with a nested bracket', () => {
    const metadata =
      '\n[package.metadata]\nrequires-dist = [{ name = "openai", specifier = ">=2" }]\n\n[package.metadata.requires-dev]\nods = [{ name = "devtools", extras = ["audit"], specifier = "==0.13.8" }]\n';
    const r = read(HEADER + root(['openai'], metadata) + pkg('openai', '2.29.0'));
    expect(r.state).toBe('read');
    expect(r.sdks[0]).toMatchObject({ name: 'openai', version: '2.29.0' });
  });
});

describe('the row never denies a file it failed to read', () => {
  it('says the root uv.lock could not be read, rather than that there is none', () => {
    const dir = repo({ 'uv.lock': 'version = 1\nnonsense\n' });
    const text = pythonSdkLines({ reqs: readPinnedRequirements(dir, RELEASES, NOW), uv: readUvLock(dir, RELEASES, NOW) }, row).join('\n');
    expect(text).toContain('✗ Python SDKs: the root uv.lock could not be read (below)');
    expect(text).not.toContain('no requirements*.txt or uv.lock at the repository root');
  });

  it('still says there is none when the root really has neither', () => {
    const dir = repo({ 'pyproject.toml': '[project]\n' });
    const text = pythonSdkLines({ reqs: readPinnedRequirements(dir, RELEASES, NOW), uv: readUvLock(dir, RELEASES, NOW) }, row).join('\n');
    expect(text).toContain('○ Python SDKs: not read — no requirements*.txt or uv.lock at the repository root');
  });
});

describe('a version that hides text before an @', () => {
  // parseSdkSpec splits on the LAST '@', so "1.0\u001b[31m@2.29.0" would otherwise print raw.
  it('is refused, and its text never reaches the report', () => {
    const r = read(HEADER + root(['openai']) + pkg('openai', '1.0\u001b[31mEVIL@2.29.0'));
    expect(r.sdks[0]!.resolution).toBeNull();
    expect(r.sdks[0]!.version).toBeNull();
    expect(render(r)).not.toMatch(/EVIL|\u001b/);
  });
});

describe('one source, one verb', () => {
  it('says "lists" when only uv.lock was read', () => {
    expect(render(read(HEADER + root(['requests']) + pkg('requests', '2.31.0')))).toContain('uv.lock lists none of the 4 PyPI provider SDKs');
  });
});
