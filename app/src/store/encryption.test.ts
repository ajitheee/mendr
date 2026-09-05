import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadKeyring, open, seal, sealForStore } from './encryption.js';

const keyB64 = (): string => randomBytes(32).toString('base64');

describe('loadKeyring', () => {
  it('returns null when unset (plaintext mode)', () => {
    expect(loadKeyring(undefined)).toBeNull();
    expect(loadKeyring('')).toBeNull();
    expect(loadKeyring('   ')).toBeNull();
  });

  it('accepts a bare base64/hex key (id defaults to k1) and an id:key form', () => {
    const bare = loadKeyring(keyB64())!;
    expect(bare.primaryId).toBe('k1');
    expect(bare.keys.has('k1')).toBe(true);
    const named = loadKeyring(`main:${keyB64()}`)!;
    expect(named.primaryId).toBe('main');
    expect(loadKeyring(randomBytes(32).toString('hex'))!.keys.get('k1')).toHaveLength(32);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadKeyring('too-short')).toThrow();
    expect(() => loadKeyring(randomBytes(16).toString('base64'))).toThrow();
  });

  it('supports a rotation keyring: first is primary, all can decrypt', () => {
    const ring = loadKeyring(`k2:${keyB64()},k1:${keyB64()}`)!;
    expect(ring.primaryId).toBe('k2');
    expect([...ring.keys.keys()].sort()).toEqual(['k1', 'k2']);
  });
});

describe('seal / open', () => {
  it('round-trips a value and never stores it in the clear', () => {
    const ring = loadKeyring(keyB64())!;
    const report = { schema: 'mendr-audit/v3', secretPath: 'src/very/private/thing.ts', snippet: 'const k = "gpt-4"' };
    const env = seal(report, ring);
    expect(env.enc).toBe(1);
    expect(env.keyId).toBe('k1');
    // the ciphertext contains none of the plaintext
    expect(env.data).not.toContain('private');
    expect(env.data).not.toContain('gpt-4');
    expect(open(env, ring)).toEqual(report);
  });

  it('is authenticated: a tampered ciphertext fails, never returns garbage', () => {
    const ring = loadKeyring(keyB64())!;
    const env = seal({ a: 1 }, ring);
    const bytes = Buffer.from(env.data, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => open({ ...env, data: bytes.toString('base64') }, ring)).toThrow();
  });

  it('decrypts a row sealed under an OLD key after rotation', () => {
    const oldRing = loadKeyring(`k1:${keyB64()}`)!;
    const env = seal({ finding: 'gpt-4' }, oldRing);
    // rotate: new primary k2, but k1 kept for old rows
    const rotated = loadKeyring(`k2:${keyB64()},k1:${oldRing.keys.get('k1')!.toString('base64')}`)!;
    expect(open(env, rotated)).toEqual({ finding: 'gpt-4' });
    // a NEW seal uses the new primary
    expect(seal({ x: 1 }, rotated).keyId).toBe('k2');
  });

  it('open() passes through a plaintext (unsealed) value, and refuses a sealed one with no keyring', () => {
    const plain = { schema: 'mendr-audit/v3' };
    expect(open(plain, null)).toEqual(plain);
    expect(open(plain, loadKeyring(keyB64()))).toEqual(plain);
    const env = seal({ a: 1 }, loadKeyring(keyB64())!);
    expect(() => open(env, null)).toThrow(/no MENDR_DATA_KEY/);
  });

  it('sealForStore encrypts with a keyring and stores plaintext without one', () => {
    const ring = loadKeyring(keyB64())!;
    expect((sealForStore({ a: 1 }, ring) as { enc?: number }).enc).toBe(1);
    expect(sealForStore({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
