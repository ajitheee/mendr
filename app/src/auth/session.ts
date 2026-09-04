import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';

// The user's GitHub token is held ONLY inside this encrypted, HttpOnly cookie.
// The server keeps no session table and no user tokens at rest: a database
// dump contains installations, repositories and evidence, never a credential.

export const SESSION_COOKIE = 'mendr_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface Session {
  userId: number;
  login: string;
  token: string;
  /** Unix seconds. */
  exp: number;
}

function key(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(secret).digest());
}

export async function sealSession(s: Session, secret: string): Promise<string> {
  return new EncryptJWT({ uid: s.userId, login: s.login, tok: s.token })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(s.exp)
    .encrypt(key(secret));
}

export async function openSession(cookie: string, secret: string): Promise<Session | null> {
  try {
    const { payload } = await jwtDecrypt(cookie, key(secret));
    if (typeof payload.uid !== 'number' || typeof payload.login !== 'string' || typeof payload.tok !== 'string' || typeof payload.exp !== 'number') return null;
    return { userId: payload.uid, login: payload.login, token: payload.tok, exp: payload.exp };
  } catch {
    return null;
  }
}
