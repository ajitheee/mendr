// Mint a GitHub-Actions-shaped OIDC token signed by a LOCAL development key so
// POST /api/ingest can be exercised without a real workflow run.
//
//   node scripts/dev-oidc.mjs owner/name <repoId> [sha] [ref]
//
// Run the server with the matching verifier:
//   OIDC_JWKS_FILE=.dev/oidc-jwks.json OIDC_ISSUER=https://dev.mendr.local npm run dev
//
// The key lives in .dev/ (gitignored) and is not a credential for anything real.
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = '.dev';
const PRIVATE = `${DIR}/oidc-private.json`;
const PUBLIC = `${DIR}/oidc-jwks.json`;
const ISSUER = 'https://dev.mendr.local';

if (!existsSync(PRIVATE)) {
  mkdirSync(DIR, { recursive: true });
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pub = await exportJWK(publicKey);
  Object.assign(pub, { kid: 'dev', alg: 'RS256', use: 'sig' });
  const priv = await exportJWK(privateKey);
  priv.kid = 'dev';
  writeFileSync(PRIVATE, JSON.stringify(priv));
  writeFileSync(PUBLIC, JSON.stringify({ keys: [pub] }));
  console.error(`created ${PRIVATE} and ${PUBLIC}`);
}

const [repository, repoId, sha = '0'.repeat(40), ref = 'refs/heads/main'] = process.argv.slice(2);
if (!repository || !repoId) {
  console.error('usage: node scripts/dev-oidc.mjs owner/name <repoId> [sha] [ref]');
  process.exit(2);
}
const key = await importJWK(JSON.parse(readFileSync(PRIVATE, 'utf8')), 'RS256');
const owner = repository.split('/')[0];
const token = await new SignJWT({
  repository,
  repository_id: String(repoId),
  repository_owner: owner,
  repository_owner_id: '1',
  sha,
  ref,
  run_id: String(Date.now()),
  run_attempt: '1',
  workflow_ref: `${repository}/.github/workflows/mendr-audit.yml@${ref}`,
  actor: 'dev',
  event_name: 'push',
})
  .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
  .setIssuer(ISSUER)
  .setAudience('mendr')
  .setSubject(`repo:${repository}:ref:${ref}`)
  .setIssuedAt()
  .setExpirationTime('10m')
  .sign(key);
console.log(token);
