import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimsFrom, createActionsVerifier } from './oidc.js';

const ISSUER = 'https://token.actions.githubusercontent.com';

let sign: (claims: JWTPayload, opts?: { issuer?: string; audience?: string }) => Promise<string>;
let verify: ReturnType<typeof createActionsVerifier>;

const base: JWTPayload = {
  repository: 'acme/api',
  repository_id: '1234',
  repository_owner: 'acme',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  run_id: '99',
  run_attempt: '2',
  workflow_ref: 'acme/api/.github/workflows/mendr-audit.yml@refs/heads/main',
  actor: 'octocat',
  event_name: 'push',
};

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
  verify = createActionsVerifier(keys, { issuer: ISSUER, audience: 'mendr' });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? 'mendr')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
});

describe('GitHub Actions OIDC verification', () => {
  it('accepts a GitHub-shaped token and reads the claims (numerics arrive as strings)', async () => {
    const claims = await verify(await sign(base));
    expect(claims).toEqual({
      repository: 'acme/api',
      repositoryId: 1234,
      repositoryOwner: 'acme',
      sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      runId: 99,
      runAttempt: 2,
      workflowRef: 'acme/api/.github/workflows/mendr-audit.yml@refs/heads/main',
      actor: 'octocat',
      eventName: 'push',
    });
  });

  it('rejects the wrong audience, the wrong issuer and a token signed by another key', async () => {
    await expect(verify(await sign(base, { audience: 'someone-else' }))).rejects.toThrow();
    await expect(verify(await sign(base, { issuer: 'https://evil.example' }))).rejects.toThrow();
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT(base).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience('mendr').setExpirationTime('5m').sign(other.privateKey);
    await expect(verify(forged)).rejects.toThrow();
  });

  it('rejects tokens missing the claims the App relies on', () => {
    expect(() => claimsFrom({ ...base, repository_id: undefined })).toThrow(/repository_id/);
    expect(() => claimsFrom({ ...base, sha: 'short' })).toThrow(/sha/);
    expect(() => claimsFrom({ ...base, repository: 'not-a-repo' })).toThrow(/repository/);
    expect(() => claimsFrom({ ...base, run_id: 'x' })).toThrow(/run_id/);
  });
});
