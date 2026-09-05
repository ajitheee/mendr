import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// FIELD-LEVEL ENCRYPTION AT REST for the one sensitive stored field: the audit
// `report` (paths + redacted snippets). This is on top of, not instead of, the
// database provider's own encryption-at-rest — a stolen database dump reveals
// nothing without the data key, which lives in the App environment, not the DB.
//
// AES-256-GCM (authenticated: a tampered ciphertext fails to decrypt rather than
// returning garbage). Keys are a KEYRING so a key can be ROTATED without a
// migration: new writes use the primary key, and old rows still decrypt under
// whichever key sealed them (matched by id). No key configured = plaintext
// storage (development only), and the server warns loudly at boot.

const ALGO = 'aes-256-gcm';

export interface DataKeyring {
  /** Key id used to seal NEW writes. */
  primaryId: string;
  /** All keys available to open existing rows, by id (32-byte AES keys). */
  keys: Map<string, Buffer>;
}

/** The stored envelope for an encrypted field. */
export interface SealedEnvelope {
  /** Marker + version, so a reader can tell an envelope from a raw report. */
  enc: 1;
  keyId: string;
  /** base64( iv[12] | authTag[16] | ciphertext ). */
  data: string;
}

function isSealed(v: unknown): v is SealedEnvelope {
  return !!v && typeof v === 'object' && (v as SealedEnvelope).enc === 1 && typeof (v as SealedEnvelope).data === 'string';
}

/** Decode a 32-byte key given as base64 or hex. */
function decodeKey(raw: string): Buffer {
  const b64 = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 43 ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (b64.length === 32) return b64;
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.alloc(0);
  if (hex.length === 32) return hex;
  throw new Error('MENDR_DATA_KEY entries must be a 32-byte key in base64 or hex');
}

/**
 * Build a keyring from `MENDR_DATA_KEY`. Format: one or more comma-separated
 * `id:key` entries (or a bare `key`, id defaults to `k1`); the FIRST is primary
 * and seals new writes, the rest exist to decrypt older rows during rotation.
 * Returns null when unset (plaintext mode, development only).
 */
export function loadKeyring(raw: string | undefined | null): DataKeyring | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const keys = new Map<string, Buffer>();
  let primaryId = '';
  for (const [i, part] of trimmed.split(',').entries()) {
    const seg = part.trim();
    if (!seg) continue;
    const colon = seg.indexOf(':');
    const id = colon > 0 ? seg.slice(0, colon) : i === 0 ? 'k1' : `k${i + 1}`;
    const keyStr = colon > 0 ? seg.slice(colon + 1) : seg;
    keys.set(id, decodeKey(keyStr));
    if (!primaryId) primaryId = id;
  }
  if (!primaryId) return null;
  return { primaryId, keys };
}

/** Seal a value into an envelope with the keyring's primary key. */
export function seal(value: unknown, keyring: DataKeyring): SealedEnvelope {
  const key = keyring.keys.get(keyring.primaryId);
  if (!key) throw new Error(`data keyring has no primary key ${keyring.primaryId}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: 1, keyId: keyring.primaryId, data: Buffer.concat([iv, tag, ct]).toString('base64') };
}

/** Open an envelope, or return the value unchanged when it is not sealed (plaintext row). */
export function open<T = unknown>(stored: unknown, keyring: DataKeyring | null): T {
  if (!isSealed(stored)) return stored as T;
  if (!keyring) throw new Error('stored data is encrypted but no MENDR_DATA_KEY is configured to open it');
  const key = keyring.keys.get(stored.keyId);
  if (!key) throw new Error(`no data key "${stored.keyId}" available to decrypt this row (was it rotated out?)`);
  const buf = Buffer.from(stored.data, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}

/**
 * Seal the value for storage when a keyring is present; return it unchanged
 * (plaintext) otherwise. What actually goes into the `report` column.
 */
export function sealForStore(value: unknown, keyring: DataKeyring | null): unknown {
  return keyring ? seal(value, keyring) : value;
}
