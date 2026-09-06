// Registry snapshot manifest — the SIGNED envelope around a registry file.
//
// The registry file itself (registries/llm-deprecations.json) stays a bare JSON
// array, byte-identical to `main`, so the loader's parsing and the CLI's
// content-hash `registryVersion` convention are untouched. Everything a scanner
// needs to trust and date that file rides in a sidecar manifest:
//
//   manifest.json   canonical JSON (sorted keys, no whitespace) — the exact bytes
//                   that get signed; the scanner verifies the FILE BYTES and only
//                   then parses them, never a re-serialization.
//   manifest.sig    an Ed25519 signature over those bytes, base64.
//
// Ed25519 via Node's own crypto: no new dependency, 64-byte signatures, and a
// key the pinned scanner already carries (src/registry/trustedKeys.ts). The
// registry drives the replacement ids `mendr migrate --write` proposes in pull
// requests, so an UNSIGNED refresh channel would let a compromised host or
// mirror put a wrong replacement into a PR a human might merge. The signature is
// what keeps a data channel from becoming a supply-chain hole.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface RegistryManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /** `sha256:` + first 16 hex — the CLI's existing registryVersion convention. */
  registryVersion: string;
  /** Full 64-hex sha256 of the registry file's bytes; binds the file to this manifest. */
  sha256: string;
  /** ISO-8601 UTC. What the scanner grades AGE from. */
  publishedAt: string;
  /** The `main` commit the registry was published from (40 hex). */
  sourceCommit: string;
  entryCount: number;
  publisher: string;
}

/** Ed25519 signatures are exactly 64 bytes; anything else is not one. */
const ED25519_SIGNATURE_BYTES = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const VERSION_RE = /^sha256:[0-9a-f]{16}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `sha256:` + the first 16 hex chars — the same value the CLI already reports as registryVersion. */
export function registryVersionOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes).slice(0, 16)}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return v;
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. The same
 * value always yields the same bytes, so the same manifest always yields the
 * same signature — and a reviewer can rebuild and compare it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function buildManifest(
  registryBytes: Uint8Array,
  opts: { publishedAt: string; sourceCommit: string; entryCount: number; publisher?: string },
): RegistryManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    registryVersion: registryVersionOf(registryBytes),
    sha256: sha256Hex(registryBytes),
    publishedAt: opts.publishedAt,
    sourceCommit: opts.sourceCommit,
    entryCount: opts.entryCount,
    publisher: opts.publisher ?? 'registry-publish@github-actions',
  };
}

/** Parse a manifest and reject anything not exactly the shape this scanner understands. */
export function parseManifest(text: string): RegistryManifest {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('registry manifest is not JSON');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('registry manifest is not an object');
  const m = v as Record<string, unknown>;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `registry manifest schemaVersion ${JSON.stringify(m.schemaVersion)} is not supported by this scanner (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }
  const str = (k: string): string => {
    if (typeof m[k] !== 'string' || (m[k] as string).length === 0) throw new Error(`registry manifest has a missing/invalid "${k}"`);
    return m[k] as string;
  };
  const registryVersion = str('registryVersion');
  const sha256 = str('sha256');
  const publishedAt = str('publishedAt');
  const sourceCommit = str('sourceCommit');
  const publisher = str('publisher');
  if (!VERSION_RE.test(registryVersion)) throw new Error('registry manifest "registryVersion" is not sha256:<16 hex>');
  if (!HEX64.test(sha256)) throw new Error('registry manifest "sha256" is not 64 hex chars');
  if (!HEX40.test(sourceCommit)) throw new Error('registry manifest "sourceCommit" is not a 40-hex commit');
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error('registry manifest "publishedAt" is not a parseable timestamp');
  if (!Number.isInteger(m.entryCount) || (m.entryCount as number) < 0) throw new Error('registry manifest "entryCount" is not a non-negative integer');
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, registryVersion, sha256, publishedAt, sourceCommit, entryCount: m.entryCount as number, publisher };
}

/** Sign the exact manifest bytes with an Ed25519 private key (PEM). Returns base64. */
export function signManifest(manifestBytes: Uint8Array, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`registry signing key must be ed25519, got ${key.asymmetricKeyType ?? 'unknown'}`);
  return cryptoSign(null, manifestBytes, key).toString('base64');
}

/**
 * True if ANY trusted Ed25519 public key (PEM) verifies the signature over the
 * exact manifest bytes. A malformed key or a non-Ed25519 key is skipped, never
 * an error path that could be mistaken for success.
 */
export function verifyManifestSignature(manifestBytes: Uint8Array, signatureB64: string, trustedPublicKeysPem: readonly string[]): boolean {
  const sig = Buffer.from(signatureB64.trim(), 'base64');
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  for (const pem of trustedPublicKeysPem) {
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') continue;
      if (cryptoVerify(null, manifestBytes, key, sig)) return true;
    } catch {
      // malformed PEM: not a trust anchor, skip
    }
  }
  return false;
}

/** Derive the SPKI public-key PEM from an Ed25519 private key PEM (for the publisher's self-check). */
export function publicKeyPemOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }) as string;
}

/** Normalize a PEM for comparison: CRLF → LF, trimmed. */
export function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, '\n').trim();
}

/** Every `-----BEGIN PUBLIC KEY-----…-----END PUBLIC KEY-----` block in a text, in order. */
export function publicKeyBlocksIn(text: string): string[] {
  return (text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []).map(normalizePem);
}
