import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// The ingest endpoint has no shared secret. A workflow run proves where it came
// from with the OIDC token GitHub mints for it (permissions: id-token: write):
// signed by GitHub, ten minutes long, and carrying the repository id, commit
// and run. We verify the signature against GitHub's published keys and read
// those claims. Nothing in the customer's repository has to hold a credential.

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

export interface ActionsClaims {
  repository: string;
  repositoryId: number;
  repositoryOwner: string;
  sha: string;
  ref: string;
  runId: number;
  runAttempt: number;
  workflowRef: string | null;
  actor: string | null;
  eventName: string | null;
}

export type ActionsTokenVerifier = (token: string) => Promise<ActionsClaims>;

export class OidcClaimError extends Error {}

export function remoteActionsJwks(issuer: string = GITHUB_ACTIONS_ISSUER): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
}

function str(p: JWTPayload, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(p: JWTPayload, key: string): number | null {
  const v = p[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Extract and validate the claims the App relies on. GitHub sends the numeric ones as strings. */
export function claimsFrom(p: JWTPayload): ActionsClaims {
  const repository = str(p, 'repository');
  const repositoryId = num(p, 'repository_id');
  const sha = str(p, 'sha');
  const ref = str(p, 'ref');
  const runId = num(p, 'run_id');
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new OidcClaimError('token has no repository claim');
  if (!repositoryId) throw new OidcClaimError('token has no repository_id claim');
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new OidcClaimError('token has no commit sha claim');
  if (!ref) throw new OidcClaimError('token has no ref claim');
  if (!runId) throw new OidcClaimError('token has no run_id claim');
  return {
    repository,
    repositoryId,
    repositoryOwner: str(p, 'repository_owner') ?? repository.split('/')[0]!,
    sha,
    ref,
    runId,
    runAttempt: num(p, 'run_attempt') ?? 1,
    workflowRef: str(p, 'workflow_ref') ?? str(p, 'job_workflow_ref'),
    actor: str(p, 'actor'),
    eventName: str(p, 'event_name'),
  };
}

export function createActionsVerifier(keys: JWTVerifyGetKey, opts: { issuer: string; audience: string }): ActionsTokenVerifier {
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer: opts.issuer, audience: opts.audience, algorithms: ['RS256'] });
    return claimsFrom(payload);
  };
}
