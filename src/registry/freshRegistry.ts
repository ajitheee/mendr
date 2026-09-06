// Registry freshness — pin the CODE, refresh the DATA, and never let stale
// knowledge pass as proof of absence.
//
// The scanner is pinned to an immutable ref (MENDR_SPEC) and ships a registry
// inside that ref. Left alone, a pinned scanner re-scans forever with the
// knowledge of the day the tag was cut: a retirement announced afterwards is
// invisible to it. This module lets it use a NEWER registry — but only one
// signed by a key it already trusts — and grades whichever registry ends up in
// use by AGE, so the conclusion gate can refuse "no exposure" on out-of-date
// knowledge (concludeAudit in src/audit/investigation.ts).
//
// OFFLINE BY DEFAULT. The default audit makes no network call — a tested claim
// (src/audit/noNetwork.test.ts). The refresh is an explicit opt-in,
// MENDR_REGISTRY_REFRESH=on (or --refresh-registry): ONE outbound GET of three
// public, signed files from github.com, sending nothing about the customer.
// The generated CI workflows turn it on visibly in the YAML the customer
// commits; --offline / MENDR_OFFLINE=1 always wins and turns it off.
//
// Precedence: an operator file (MENDR_REGISTRY_FILE) → the signed snapshot
// (when refresh is on and verifies) → the bundled registry. Every path ends in
// the same age grade, and nothing downloaded is ever executed: it is JSON that
// passes the exact validation the bundled file passes, entry by entry.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { parseLlmRegistryText, resolveRegistryPath } from '../usage/llmRegistry.js';
import { BUNDLED_PUBLISHED_AT } from './bundledStamp.js';
import { parseManifest, publicKeyBlocksIn, registryVersionOf, sha256Hex, verifyManifestSignature, type RegistryManifest } from './manifest.js';
import { TRUSTED_REGISTRY_KEYS } from './trustedKeys.js';

/** The rolling release the publish workflow uploads to. Overridable via MENDR_REGISTRY_URL (mirrors). */
export const DEFAULT_REGISTRY_URL = 'https://github.com/ajitheee/mendr/releases/download/registry-latest/';
/** A registry older than this is STALE: silence against it proves nothing. Overridable via MENDR_REGISTRY_MAX_AGE_DAYS. */
export const DEFAULT_MAX_AGE_DAYS = 14;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const REGISTRY_ASSET = 'llm-deprecations.json';
export const MANIFEST_ASSET = 'manifest.json';
export const SIGNATURE_ASSET = 'manifest.sig';

export type RegistryFreshnessState = 'fresh' | 'stale';
export type RegistrySource = 'snapshot' | 'file' | 'bundled';

export interface RegistryRefreshOutcome {
  /** Was a refresh asked for (MENDR_REGISTRY_REFRESH / --refresh-registry)? */
  requested: boolean;
  /** Did a signed snapshot verify and get used? */
  ok: boolean;
  /** Why not, in plain words. Present whenever requested && !ok. */
  error?: string;
}

export interface RegistryFreshness {
  source: RegistrySource;
  /** Content hash of the registry actually used (`sha256:` + 16 hex). */
  version: string;
  /** Signed manifest time (snapshot/file) or the bundled stamp. null = unknown (an unsigned operator file). */
  publishedAt: string | null;
  /** Age in days at `now`; Infinity when unknown. */
  ageDays: number;
  maxAgeDays: number;
  state: RegistryFreshnessState;
  sourceCommit?: string;
  refresh: RegistryRefreshOutcome;
  /** One plain-words line explaining a non-fresh grade and what to do. */
  reason?: string;
}

export interface FreshRegistryOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to trustedKeys.ts or MENDR_REGISTRY_TRUSTED_KEYS_FILE. */
  trustedKeys?: readonly string[];
  bundledPath?: string;
  bundledPublishedAt?: string;
  maxAgeDays?: number;
  /** --offline: forces the refresh off regardless of env. */
  offline?: boolean;
  /** --refresh-registry: requests the refresh regardless of env. */
  refresh?: boolean;
}

/** on / 1 / true / yes, case-insensitive. */
export function envFlag(v: string | undefined): boolean {
  return /^(on|1|true|yes)$/i.test((v ?? '').trim());
}

/** Whole days, at least 1 — a max age of 0 would make every registry stale, so it falls back to the default. */
function positiveInt(v: string | undefined): number | undefined {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function trustedKeysFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const file = env.MENDR_REGISTRY_TRUSTED_KEYS_FILE?.trim();
  if (!file) return TRUSTED_REGISTRY_KEYS;
  return publicKeyBlocksIn(readFileSync(file, 'utf8'));
}

/**
 * Verify a snapshot's three parts against the trusted keys and the rollback
 * floor, then parse the registry through the SAME validation as the bundled
 * file. Throws with the reason on any failure; every check is fail-closed.
 */
export function verifySnapshot(input: {
  manifestBytes: Uint8Array;
  signature: string;
  registryBytes: Uint8Array;
  trustedKeys: readonly string[];
  bundledPublishedAt: string;
  label: string;
}): { manifest: RegistryManifest; registry: LlmRegistry } {
  if (!verifyManifestSignature(input.manifestBytes, input.signature, input.trustedKeys)) {
    throw new Error('manifest signature does not verify against any trusted registry key');
  }
  const manifest = parseManifest(Buffer.from(input.manifestBytes).toString('utf8'));
  const digest = sha256Hex(input.registryBytes);
  if (digest !== manifest.sha256) throw new Error('registry file does not match the sha256 in its signed manifest');
  const floor = Date.parse(input.bundledPublishedAt);
  if (!Number.isNaN(floor) && Date.parse(manifest.publishedAt) < floor) {
    throw new Error(
      `snapshot published ${manifest.publishedAt} is older than this scanner's bundled registry (${input.bundledPublishedAt}) — refusing a rollback`,
    );
  }
  const registry = parseLlmRegistryText(Buffer.from(input.registryBytes).toString('utf8'), input.label);
  return { manifest, registry };
}

async function getBytes(fetchImpl: typeof fetch, url: string, asset: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    throw new Error(`${asset}: ${message(e)}`);
  }
  if (!res.ok) throw new Error(`${asset}: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) throw new Error(`${asset}: ${declared} bytes exceeds the ${MAX_ASSET_BYTES}-byte cap`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`${asset}: ${bytes.byteLength} bytes exceeds the ${MAX_ASSET_BYTES}-byte cap`);
  return bytes;
}

function grade(
  base: Omit<RegistryFreshness, 'ageDays' | 'state' | 'reason' | 'maxAgeDays'>,
  now: Date,
  maxAgeDays: number,
): RegistryFreshness {
  const t = base.publishedAt === null ? Number.NaN : Date.parse(base.publishedAt);
  const ageDays = Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, (now.getTime() - t) / 86_400_000);
  const state: RegistryFreshnessState = ageDays <= maxAgeDays ? 'fresh' : 'stale';
  const out: RegistryFreshness = { ...base, ageDays, maxAgeDays, state };
  if (state === 'fresh') return out;
  const days = Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'of unknown age';
  if (base.source === 'file') {
    out.reason = `the registry file is ${days} (max ${maxAgeDays}) — freshness cannot be proven, so "no exposure" is inconclusive`;
  } else if (base.source === 'snapshot') {
    out.reason = `the signed registry snapshot is ${days} (max ${maxAgeDays}) — the registry publish pipeline may have stopped; "no exposure" is inconclusive`;
  } else if (base.refresh.requested) {
    out.reason = `the bundled registry is ${days} (max ${maxAgeDays}) and the refresh failed: ${base.refresh.error ?? 'unknown error'} — "no exposure" is inconclusive`;
  } else {
    out.reason =
      `the bundled registry is ${days} (max ${maxAgeDays}) — set MENDR_REGISTRY_REFRESH=on (one signed GET to github.com) or bump MENDR_SPEC; ` +
      `until then "no exposure" is inconclusive`;
  }
  return out;
}

/** Fields for AuditCoverage.registry (structurally typed; keeps this module free of audit imports). */
export function coverageFieldsOf(f: RegistryFreshness): {
  source: RegistrySource;
  version: string;
  publishedAt: string | null;
  ageDays: number;
  maxAgeDays: number;
  freshness: RegistryFreshnessState;
  reason?: string;
  refresh: RegistryRefreshOutcome;
} {
  const ageDays = Number.isFinite(f.ageDays) ? Math.round(f.ageDays * 10) / 10 : -1;
  return {
    source: f.source,
    version: f.version,
    publishedAt: f.publishedAt,
    ageDays,
    maxAgeDays: f.maxAgeDays,
    freshness: f.state,
    ...(f.reason ? { reason: f.reason } : {}),
    refresh: f.refresh,
  };
}

/**
 * Load the registry the audit should use and grade its freshness.
 *
 *   1. MENDR_REGISTRY_FILE — an operator's own file, no network. Graded by the
 *      signed manifest.json + manifest.sig beside it if present; unsigned = age
 *      unknown = stale (an operator can prove freshness, not assert it).
 *   2. Refresh — only when requested, not offline, and there is a key to trust:
 *      fetch, verify, rollback-check, validate, use.
 *   3. Bundled — always available, graded by its release stamp.
 */
export async function loadRegistryWithFreshness(opts: FreshRegistryOptions = {}): Promise<{ registry: LlmRegistry; freshness: RegistryFreshness }> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? positiveInt(env.MENDR_REGISTRY_MAX_AGE_DAYS) ?? DEFAULT_MAX_AGE_DAYS;
  const offline = opts.offline ?? envFlag(env.MENDR_OFFLINE);
  const requested = opts.refresh ?? envFlag(env.MENDR_REGISTRY_REFRESH);
  const trustedKeys = opts.trustedKeys ?? trustedKeysFromEnv(env);
  const bundledPublishedAt = opts.bundledPublishedAt ?? BUNDLED_PUBLISHED_AT;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  // 1. An operator-provided file wins outright: no network, whatever else is set.
  const explicit = env.MENDR_REGISTRY_FILE?.trim();
  if (explicit) {
    const registryBytes = readFileSync(explicit);
    const dir = dirname(explicit);
    const manifestPath = join(dir, MANIFEST_ASSET);
    const sigPath = join(dir, SIGNATURE_ASSET);
    const refresh: RegistryRefreshOutcome = requested
      ? { requested: true, ok: false, error: 'MENDR_REGISTRY_FILE is set, so no refresh was attempted' }
      : { requested: false, ok: false };
    if (existsSync(manifestPath) && existsSync(sigPath)) {
      const { manifest, registry } = verifySnapshot({
        manifestBytes: readFileSync(manifestPath),
        signature: readFileSync(sigPath, 'utf8'),
        registryBytes,
        trustedKeys,
        bundledPublishedAt,
        label: `at ${explicit}`,
      });
      return {
        registry,
        freshness: grade({ source: 'file', version: manifest.registryVersion, publishedAt: manifest.publishedAt, sourceCommit: manifest.sourceCommit, refresh }, now, maxAgeDays),
      };
    }
    const registry = parseLlmRegistryText(registryBytes.toString('utf8'), `at ${explicit}`);
    return { registry, freshness: grade({ source: 'file', version: registryVersionOf(registryBytes), publishedAt: null, refresh }, now, maxAgeDays) };
  }

  // 2. The opt-in refresh.
  const refresh: RegistryRefreshOutcome = { requested, ok: false };
  if (requested) {
    if (offline) {
      refresh.error = 'offline (--offline / MENDR_OFFLINE=1) — no network call was made';
    } else if (trustedKeys.length === 0) {
      refresh.error = 'no trusted registry signing key is configured in this build — no network call was made';
    } else {
      const base = (env.MENDR_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL).replace(/\/*$/, '/');
      try {
        const manifestBytes = await getBytes(fetchImpl, base + MANIFEST_ASSET, MANIFEST_ASSET);
        const sigBytes = await getBytes(fetchImpl, base + SIGNATURE_ASSET, SIGNATURE_ASSET);
        const registryBytes = await getBytes(fetchImpl, base + REGISTRY_ASSET, REGISTRY_ASSET);
        const { manifest, registry } = verifySnapshot({
          manifestBytes,
          signature: Buffer.from(sigBytes).toString('utf8'),
          registryBytes,
          trustedKeys,
          bundledPublishedAt,
          label: `from ${base}`,
        });
        refresh.ok = true;
        return {
          registry,
          freshness: grade(
            { source: 'snapshot', version: manifest.registryVersion, publishedAt: manifest.publishedAt, sourceCommit: manifest.sourceCommit, refresh },
            now,
            maxAgeDays,
          ),
        };
      } catch (e) {
        refresh.error = message(e);
      }
    }
  }

  // 3. The bundled registry — always there, graded by its release stamp.
  const bundledPath = opts.bundledPath ?? resolveRegistryPath();
  const bundledBytes = readFileSync(bundledPath);
  const registry = parseLlmRegistryText(bundledBytes.toString('utf8'), `at ${bundledPath}`);
  return {
    registry,
    freshness: grade({ source: 'bundled', version: registryVersionOf(bundledBytes), publishedAt: bundledPublishedAt, refresh }, now, maxAgeDays),
  };
}
