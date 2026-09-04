import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * The App's own identity: a short-lived RS256 JWT signed with the private key
 * GitHub issued at creation. Used only to mint installation tokens.
 */
export async function appJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): Promise<string> {
  const key = createPrivateKey(privateKeyPem);
  const now = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(appId)
    .sign(key);
}
