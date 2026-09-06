import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegistryPath } from '../usage/llmRegistry.js';
import { buildManifest, canonicalJson, signManifest } from './manifest.js';
import {
  DEFAULT_MAX_AGE_DAYS,
  MANIFEST_ASSET,
  MAX_ASSET_BYTES,
  REGISTRY_ASSET,
  SIGNATURE_ASSET,
  coverageFieldsOf,
  envFlag,
  loadRegistryWithFreshness,
  type FreshRegistryOptions,
} from './freshRegistry.js';

// Every path through loadRegistryWithFreshness, with the network, the clock,
// the keyring and the bundled stamp all injected — no real network, ever.

const BUNDLED_PATH = resolveRegistryPath();
const BUNDLED_BYTES = readFileSync(BUNDLED_PATH);
const BUNDLED_AT = '2026-09-01T00:00:00Z';
const NOW = new Date('2026-09-06T12:00:00Z');
const COMMIT = 'b'.repeat(40);

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const KEYS = keypair();
const STRANGER = keypair();

interface Snapshot {
  manifestBytes: Buffer;
  sig: string;
  registryBytes: Buffer;
}

function snapshot(over: { publishedAt?: string; priv?: string; registryBytes?: Buffer; manifestPatch?: Record<string, unknown> } = {}): Snapshot {
  const registryBytes = over.registryBytes ?? BUNDLED_BYTES;
  const manifest = {
    ...buildManifest(registryBytes, { publishedAt: over.publishedAt ?? '2026-09-05T07:00:00Z', sourceCommit: COMMIT, entryCount: JSON.parse(registryBytes.toString('utf8')).length }),
    ...(over.manifestPatch ?? {}),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  return { manifestBytes, sig: signManifest(manifestBytes, over.priv ?? KEYS.priv), registryBytes };
}

/** A fetch that serves the given assets by file name; `Error` throws, a number is an HTTP status. */
function fetchFor(assets: Record<string, Uint8Array | string | number | Error>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const a = assets[name];
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return new Response('', { status: a });
    if (a === undefined) return new Response('missing', { status: 404 });
    return new Response(a as BodyInit, { status: 200 });
  }) as typeof fetch;
}

function served(s: Snapshot): Record<string, Uint8Array | string> {
  return { [MANIFEST_ASSET]: s.manifestBytes, [SIGNATURE_ASSET]: s.sig, [REGISTRY_ASSET]: s.registryBytes };
}

const base = (over: Partial<FreshRegistryOptions> = {}): FreshRegistryOptions => ({
  now: NOW,
  env: {},
  trustedKeys: [KEYS.pub],
  bundledPath: BUNDLED_PATH,
  bundledPublishedAt: BUNDLED_AT,
  fetchImpl: fetchFor({}),
  ...over,
});

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('envFlag', () => {
  it('accepts on/1/true/yes case-insensitively and nothing else', () => {
    for (const v of ['on', 'ON', '1', 'true', 'Yes', ' yes ']) expect(envFlag(v)).toBe(true);
    for (const v of [undefined, '', 'off', '0', 'false', 'maybe']) expect(envFlag(v)).toBe(false);
  });
});

describe('default: no refresh requested', () => {
  it('uses the bundled registry, makes NO network call, and grades it by the bundled stamp', async () => {
    const calls: string[] = [];
    const r = await loadRegistryWithFreshness(base({ fetchImpl: fetchFor(served(snapshot()), calls) }));
    expect(calls).toEqual([]);
    expect(r.freshness.source).toBe('bundled');
    expect(r.freshness.state).toBe('fresh'); // 5.5 days old, max 14
    expect(r.freshness.ageDays).toBeCloseTo(5.5, 1);
    expect(r.freshness.publishedAt).toBe(BUNDLED_AT);
    expect(r.freshness.refresh).toEqual({ requested: false, ok: false });
    expect(r.freshness.reason).toBeUndefined();
    expect(r.registry.length).toBeGreaterThan(0);
  });

  it('a bundled registry older than the max age is STALE and says what to do', async () => {
    const r = await loadRegistryWithFreshness(base({ now: new Date('2026-10-01T00:00:00Z') }));
    expect(r.freshness.state).toBe('stale');
    expect(r.freshness.reason).toMatch(/30 days old/);
    expect(r.freshness.reason).toMatch(/MENDR_REGISTRY_REFRESH=on/);
    expect(r.freshness.reason).toMatch(/inconclusive/);
  });

  it('MENDR_REGISTRY_MAX_AGE_DAYS overrides the default', async () => {
    const r = await loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_MAX_AGE_DAYS: '3' } }));
    expect(r.freshness.maxAgeDays).toBe(3);
    expect(r.freshness.state).toBe('stale');
    const d = await loadRegistryWithFreshness(base());
    expect(d.freshness.maxAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
  });
});

describe('refresh requested', () => {
  it('fetches the three assets, verifies, and uses the snapshot (FRESH)', async () => {
    const calls: string[] = [];
    const s = snapshot();
    const r = await loadRegistryWithFreshness(base({ refresh: true, fetchImpl: fetchFor(served(s), calls) }));
    expect(calls.map((u) => u.slice(u.lastIndexOf('/') + 1))).toEqual([MANIFEST_ASSET, SIGNATURE_ASSET, REGISTRY_ASSET]);
    expect(calls[0]!.startsWith('https://github.com/ajitheee/mendr/releases/download/registry-latest/')).toBe(true);
    expect(r.freshness.source).toBe('snapshot');
    expect(r.freshness.state).toBe('fresh');
    expect(r.freshness.publishedAt).toBe('2026-09-05T07:00:00Z');
    expect(r.freshness.sourceCommit).toBe(COMMIT);
    expect(r.freshness.refresh).toEqual({ requested: true, ok: true });
  });

  it('MENDR_REGISTRY_REFRESH=on in the env requests it; MENDR_REGISTRY_URL redirects it', async () => {
    const calls: string[] = [];
    const r = await loadRegistryWithFreshness(
      base({ env: { MENDR_REGISTRY_REFRESH: 'on', MENDR_REGISTRY_URL: 'https://mirror.example/reg' }, fetchImpl: fetchFor(served(snapshot()), calls) }),
    );
    expect(r.freshness.source).toBe('snapshot');
    expect(calls[0]).toBe(`https://mirror.example/reg/${MANIFEST_ASSET}`);
  });

  it('a verified snapshot older than the max age is used but STALE', async () => {
    const r = await loadRegistryWithFreshness(base({ refresh: true, fetchImpl: fetchFor(served(snapshot({ publishedAt: '2026-09-02T00:00:00Z' }))), now: new Date('2026-09-30T00:00:00Z') }));
    expect(r.freshness.source).toBe('snapshot');
    expect(r.freshness.state).toBe('stale');
    expect(r.freshness.reason).toMatch(/publish pipeline may have stopped/);
  });

  it.each<[string, () => Snapshot | Record<string, Uint8Array | string | number | Error>, RegExp]>([
    ['a signature from an untrusted key', () => snapshot({ priv: STRANGER.priv }), /does not verify/],
    ['a tampered registry file', () => ({ ...served(snapshot()), [REGISTRY_ASSET]: Buffer.from('[]') }), /does not match the sha256/],
    ['a manifest edited after signing', () => { const s = snapshot(); return { ...served(s), [MANIFEST_ASSET]: Buffer.from(s.manifestBytes.toString('utf8').replace('2026-09-05', '2026-09-06')) }; }, /does not verify/],
    ['an unsupported schemaVersion (signed)', () => snapshot({ manifestPatch: { schemaVersion: 2 } }), /schemaVersion 2 is not supported/],
    ['a snapshot older than the bundled stamp (rollback)', () => snapshot({ publishedAt: '2026-08-20T00:00:00Z' }), /refusing a rollback/],
    ['a registry that fails entry validation', () => snapshot({ registryBytes: Buffer.from('[{"provider":"openai"}]') }), /llm registry/],
    ['a 404', () => ({ [MANIFEST_ASSET]: 404 }), /manifest\.json: HTTP 404/],
    ['a network error', () => ({ [MANIFEST_ASSET]: new Error('no-network preload: outbound network access is blocked') }), /no-network preload/],
    ['an oversized asset', () => ({ ...served(snapshot()), [REGISTRY_ASSET]: new Uint8Array(MAX_ASSET_BYTES + 1) }), /exceeds the .*-byte cap/],
  ])('falls back to the bundled registry on %s, recording the reason', async (_name, make, re) => {
    const made = make();
    const assets = 'manifestBytes' in made ? served(made as Snapshot) : (made as Record<string, Uint8Array | string | number | Error>);
    const r = await loadRegistryWithFreshness(base({ refresh: true, fetchImpl: fetchFor(assets) }));
    expect(r.freshness.source).toBe('bundled');
    expect(r.freshness.refresh.requested).toBe(true);
    expect(r.freshness.refresh.ok).toBe(false);
    expect(r.freshness.refresh.error).toMatch(re);
    expect(r.freshness.state).toBe('fresh'); // the bundled copy is still within its max age here
    expect(r.registry.length).toBe(JSON.parse(BUNDLED_BYTES.toString('utf8')).length);
  });

  it('when the refresh fails AND the bundled copy is stale, the reason names the failure', async () => {
    const r = await loadRegistryWithFreshness(base({ refresh: true, fetchImpl: fetchFor({ [MANIFEST_ASSET]: 500 }), now: new Date('2026-10-01T00:00:00Z') }));
    expect(r.freshness.state).toBe('stale');
    expect(r.freshness.reason).toMatch(/refresh failed: manifest\.json: HTTP 500/);
  });

  it('makes NO network call when offline (--offline / MENDR_OFFLINE=1), even if requested', async () => {
    const calls: string[] = [];
    const a = await loadRegistryWithFreshness(base({ refresh: true, offline: true, fetchImpl: fetchFor(served(snapshot()), calls) }));
    const b = await loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_REFRESH: '1', MENDR_OFFLINE: '1' }, fetchImpl: fetchFor(served(snapshot()), calls) }));
    expect(calls).toEqual([]);
    for (const r of [a, b]) {
      expect(r.freshness.source).toBe('bundled');
      expect(r.freshness.refresh).toEqual({ requested: true, ok: false, error: expect.stringMatching(/offline/) });
    }
  });

  it('makes NO network call when no key is trusted (an unarmed build)', async () => {
    const calls: string[] = [];
    const r = await loadRegistryWithFreshness(base({ refresh: true, trustedKeys: [], fetchImpl: fetchFor(served(snapshot()), calls) }));
    expect(calls).toEqual([]);
    expect(r.freshness.refresh.error).toMatch(/no trusted registry signing key/);
  });

  it('MENDR_REGISTRY_TRUSTED_KEYS_FILE replaces the keyring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-keys-'));
    created.push(dir);
    const keysFile = join(dir, 'trusted.pem');
    writeFileSync(keysFile, `# mirror keys\n${STRANGER.pub}`);
    const s = snapshot({ priv: STRANGER.priv });
    const r = await loadRegistryWithFreshness({ ...base({ refresh: true, fetchImpl: fetchFor(served(s)) }), trustedKeys: undefined, env: { MENDR_REGISTRY_TRUSTED_KEYS_FILE: keysFile } });
    expect(r.freshness.source).toBe('snapshot');
    expect(r.freshness.refresh.ok).toBe(true);
  });
});

describe('MENDR_REGISTRY_FILE (operator file, never the network)', () => {
  function fileDir(withSidecar: boolean, over: Parameters<typeof snapshot>[0] = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-regfile-'));
    created.push(dir);
    const s = snapshot(over);
    writeFileSync(join(dir, REGISTRY_ASSET), s.registryBytes);
    if (withSidecar) {
      writeFileSync(join(dir, MANIFEST_ASSET), s.manifestBytes);
      writeFileSync(join(dir, SIGNATURE_ASSET), s.sig);
    }
    return dir;
  }

  it('a file with a verified manifest + signature beside it is graded by the manifest and never fetched', async () => {
    const calls: string[] = [];
    const dir = fileDir(true);
    const r = await loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_FILE: join(dir, REGISTRY_ASSET), MENDR_REGISTRY_REFRESH: 'on' }, fetchImpl: fetchFor(served(snapshot()), calls) }));
    expect(calls).toEqual([]);
    expect(r.freshness.source).toBe('file');
    expect(r.freshness.state).toBe('fresh');
    expect(r.freshness.publishedAt).toBe('2026-09-05T07:00:00Z');
    expect(r.freshness.refresh).toEqual({ requested: true, ok: false, error: expect.stringMatching(/MENDR_REGISTRY_FILE is set/) });
  });

  it('an unsigned file is of unknown age → STALE (an operator can prove freshness, not assert it)', async () => {
    const dir = fileDir(false);
    const r = await loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_FILE: join(dir, REGISTRY_ASSET) } }));
    expect(r.freshness.source).toBe('file');
    expect(r.freshness.publishedAt).toBeNull();
    expect(r.freshness.ageDays).toBe(Number.POSITIVE_INFINITY);
    expect(r.freshness.state).toBe('stale');
    expect(r.freshness.reason).toMatch(/unknown age/);
  });

  it('a sidecar signed by an untrusted key is an error, not a silent downgrade', async () => {
    const dir = fileDir(true, { priv: STRANGER.priv });
    await expect(loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_FILE: join(dir, REGISTRY_ASSET) } }))).rejects.toThrow(/does not verify/);
  });
});

describe('coverageFieldsOf', () => {
  it('rounds age to one decimal, maps unknown age to -1, and carries the reason only when present', async () => {
    const fresh = await loadRegistryWithFreshness(base());
    expect(coverageFieldsOf(fresh.freshness)).toEqual({
      source: 'bundled',
      version: expect.stringMatching(/^sha256:[0-9a-f]{16}$/),
      publishedAt: BUNDLED_AT,
      ageDays: 5.5,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      freshness: 'fresh',
      refresh: { requested: false, ok: false },
    });
    const dir = mkdtempSync(join(tmpdir(), 'mendr-regfile-'));
    created.push(dir);
    writeFileSync(join(dir, REGISTRY_ASSET), BUNDLED_BYTES);
    const unsigned = await loadRegistryWithFreshness(base({ env: { MENDR_REGISTRY_FILE: join(dir, REGISTRY_ASSET) } }));
    const f = coverageFieldsOf(unsigned.freshness);
    expect(f.ageDays).toBe(-1);
    expect(f.freshness).toBe('stale');
    expect(f.reason).toMatch(/unknown age/);
  });
});
