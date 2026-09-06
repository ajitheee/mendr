import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildManifest,
  canonicalJson,
  normalizePem,
  parseManifest,
  publicKeyBlocksIn,
  publicKeyPemOf,
  registryVersionOf,
  sha256Hex,
  signManifest,
  verifyManifestSignature,
} from './manifest.js';

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const REGISTRY = Buffer.from('[{"entryId":"x"}]', 'utf8');
const COMMIT = 'a'.repeat(40);

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace, so equal values give equal bytes', () => {
    const a = canonicalJson({ b: 1, a: { z: [3, { y: 1, x: 2 }], w: null } });
    const b = canonicalJson({ a: { w: null, z: [3, { x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"w":null,"z":[3,{"x":2,"y":1}]},"b":1}');
  });
});

describe('hashes', () => {
  it('registryVersionOf is sha256: + the first 16 hex of the full digest (the CLI convention)', () => {
    const full = sha256Hex(REGISTRY);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    expect(registryVersionOf(REGISTRY)).toBe(`sha256:${full.slice(0, 16)}`);
  });
});

describe('buildManifest / parseManifest', () => {
  it('round-trips through canonical JSON', () => {
    const m = buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 });
    const parsed = parseManifest(canonicalJson(m));
    expect(parsed).toEqual(m);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.publisher).toBe('registry-publish@github-actions');
  });

  it.each([
    ['not JSON', 'nope', /not JSON/],
    ['an array', '[]', /not an object/],
    ['a future schema', canonicalJson({ ...buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 }), schemaVersion: 2 }), /schemaVersion 2 is not supported/],
    ['a short sha256', canonicalJson({ ...buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 }), sha256: 'abc' }), /sha256/],
    ['a bad commit', canonicalJson({ ...buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 }), sourceCommit: 'main' }), /sourceCommit/],
    ['an unparseable time', canonicalJson({ ...buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 }), publishedAt: 'yesterday' }), /publishedAt/],
    ['a negative count', canonicalJson({ ...buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 }), entryCount: -1 }), /entryCount/],
  ])('rejects %s', (_name, text, re) => {
    expect(() => parseManifest(text)).toThrow(re);
  });
});

describe('sign / verify (Ed25519)', () => {
  it('a signature verifies with the matching public key and with a keyring containing it', () => {
    const { priv, pub } = keypair();
    const other = keypair();
    const bytes = Buffer.from(canonicalJson(buildManifest(REGISTRY, { publishedAt: '2026-09-08T07:12:04Z', sourceCommit: COMMIT, entryCount: 1 })));
    const sig = signManifest(bytes, priv);
    expect(Buffer.from(sig, 'base64').length).toBe(64);
    expect(verifyManifestSignature(bytes, sig, [pub])).toBe(true);
    expect(verifyManifestSignature(bytes, sig, [other.pub, pub])).toBe(true); // any trusted key
  });

  it('fails closed: wrong key, tampered bytes, malformed signature, malformed key, empty keyring', () => {
    const { priv, pub } = keypair();
    const other = keypair();
    const bytes = Buffer.from(canonicalJson({ a: 1 }));
    const sig = signManifest(bytes, priv);
    expect(verifyManifestSignature(bytes, sig, [other.pub])).toBe(false);
    expect(verifyManifestSignature(Buffer.from(canonicalJson({ a: 2 })), sig, [pub])).toBe(false);
    expect(verifyManifestSignature(bytes, 'not-base64!!', [pub])).toBe(false);
    expect(verifyManifestSignature(bytes, sig.slice(0, 20), [pub])).toBe(false);
    expect(verifyManifestSignature(bytes, sig, ['-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----'])).toBe(false);
    expect(verifyManifestSignature(bytes, sig, [])).toBe(false);
  });

  it('a non-Ed25519 key is never a trust anchor, and cannot sign', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPub = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const rsaPriv = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const { priv } = keypair();
    const bytes = Buffer.from(canonicalJson({ a: 1 }));
    expect(verifyManifestSignature(bytes, signManifest(bytes, priv), [rsaPub])).toBe(false);
    expect(() => signManifest(bytes, rsaPriv)).toThrow(/must be ed25519/);
  });

  it('publicKeyPemOf derives the public key the signature verifies with (the publisher self-check)', () => {
    const { priv, pub } = keypair();
    const bytes = Buffer.from(canonicalJson({ a: 1 }));
    const derived = publicKeyPemOf(priv);
    expect(normalizePem(derived)).toBe(normalizePem(pub));
    expect(verifyManifestSignature(bytes, signManifest(bytes, priv), [derived])).toBe(true);
  });
});

describe('publicKeyBlocksIn', () => {
  it('extracts every PUBLIC KEY block from a file, ignoring surrounding text and CRLF', () => {
    const a = keypair().pub;
    const b = keypair().pub;
    const text = `# trusted keys\r\n${a.replace(/\n/g, '\r\n')}\r\n# second\r\n${b}\r\n`;
    const blocks = publicKeyBlocksIn(text);
    expect(blocks).toEqual([normalizePem(a), normalizePem(b)]);
    expect(publicKeyBlocksIn('nothing here')).toEqual([]);
  });
});
