// PLANE 2, SLICE 1 — the "IaC and lockfiles" node.
//
// Plane 1 recorded what each first-party SDK has shipped (sdk-releases.json) and can walk a
// NAMED version forward through it (resolveSdk). What it could not do was look at a
// customer's repository: "comparing a pinned version against this is plane 2". This reads
// the one file that records the exact version `npm ci` installs — the ROOT package-lock.json
// — and resolves every provider SDK the root project declares.
//
// WHAT IT IS: information for a human reading `mendr audit`. It never reaches the audit's
// conclusion, exit code, --json report, GitHub issue or migration PR. A newer SDK major is
// not a retirement, and turning version lag into an alarm weeks before a real retirement
// date would push teams into an unreviewed major upgrade.
//
// WHAT IT READS, AND WHAT IT ONLY NAMES:
//   * reads the root package-lock.json (lockfileVersion 2 or 3), and in it only the root
//     project's declared dependency NAMES plus the locked copy of each declared SDK,
//     including one declared under an npm alias ("openai-v3": "npm:openai@3");
//   * resolves a copy only when it came from a registry: a git fork, a tarball or a local
//     directory carries a registry-looking version but is refused;
//   * names, without opening, every other lockfile in the repository (nested
//     package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, uv.lock, poetry.lock, ...)
//     and every local package (workspace or linked directory) in the root lockfile, so a
//     monorepo whose SDKs live in a workspace is told "not read", never "none";
//   * never prints a dependency spec, a `resolved` URL or an integrity hash — a spec or a
//     URL can carry a registry token.
//
// SDK names are compared as published, never through canonicalizeId (see graph.ts).

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CONFIG_EXCLUDED_DIRS } from '../config/scanConfig.js';
import { parseSdkSpec, resolveSdk, type Resolution } from '../registry/graph.js';
import { SDK_PACKAGES, type SdkReleases } from '../registry/sdkReleases.js';

export interface LockedSdk {
  /** The SDK, as the release record names it. */
  name: string;
  /** The dependency name it is declared under, when that is an npm alias for the SDK. */
  alias?: string;
  /** The locked version, or null when it is not a registry release (never printed then). */
  version: string | null;
  /** resolveSdk's answer, or null when the lockfile gives no registry version to resolve. */
  resolution: Resolution | null;
  /** resolveSdk's reason verbatim, or the fixed reason it was not resolved. */
  reason: string;
}

export interface LockedSdkReport {
  /**
   * read        the root package-lock.json was read
   * absent      there is no root package-lock.json
   * shrinkwrap  npm-shrinkwrap.json takes precedence over package-lock.json and is not read
   * unsupported lockfileVersion 1, which records no `packages` map
   * failed      the root package-lock.json could not be read
   */
  state: 'read' | 'absent' | 'shrinkwrap' | 'unsupported' | 'failed';
  /** How many npm SDKs the release record covers — the denominator behind "none declared". */
  checked: number;
  /** First-party provider SDKs the ROOT project declares, in SDK_PACKAGES order. */
  sdks: LockedSdk[];
  /** Local packages (workspaces, linked directories) in the root lockfile; their dependencies were not read. */
  localPackagesNotRead: number;
  /** Lockfiles found elsewhere in the repository and not opened: display name -> count. */
  otherLockfiles: Record<string, number>;
  /** Why the root lockfile could not be read (state 'failed' only). */
  note?: string;
}

/** The npm SDKs the release record covers — the denominator behind a "none declared". */
export const NPM_SDKS: readonly string[] = SDK_PACKAGES.filter((p) => p.ecosystem === 'npm').map((p) => p.name);
const DECLARING_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Lockfile names this slice finds but does not open. requirements*.txt is matched by pattern. */
const OTHER_LOCKFILE_NAMES = new Set([
  'package-lock.json', // only when NOT at the root
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
]);
const isRequirementsFile = (name: string): boolean => /^requirements.*\.txt$/i.test(name);

/** Every lockfile below the root, skipping exactly the directories the config scan skips. */
function findOtherLockfiles(repoPath: string): Record<string, number> {
  const found: Record<string, number> = {};
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CONFIG_EXCLUDED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const atRoot = relative(repoPath, full).split(sep).length === 1;
      // The root package-lock.json is READ, and a root npm-shrinkwrap.json sets the state;
      // neither is "another" lockfile.
      if (atRoot && (entry.name === 'package-lock.json' || entry.name === 'npm-shrinkwrap.json')) continue;
      if (OTHER_LOCKFILE_NAMES.has(entry.name)) {
        const key = entry.name === 'package-lock.json' ? 'package-lock.json in subdirectories' : entry.name;
        found[key] = (found[key] ?? 0) + 1;
      } else if (isRequirementsFile(entry.name)) {
        found['requirements*.txt'] = (found['requirements*.txt'] ?? 0) + 1;
      }
    }
  };
  walk(repoPath);
  return found;
}

type LockEntry = { version?: unknown; name?: unknown; link?: unknown; resolved?: unknown } & Partial<
  Record<(typeof DECLARING_MAPS)[number], Record<string, unknown>>
>;

/**
 * Did this copy come from a package registry? In lockfile v2/v3 `version` is the installed
 * package.json's own version even for a git fork, a tarball or a linked directory, so the
 * version cannot tell. `resolved` can: a registry install resolves to
 * `<registry>/<name>/-/<basename>-<version>.tgz`. An ABSENT `resolved` is still a registry
 * install (npm omits it under omit-lockfile-registry-resolved). `resolved` is only tested,
 * never printed: it can carry a registry token.
 */
function fromRegistry(sdk: string, version: string, resolved: unknown): boolean {
  if (resolved === undefined) return true;
  if (typeof resolved !== 'string' || !/^https?:\/\//i.test(resolved)) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(resolved).pathname);
  } catch {
    return false;
  }
  const basename = sdk.slice(sdk.lastIndexOf('/') + 1);
  return path.endsWith(`/-/${basename}-${version}.tgz`);
}

/** An npm package name, safe to print (npm caps names at 214). Anything else is described, not echoed. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const printableName = (key: string): boolean => key.length <= 214 && NPM_NAME.test(key);

/** A lock records an EXACT version. A range here ("1.*.*") is not a lock and is not printed as one. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Read the root lockfile and resolve each declared provider SDK against the release record. */
export function readLockedSdks(repoPath: string, releases: SdkReleases | null, now: Date = new Date()): LockedSdkReport {
  const otherLockfiles = findOtherLockfiles(repoPath);
  const empty = { checked: NPM_SDKS.length, sdks: [], localPackagesNotRead: 0, otherLockfiles };

  if (existsSync(join(repoPath, 'npm-shrinkwrap.json'))) return { state: 'shrinkwrap', ...empty };
  const lockPath = join(repoPath, 'package-lock.json');
  if (!existsSync(lockPath)) return { state: 'absent', ...empty };

  let lock: { lockfileVersion?: unknown; packages?: unknown };
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return { state: 'failed', ...empty, note: 'not valid JSON' };
  }
  if (typeof lock !== 'object' || lock === null) return { state: 'failed', ...empty, note: 'not a JSON object' };
  const packages = lock.packages;
  if (typeof packages !== 'object' || packages === null) {
    return lock.lockfileVersion === 1
      ? { state: 'unsupported', ...empty }
      : { state: 'failed', ...empty, note: 'no "packages" map' };
  }
  const pkgs = packages as Record<string, LockEntry>;
  const root = pkgs[''] ?? {};

  // A key with no node_modules segment is a local package: a workspace, or the target of a
  // linked directory. Its own dependencies are not read.
  const localPackagesNotRead = Object.keys(pkgs).filter(
    (k) => k !== '' && !k.split('/').includes('node_modules'),
  ).length;

  const declared = new Set<string>();
  for (const map of DECLARING_MAPS) {
    const deps = root[map];
    if (deps && typeof deps === 'object') for (const key of Object.keys(deps)) declared.add(key);
  }

  const sdks: LockedSdk[] = [];
  for (const key of declared) {
    const entry = pkgs[`node_modules/${key}`];
    const lockedName = entry && typeof entry.name === 'string' ? entry.name : key;
    const keyIsSdk = NPM_SDKS.includes(key);
    // An npm alias ("openai-v3": "npm:openai@3") locks an SDK under ANOTHER name; the lock
    // entry's `name` says which. Missing it would print a false "declares none".
    const aliasOfSdk = !keyIsSdk && NPM_SDKS.includes(lockedName);
    if (!keyIsSdk && !aliasOfSdk) continue;

    const name = keyIsSdk ? key : lockedName;
    const alias = aliasOfSdk ? (printableName(key) ? key : 'another name') : undefined;
    const refuse = (reason: string): LockedSdk => ({ name, alias, version: null, resolution: null, reason });
    if (!entry) {
      sdks.push(refuse('declared, but the lockfile records no installed copy — NOT resolved'));
      continue;
    }
    if (entry.link === true) {
      sdks.push(refuse('a linked local package, not a registry release — NOT resolved'));
      continue;
    }
    // The reverse: "openai": "npm:other@1" locks a DIFFERENT package under the SDK's name.
    if (keyIsSdk && lockedName !== key) {
      sdks.push(refuse('an alias for another package, not ' + key + ' itself — NOT resolved'));
      continue;
    }
    const version = typeof entry.version === 'string' ? entry.version.trim() : '';
    // 256 is npm semver's own MAX_LENGTH. Checked FIRST: a longer string is not a version, and
    // bounding it keeps every regex that runs over it — the grammar here, and the redaction
    // before the Action's upload — bounded too.
    const spec = version.length <= 256 && EXACT_VERSION.test(version) ? parseSdkSpec(`npm:${name}@${version}`) : null;
    if (!spec) {
      sdks.push(refuse('the lockfile records no exact version — NOT resolved'));
      continue;
    }
    if (!fromRegistry(name, version, entry.resolved)) {
      sdks.push(refuse('installed from git, a tarball or a local directory, not a registry release — NOT resolved'));
      continue;
    }
    const resolution = resolveSdk(releases, spec, now);
    sdks.push({ name, alias, version, resolution, reason: resolution.reason });
  }
  sdks.sort((a, b) => NPM_SDKS.indexOf(a.name) - NPM_SDKS.indexOf(b.name) || (a.alias ?? '').localeCompare(b.alias ?? ''));

  return { state: 'read', checked: NPM_SDKS.length, sdks, localPackagesNotRead, otherLockfiles };
}
