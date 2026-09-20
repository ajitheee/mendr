// PLANE 2, SLICE 4 — provider SDKs in the ROOT uv.lock.
//
// Slice 3 read the root requirements*.txt. uv.lock is the other file a Python project
// commits that records EXACT installed versions, and slice 3 could only name it as not read.
//
// NO TOML DEPENDENCY: uv writes this file itself, in a narrow and stable shape, so the
// reader recognises exactly that shape and FAILS CLOSED on anything else. A file it cannot
// fully understand is reported as not read, never as "none" — a missed line here would
// otherwise become a confident, wrong "no provider SDK in this repository".
//
// WHAT IT ANSWERS: the version locked for each of the four PyPI provider SDKs the ROOT
// project declares, resolved through the plane-1 resolveSdk. An SDK that is locked but NOT
// declared by the root project (another package pulled it in) is COUNTED and named, never
// resolved and never treated as the team's own dependency — and never as "none" either.
//
// Printed: the SDK's record name, a version parseSdkSpec accepted, integers and fixed
// reasons. Never a URL, hash, marker, path or any other text from the file.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSdkSpec, resolveSdk, type Resolution } from '../registry/graph.js';
import { SDK_PACKAGES, type SdkReleases } from '../registry/sdkReleases.js';

export interface UvSdk {
  name: string;
  /** The locked version, or null when it is not resolved (never printed then). */
  version: string | null;
  resolution: Resolution | null;
  reason: string;
}

export interface UvLockReport {
  /**
   * read        the root uv.lock was read
   * absent      there is no root uv.lock
   * unsupported a lock format version this build does not read
   * failed      the file could not be read, or held a shape this build does not recognise
   */
  state: 'read' | 'absent' | 'unsupported' | 'failed';
  /** How many PyPI SDKs Mendr looks for. */
  checked: number;
  /** SDKs the ROOT project declares, with their locked version. */
  sdks: UvSdk[];
  /** SDKs locked in the file that the root project does not declare (another package pulled them in). */
  lockedNotDeclared: string[];
  /** Workspace members and other local packages in the lock; their own dependencies were not read. */
  localPackagesNotRead: number;
  /** Why the file was not read (states 'failed' and 'unsupported'). */
  note?: string;
}

const PYPI_SDKS = SDK_PACKAGES.filter((p) => p.ecosystem === 'pypi').map((p) => p.name);
const pep503 = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');
const SDK_BY_NAME = new Map(PYPI_SDKS.map((n) => [pep503(n), n]));
const MAX_FILE_BYTES = 16 * 1024 * 1024; // real locks reach a few MB; past this it is not read

/** The lock-format versions this build knows. uv writes `version = 1` with a `revision` under it. */
const SUPPORTED_VERSIONS = new Set([1]);

/** `{ name = "x" }`, optionally with extras, a marker or other keys uv adds. */
const KEY = String.raw`[A-Za-z0-9_-]+`;
const DEP_ENTRY = new RegExp(String.raw`^\{ name = "([^"]+)"(?:, ${KEY} = (?:"[^"]*"|\[[^\]]*\]|\{[^}]*\}))* \},?$`);
/** A key uv writes as a single line inside a package block. */
const SIMPLE_KEY = new RegExp(String.raw`^${KEY} = (?:"[^"]*"|\d+|true|false|\{[^}]*\}|\[[^\]]*\])$`);
/** The start of a multi-line array: `dependencies = [`. */
const ARRAY_START = new RegExp(String.raw`^(${KEY}) = \[$`);
/** `source = { registry = "..." }` and friends: the FIRST key says where the package came from. */
const SOURCE_KIND = new RegExp(String.raw`^source = \{ (${KEY}) = `);

interface Pkg {
  name: string;
  version: string | null;
  sourceKind: string | null;
  sourcePath: string | null;
  deps: string[];
  /** Lines this reader did not recognise inside the block. */
  unknown: number;
}

/**
 * Read the root uv.lock. Returns the SDKs the root project declares with their locked
 * versions, or a state saying why nothing was read. Never throws on file content.
 */
export function readUvLock(repoPath: string, releases: SdkReleases | null, now: Date = new Date()): UvLockReport {
  const base: Omit<UvLockReport, 'state'> = { checked: PYPI_SDKS.length, sdks: [], lockedNotDeclared: [], localPackagesNotRead: 0 };
  const path = join(repoPath, 'uv.lock');
  if (!existsSync(path)) return { state: 'absent', ...base };

  let text: string;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return { state: 'failed', ...base, note: 'larger than this build reads' };
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return { state: 'failed', ...base, note: 'not text' };
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return { state: 'failed', ...base, note: 'could not be read' };
  }

  const lines = text.split(/\r?\n/);
  const packages: Pkg[] = [];
  let pkg: Pkg | null = null;
  /** The table a following `group = [ ... ]` array belongs to, or null outside one. */
  let depTable: 'root-groups' | 'other' | null = null;
  let arrayKey: string | null = null;
  let arrayOwner: Pkg | null = null;
  let arrayCollects = false;
  let inMetadata = false;
  let fileVersion: number | null = null;

  const fail = (note: string): UvLockReport => ({ state: 'failed', ...base, note });

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (arrayKey !== null) {
      if (line === ']') {
        arrayKey = null;
        arrayOwner = null;
        arrayCollects = false;
        continue;
      }
      if (arrayCollects && arrayOwner) {
        const m = DEP_ENTRY.exec(line);
        // A dependency array of the root or of an SDK must be fully understood.
        if (!m) return fail('a dependency entry this build does not recognise');
        arrayOwner.deps.push(m[1]!);
      }
      continue;
    }

    if (line === '[[package]]') {
      pkg = { name: '', version: null, sourceKind: null, sourcePath: null, deps: [], unknown: 0 };
      packages.push(pkg);
      depTable = null;
      inMetadata = false;
      continue;
    }
    if (line.startsWith('[')) {
      // Sub-tables belong to the package above them; `[package.metadata*]` holds the project's
      // INPUT requirements (ranges), not what is locked, so it is skipped deliberately.
      inMetadata = line.startsWith('[package.metadata');
      if (line === '[package.optional-dependencies]' || line === '[package.dev-dependencies]') {
        depTable = pkg && pkg.sourcePath === '.' ? 'root-groups' : 'other';
      } else {
        depTable = null;
        if (line !== '[manifest]' && !inMetadata) pkg = null;
      }
      continue;
    }

    const arr = ARRAY_START.exec(line);
    if (arr) {
      arrayKey = arr[1]!;
      arrayOwner = pkg;
      // Collect only what can change the answer: the root's own dependency groups, and the
      // `dependencies` array of any package (used for nothing else, but must parse cleanly).
      arrayCollects =
        pkg !== null &&
        ((depTable === 'root-groups') || (depTable === null && arrayKey === 'dependencies')) &&
        (pkg.sourcePath === '.' || SDK_BY_NAME.has(pep503(pkg.name)));
      continue;
    }

    if (!pkg) continue; // top-level keys (version, revision, requires-python, ...)
    // `[package.metadata*]` holds the project's INPUT requirements (ranges), which this
    // reader never uses: its shapes must not decide whether the lock can be read.
    if (inMetadata) continue;

    const src = SOURCE_KIND.exec(line);
    if (src) {
      pkg.sourceKind = src[1]!;
      pkg.sourcePath = /^source = \{ [a-z-]+ = "([^"]*)"/.exec(line)?.[1] ?? null;
      continue;
    }
    const kv = new RegExp(String.raw`^(${KEY}) = "([^"]*)"$`).exec(line);
    if (kv?.[1] === 'name') {
      pkg.name = kv[2]!;
      continue;
    }
    if (kv?.[1] === 'version') {
      pkg.version = kv[2]!;
      continue;
    }
    if (!SIMPLE_KEY.test(line)) pkg.unknown++;
  }

  if (arrayKey !== null) return fail('an array that never closes');

  // The header: the first `version = <n>` in the file, before any package.
  const header = /^version = (\d+)$/m.exec(text.slice(0, 4096));
  fileVersion = header ? Number(header[1]) : null;
  if (fileVersion === null) return fail('no lock-format version');
  if (!SUPPORTED_VERSIONS.has(fileVersion)) {
    return { state: 'unsupported', ...base, note: `lock format version ${fileVersion}` };
  }

  const root = packages.find((p) => p.sourcePath === '.' && (p.sourceKind === 'editable' || p.sourceKind === 'virtual'));
  if (!root) return fail('no root project in the lock');
  if (root.unknown > 0) return fail('a line this build does not recognise in the root project');

  const declared = new Set(root.deps.map(pep503));
  const report: UvLockReport = {
    state: 'read',
    ...base,
    localPackagesNotRead: packages.filter((p) => p !== root && (p.sourceKind === 'editable' || p.sourceKind === 'virtual' || p.sourceKind === 'directory')).length,
  };

  for (const sdk of PYPI_SDKS) {
    const locked = packages.find((p) => pep503(p.name) === pep503(sdk));
    if (!locked) continue;
    if (locked.unknown > 0) return fail(`a line this build does not recognise in the ${sdk} package`);
    if (!declared.has(pep503(sdk))) {
      report.lockedNotDeclared.push(sdk);
      continue;
    }
    const refuse = (reason: string): UvSdk => ({ name: sdk, version: null, resolution: null, reason });
    if (locked.sourceKind !== 'registry') {
      report.sdks.push(refuse('locked from git, a directory or a URL, not a registry release — NOT resolved'));
      continue;
    }
    const version = locked.version ?? '';
    // parseSdkSpec splits on the LAST '@', so require the round trip to name this SDK: a
    // version carrying its own '@' would otherwise reach the report as raw file text.
    const spec = version.length <= 256 ? parseSdkSpec(`pypi:${sdk}@${version}`) : null;
    if (!spec || spec.name !== sdk) {
      report.sdks.push(refuse('the lock records no version this build can read — NOT resolved'));
      continue;
    }
    const resolution = resolveSdk(releases, spec, now);
    report.sdks.push({ name: sdk, version, resolution, reason: resolution.reason });
  }

  // Declared by the root but absent from the lock: say so rather than staying silent.
  for (const sdk of PYPI_SDKS) {
    if (declared.has(pep503(sdk)) && !packages.some((p) => pep503(p.name) === pep503(sdk))) {
      report.sdks.push({ name: sdk, version: null, resolution: null, reason: 'declared by the root project, but the lock records no copy — NOT resolved' });
    }
  }
  report.sdks.sort((a, b) => PYPI_SDKS.indexOf(a.name) - PYPI_SDKS.indexOf(b.name));
  return report;
}
