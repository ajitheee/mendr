import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSdkSpec, resolveSdk } from '../registry/graph.js';
import type { SdkReleases } from '../registry/sdkReleases.js';
import { lockedSdkLines, npmRowBesidePython, pythonSdkLines, sdkJobSummaryMarkdown } from '../report/auditReport.js';
import { readLockedSdks } from './lockedSdks.js';
import { readPinnedRequirements, type PythonReqReport } from './pinnedRequirements.js';

// PLANE 2, SLICE 3 — exact `==` pins of the PyPI provider SDKs in the ROOT requirements*.txt.
//
// The rules these tests hold: only an exact pin is resolved, never a range; a pin is
// "listed", never "declared", "installed" or "used"; anything at the root that was not read
// is NAMED, and a "none" beside it is partial (○), never a tick; and nothing but the SDK
// name, a grammar-checked version, an allow-listed file name, integers and fixed reasons is
// ever printed.

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-pyreq-'));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const NOW = new Date('2026-09-19T00:00:00Z');
const RELEASES: SdkReleases = {
  schema: 'mendr-sdk-releases/v1',
  fetchedAt: '2026-09-18T03:44:22Z',
  sources: [],
  count: 3,
  packages: [
    {
      ecosystem: 'pypi',
      name: 'openai',
      provider: 'openai',
      latest: '3.15.0',
      latestMajor: 3,
      majorsFirstSeen: { '0': '2020-02-18T00:00:00Z', '1': '2023-09-29T00:00:00Z', '2': '2025-09-30T00:00:00Z', '3': '2026-08-12T00:00:00Z' },
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
    {
      ecosystem: 'pypi',
      name: 'google-generativeai',
      provider: 'google',
      latest: '0.8.6',
      latestMajor: 0,
      majorsFirstSeen: { '0': '2023-05-03T00:00:00Z' },
      releaseCount: 28,
    },
  ],
};

const read = (files: Record<string, string | Buffer>): PythonReqReport => readPinnedRequirements(repo(files), RELEASES, NOW)!;
const row = (mark: string, label: string, detail: string): string => `${mark} ${label}: ${detail}`;
const render = (r: PythonReqReport): string => pythonSdkLines({ reqs: r }, row).join('\n');
const one = (requirements: string) => read({ 'requirements.txt': requirements }).sdks;

describe('an exact == pin', () => {
  it('is resolved, with resolveSdk’s reason word for word', () => {
    const [s] = one('openai==1.40.6\n');
    expect(s).toMatchObject({ name: 'openai', version: '1.40.6', file: 'requirements.txt' });
    expect(s!.reason).toBe(resolveSdk(RELEASES, parseSdkSpec('pypi:openai@1.40.6')!, NOW).reason);
  });

  it.each([
    ['spaces around ==', 'openai == 1.40.6'],
    ['a parenthesised spec', 'openai (==1.40.6)'],
    ['extras', 'OpenAI[datalib]==1.40.6'],
    ['a hash option', 'openai==1.40.6 --hash=sha256:abc123'],
    ['a trailing comment', 'openai==1.40.6  # pinned for the old client'],
    ['a backslash continuation', 'openai==1.40.6 \\\n    --hash=sha256:abc123'],
  ])('%s', (_label, line) => {
    const [s] = one(`${line}\n`);
    expect(s!.version).toBe('1.40.6');
    expect(s!.resolution).not.toBeNull();
  });

  it('matches names the way PyPI does (PEP 503)', () => {
    expect(one('Google_GenerativeAI==0.4.1\n')[0]).toMatchObject({ name: 'google-generativeai', version: '0.4.1' });
  });

  it('lists a pin in every root requirements file it appears in', () => {
    const r = read({ 'requirements.txt': 'openai==1.40.6\n', 'requirements-dev.txt': 'openai==1.40.6\n' });
    expect(r.sdks.map((s) => s.file)).toEqual(['requirements-dev.txt', 'requirements.txt']);
  });
});

describe('what is refused, never guessed', () => {
  it.each([
    ['a lower bound', 'openai>=1.40'],
    ['a compatible release', 'openai~=1.64.0'],
    ['an exclusion', 'openai!=1.0'],
    ['a wildcard', 'openai==1.*'],
    ['two clauses', 'openai==1.40.6,<2'],
    ['arbitrary equality', 'openai===1.40.6'],
    ['no version', 'openai'],
  ])('%s', (_label, line) => {
    const [s] = one(`${line}\n`);
    expect(s!.resolution).toBeNull();
    expect(s!.version).toBeNull();
    expect(s!.reason).toBe('a range or no version, not an exact == pin — NOT resolved');
  });

  it('a pin behind an environment marker', () => {
    expect(one('openai==1.40.6; python_version < "3.9"\n')[0]!.reason).toContain('environment marker');
  });

  it('a URL or VCS install', () => {
    expect(one('openai @ git+https://github.com/acme/openai-fork@v1\n')[0]!.reason).toContain('URL or VCS');
  });

  it('the same SDK twice in one file', () => {
    const sdks = one('openai==1.40.6\nopenai==1.41.0\n');
    expect(sdks).toHaveLength(1);
    expect(sdks[0]!.reason).toBe('listed 2 times in requirements.txt — NOT resolved');
  });
});

describe("pip-compile's own '# via' note", () => {
  // aider: openai is pinned because litellm needs it, not because the app asked for it.
  it('says so when the note names only other packages or constraint files', () => {
    const [s] = one('openai==2.28.0\n    # via\n    #   -c requirements/common-constraints.txt\n    #   litellm\norjson==3.11.7\n');
    expect(s!.viaOthersOnly).toBe(true);
    expect(render(read({ 'requirements.txt': 'openai==2.28.0\n    # via litellm\n' }))).toContain(
      "the file's own '# via' note names only other packages or constraint files",
    );
  });

  it('does not say so when the note names a -r input', () => {
    expect(one('openai==2.28.0\n    # via -r requirements.in\n')[0]!.viaOthersOnly).toBe(false);
  });

  it('does not say so when there is no note', () => {
    expect(one('openai==2.28.0\nanthropic==0.39.0\n')[0]!.viaOthersOnly).toBe(false);
  });
});

describe('what it does not read, and says so', () => {
  it('counts includes, editable installs and lines it cannot read', () => {
    const r = read({
      'requirements.txt': [
        '-r base.txt',
        '-c constraints.txt',
        '-e .',
        '--index-url https://pypi.corp.example/simple',
        'git+https://github.com/acme/tool.git#egg=openai',
        'https://files.example.com/openai-1.0.tar.gz',
        './vendor/anthropic',
        'openai-1.0-py3-none-any.whl',
        'requests==2.31.0',
      ].join('\n'),
    });
    expect(r).toMatchObject({ includes: 2, editables: 1, unreadableLines: 4 });
    expect(r.sdks).toEqual([]);
    expect(render(r)).toContain('not read: 2 -r/-c includes, 1 editable or local install, 4 lines this build could not read');
  });

  it.each([
    ['NUL bytes', Buffer.from([0x6f, 0x70, 0x00, 0x65])],
    ['invalid UTF-8', Buffer.from([0x6f, 0x70, 0xff, 0xfe, 0x3d])],
  ])('treats a file with %s as not read, never as "none"', (_label, bytes) => {
    const r = read({ 'requirements.txt': bytes });
    expect(r.filesNotRead).toBe(1);
    expect(render(r)).toContain('could not be read');
    expect(render(r)).not.toContain('list none');
  });

  it('reads a file that starts with a byte-order mark', () => {
    expect(one('﻿openai==1.40.6\n')[0]!.version).toBe('1.40.6');
  });

  it('names the other Python manifests at the root', () => {
    const r = read({ 'requirements.txt': 'requests==2.31.0\n', 'pyproject.toml': '[project]\n', 'uv.lock': 'version = 1\n' });
    expect(r.rootManifestsNotRead).toEqual(['pyproject.toml', 'uv.lock']);
  });

  it('shows no Python row at all when the root has no Python dependency file', () => {
    expect(readPinnedRequirements(repo({ 'package.json': '{}' }), RELEASES, NOW)).toBeUndefined();
  });

  it('shows "not read" when the root has Python manifests but no requirements*.txt', () => {
    const r = read({ 'pyproject.toml': '[project]\n' });
    expect(render(r)).toContain('○ Python SDKs: not read — no requirements*.txt or uv.lock at the repository root');
  });
});

describe('a "none" is only clean when nothing at the root went unread', () => {
  it('ticks a "none" when every line and file was read', () => {
    expect(render(read({ 'requirements.txt': 'requests==2.31.0\n' }))).toContain(
      '✓ Python SDKs: the root requirements*.txt lists none of the 4 PyPI provider SDKs',
    );
  });

  it.each([
    ['a -r include', { 'requirements.txt': '-r base.txt\n' }],
    ['an editable install', { 'requirements.txt': '-e .\n' }],
    ['a pyproject.toml', { 'requirements.txt': 'requests==2.31.0\n', 'pyproject.toml': '[project]\n' }],
    ['a URL line', { 'requirements.txt': 'git+https://github.com/acme/x.git\n' }],
  ])('marks it partial beside %s', (_label, files) => {
    const text = render(read(files as Record<string, string>));
    expect(text).toContain('○ Python SDKs: the root requirements*.txt lists none of the 4 PyPI provider SDKs directly; part of the root was not read');
    expect(text).not.toMatch(/✓/);
  });
});

describe('what the Python row may print', () => {
  it('never echoes a spec, URL, index, marker or comment', () => {
    const r = read({
      'requirements.txt': [
        '--index-url https://user:ghp_SECRETTOKEN0123456789abcd@pypi.corp.example/simple',
        'openai @ https://user:ghp_SECRETTOKEN0123456789abcd@github.com/acme/openai.git',
        'anthropic==0.39.0; platform_system == "SECRETMARKER"',
        'google-generativeai==0.4.1  # SECRETCOMMENT',
      ].join('\n'),
    });
    const text = render(r);
    expect(text).not.toMatch(/SECRET|ghp_|pypi\.corp|github\.com|platform_system/);
    expect(text).toContain('google-generativeai 0.4.1 (requirements.txt)');
  });

  it('describes a file name it will not print', () => {
    expect(read({ 'requirements $(whoami).txt': 'openai==1.40.6\n' }).sdks[0]!.file).toBe('a requirements*.txt file');
  });

  // A pin in a requirements file is LISTED; it may be transitive, and nothing here knows usage.
  it('never words a pin as declared, installed or used, nor as advice or an alarm', () => {
    const texts = [
      render(read({ 'requirements.txt': 'openai==1.40.6\nanthropic==0.39.0\ngoogle-generativeai==0.4.1\n' })),
      render(read({ 'requirements.txt': 'openai>=1\n-r x.txt\n' })),
      render(read({ 'requirements.txt': 'requests==1\n' })),
      render(read({ 'requirements.txt': 'openai @ git+https://github.com/acme/openai@v1\n' })),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/\b(declared|installed|used|unused|upgrade|outdated|vulnerab|should|recommend|clean|safe)\b/i);
    }
  });
});

describe('how it sits beside the npm row', () => {
  // In the HUMAN report the Python row reads the root files, so the npm row names only the
  // nested ones there.
  it('in the human report, names only the nested requirements files under the npm row', () => {
    const dir = repo({ 'requirements.txt': 'openai==1.40.6\n' });
    mkdirSync(join(dir, 'svc'));
    writeFileSync(join(dir, 'svc', 'requirements.txt'), 'anthropic==0.39.0\n');
    const npm = readLockedSdks(dir, RELEASES, NOW);
    const python = readPinnedRequirements(dir, RELEASES, NOW);
    const shown = lockedSdkLines(npmRowBesidePython(npm, { reqs: python }), row).join('\n');
    expect(shown).toContain('not read: requirements*.txt in subdirectories (1)');
    expect(shown).not.toMatch(/requirements\*\.txt \(2\)/);
  });

  // The job summary has no Python row in this slice, so it must stay EXACTLY as slice 2 left
  // it: the root requirements.txt is still named there as not read, never silently dropped.
  it('leaves the Actions job summary exactly as it was', () => {
    const npm = readLockedSdks(repo({ 'requirements.txt': 'openai==1.40.6\n' }), RELEASES, NOW);
    const md = sdkJobSummaryMarkdown(npm);
    expect(md).toContain('not read: requirements*.txt (1)');
    expect(md).not.toMatch(/Python SDKs|openai 1\.40\.6/);
  });
});

describe('pip-compile and uv notes that name the project itself', () => {
  // pip-tools and `uv pip compile pyproject.toml` mark a DIRECT dependency this way.
  it('treats "<project> (pyproject.toml)" as the project, not another package', () => {
    const [s] = one('openai==2.54.0\n    # via instructor (pyproject.toml)\n');
    expect(s!.viaOthersOnly).toBe(false);
  });

  // `uv export` names the root project by its bare name, which reads like any package.
  it('adds no note in a file written by uv export', () => {
    const [s] = one('# This file was autogenerated by uv via the following command:\n#    uv export --no-hashes\nopenai==3.6.0\n    # via akari-bot\n');
    expect(s!.viaOthersOnly).toBe(false);
  });

  it('reads a note on the same line (--annotation-style=line)', () => {
    expect(one('openai==2.8.1             # via kuwa-executor\n')[0]!.viaOthersOnly).toBe(true);
  });

  // With --generate-hashes, line style puts the note on its own line, comma-joined and sorted.
  it('finds a -r input inside a comma-joined note', () => {
    const [s] = one('openai==1.40.6 \\\n    --hash=sha256:aaa\n    # via -c constraints.txt, -r requirements.in\n');
    expect(s!.viaOthersOnly).toBe(false);
  });
});

describe('lines pip reads that this grammar cannot place are counted, never skipped', () => {
  it.each([
    ['a relative wheel path', 'wheels/openai-1.40.6-py3-none-any.whl'],
    ['a relative directory', 'vendor/openai'],
    ['a Windows path', 'C:\\wheels\\openai-1.40.6-py3-none-any.whl'],
    ['a file: URL', 'file:vendor/openai'],
    ['a bare archive name', 'openai-1.40.6.tar.gz'],
    ['an attached include', '-rbase.txt'],
    ['an attached editable', '-e./vendor/openai'],
    ['an option this build does not know', '--some-future-option value'],
    ['a name followed by something that is not a spec', 'openai something-else'],
  ])('%s', (_label, line) => {
    const r = read({ 'requirements.txt': `${line}\n` });
    expect(r.includes + r.editables + r.unreadableLines).toBe(1);
    expect(render(r)).not.toMatch(/✓/);
  });

  // pip never continues a COMMENT line, so the pin after it still counts.
  it('does not let a comment ending in a backslash swallow the next pin', () => {
    expect(one('# local cache on the build box: C:\\pip\\cache\\\nopenai==1.40.6\n')[0]!.version).toBe('1.40.6');
  });

  it('splits lines where Python splitlines does (form feed)', () => {
    expect(one('requests==2.31.0\fopenai==1.40.6\n').map((s) => s.version)).toEqual(['1.40.6']);
  });
});

describe('an exact pin in a form this build does not read', () => {
  it.each([
    ['an epoch', 'openai==1!1.40.6'],
    ['a local version', 'openai==1.40.6+cpu'],
    ['a non-canonical spelling', 'openai==1.0.0RC1'],
  ])('%s is refused as exactly that, not as a range', (_label, line) => {
    expect(one(`${line}\n`)[0]!.reason).toBe('an exact == pin in a version form this build does not read — NOT resolved');
  });
});

describe('a flood of lines', () => {
  // One entry per SDK per file, so the row stays bounded however long the file is.
  it('keeps one line per SDK per file, and never crashes the report', () => {
    const flood = 'openai\n'.repeat(200_000);
    const r = read({ 'requirements.txt': flood, 'requirements-dev.txt': flood });
    expect(r.sdks).toHaveLength(2);
    expect(r.sdks[0]!.reason).toMatch(/^listed 200000 times in requirements(-dev)?\.txt — NOT resolved$/);
    expect(pythonSdkLines(r, row).length).toBeLessThan(10);
  });
});

describe('the tick is earned', () => {
  it('is withheld when one of the root requirements files could not be read', () => {
    const text = render(read({ 'requirements.txt': 'requests==2.31.0\n', 'requirements-dev.txt': Buffer.from([0x61, 0x00]) }));
    expect(text).toContain('not read: 1 requirements*.txt file that could not be read');
    expect(text).not.toMatch(/✓/);
  });

  it('is withheld past the file cap', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 21; i++) files[`requirements-${String(i).padStart(2, '0')}.txt`] = 'requests==2.31.0\n';
    expect(render(read(files))).not.toMatch(/✓/);
  });

  it('shows a failed reader as ✗, never as "none"', () => {
    const failed: PythonReqReport = { checked: 4, filesFound: 0, filesNotRead: 0, sdks: [], includes: 0, editables: 0, unreadableLines: 0, rootManifestsNotRead: [], failed: true };
    expect(render(failed)).toBe('✗ Python SDKs: the root requirements*.txt could not be read (the reader failed) — information only, never part of the conclusion');
  });
});

describe('a requirements version that hides text before an @', () => {
  it('is refused, and its text never reaches the report', () => {
    const r = read({ 'requirements.txt': 'openai==1.0\u001b[31mEVIL@1.40.6\n' });
    expect(r.sdks[0]!.resolution).toBeNull();
    expect(render(r)).not.toMatch(/EVIL|\u001b/);
  });
});
