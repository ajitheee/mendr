import { withDeadline } from '../deadline.js';
import { redactSecrets } from '../redact.js';
import type { Repo, Store } from '../store/types.js';
import type { AppInstallation, GitHubApi, InstallationRepo } from './api.js';
import type { ActionsClaims } from './oidc.js';

// INSTALL RECOVERY: rebuild the tenant boundary from GitHub when the database lost it.
//
// The App learns which installation covers which repository only from GitHub's installation
// webhooks, and GitHub never sends those again. Pointed at an empty database (the move off
// Render's Postgres), every existing install was refused with "the Mendr GitHub App is not
// installed on <repo>" until its account uninstalled and reinstalled the App.
//
// So when a CI call whose GitHub OIDC token has already verified names a repository the store
// does not know, the App asks GitHub which installation covers it, and stores the answer only
// when GitHub confirms all of it:
//
//   1. `GET /repos/{owner}/{repo}/installation` with the App's JWT, for the owner/repo the OIDC
//      token names (never a name from the request body). 404: the App is not installed there.
//   2. An installation token for that installation, limited to the repository id the OIDC token
//      names and to `metadata: read`. GitHub refuses to mint it when the installation does not
//      cover that id.
//   3. `GET /repos/{owner}/{repo}` with that token: GitHub's id for the name must equal the
//      token's repository_id.
//
// Only then are the installation and that one repository written, with an audit-log entry.
// Every other answer leaves the caller to respond exactly as before, and is remembered per
// repository id for a few minutes, so uploads the App will refuse cannot make it call GitHub on
// every request. No new permission is involved: the App JWT and `metadata: read` are what every
// GitHub App already holds.
//
// An installation the store already knows is never rewritten here: its lifecycle (suspend,
// unsuspend, uninstall) belongs to the webhooks. One the store holds as uninstalled is never
// brought back: GitHub does not reuse installation ids, so a reinstall arrives as a new one.

/** How long a definite "no" from GitHub is remembered for a repository id. */
export const REFUSAL_TTL_MS = 5 * 60_000;
/** How long a failed lookup (GitHub or the database did not answer) is remembered. */
export const FAILED_LOOKUP_TTL_MS = 60_000;
/** The most an upload waits for GitHub's answers before it is answered as before. */
export const UPLOAD_LOOKUP_BUDGET_MS = 20_000;
/** A signed-in user's installations are read from GitHub at most this often. */
export const USER_RECOVERY_INTERVAL_MS = 10 * 60_000;
/** Repository ids and user ids remembered at once; the oldest is forgotten first. */
export const MAX_REMEMBERED = 10_000;
/** Installations read per signed-in user. */
const MAX_USER_INSTALLATIONS = 20;

export type UploadRecoveryOutcome =
  | 'recovered'
  /** GitHub answered 404: no installation of this App covers that owner/repo. */
  | 'not_installed'
  | 'installation_suspended'
  /** The store holds that installation as uninstalled. */
  | 'installation_deleted'
  /** GitHub would not mint a token for the token's repository id in that installation. */
  | 'repository_not_covered'
  /** GitHub's id for the token's owner/repo is not the token's repository_id. */
  | 'repository_id_mismatch'
  /** The owner/repo claim is not a name GitHub could have issued. */
  | 'unusable_name'
  /** GitHub or the database failed or did not answer in time. */
  | 'lookup_failed';

type Verdict =
  | { ok: true; installation: AppInstallation; repo: InstallationRepo; installationKnown: boolean }
  | { ok: false; outcome: Exclude<UploadRecoveryOutcome, 'recovered' | 'lookup_failed'>; installationId: number | null };

export interface InstallRecoveryDeps {
  store: Store;
  github: GitHubApi;
  /** False when the App has no id or private key, so it has no JWT to ask GitHub with. */
  enabled: boolean;
  now: () => Date;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /** Deadline for the signed-in path, where a person is waiting for the page. */
  interactiveMs: number;
  /** Deadline for the upload path. Defaults to {@link UPLOAD_LOOKUP_BUDGET_MS}. */
  uploadBudgetMs?: number;
}

export interface SignedInUser {
  userId: number;
  login: string;
  token: string;
}

export interface InstallRecovery {
  /**
   * A CI call whose OIDC token verified names a repository the store does not know. Returns the
   * repository once GitHub confirmed it and it is stored; null means answer exactly as before.
   */
  forUpload(claims: ActionsClaims): Promise<Repo | null>;
  /**
   * A signed-in user's overview would be empty: add the installations of this App and the
   * repositories in them that GitHub says this user can access and the store does not know.
   * Returns how many repositories were added. Never throws.
   */
  forUser(user: SignedInUser): Promise<number>;
}

/** Owner and name as GitHub issues them: no slash, no URL syntax, not `.` or `..`. */
function usableName(fullName: string): boolean {
  const parts = fullName.split('/');
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9_.-]{1,100}$/.test(p) && p !== '.' && p !== '..');
}

/** Map.set, bounded: re-inserting moves the key to the end, and the oldest key goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  if (map.size >= MAX_REMEMBERED) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

const errorText = (err: unknown): string => redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);

export function createInstallRecovery(deps: InstallRecoveryDeps): InstallRecovery {
  const { store, github, log } = deps;
  const nowMs = () => deps.now().getTime();
  const uploadBudgetMs = deps.uploadBudgetMs ?? UPLOAD_LOOKUP_BUDGET_MS;
  /** repository id -> until when a lookup for it is not repeated. */
  const refused = new Map<number, number>();
  /** repository id -> the lookup already running, so concurrent uploads share one. */
  const inflight = new Map<number, Promise<Repo | null>>();
  /** user id -> when their installations were last read. */
  const userAttempts = new Map<number, number>();

  /** GitHub's answers and the store's state; reads only, so it can sit under a deadline. */
  async function lookup(claims: ActionsClaims): Promise<Verdict> {
    const refuse = (outcome: Exclude<Verdict, { ok: true }>['outcome'], installationId: number | null = null): Verdict => ({ ok: false, outcome, installationId });
    if (!usableName(claims.repository)) return refuse('unusable_name');
    const installation = await github.getRepoInstallation(claims.repository);
    if (!installation) return refuse('not_installed');
    if (installation.suspended) return refuse('installation_suspended', installation.id);
    const known = await store.getInstallation(installation.id);
    if (known?.deletedAt) return refuse('installation_deleted', installation.id);
    const repo = await github.getRepoAsInstallation(installation.id, claims.repository, claims.repositoryId);
    if (!repo) return refuse('repository_not_covered', installation.id);
    if (repo.id !== claims.repositoryId) return refuse('repository_id_mismatch', installation.id);
    return { ok: true, installation, repo, installationKnown: !!known };
  }

  async function recoverUpload(claims: ActionsClaims): Promise<Repo | null> {
    let verdict: Verdict;
    try {
      verdict = await withDeadline(lookup(claims), uploadBudgetMs);
    } catch (err) {
      remember(refused, claims.repositoryId, nowMs() + FAILED_LOOKUP_TTL_MS);
      log('install recovery failed', { repo: claims.repository, repositoryId: claims.repositoryId, outcome: 'lookup_failed', error: errorText(err) });
      return null;
    }
    if (!verdict.ok) {
      remember(refused, claims.repositoryId, nowMs() + REFUSAL_TTL_MS);
      log('install recovery refused', { repo: claims.repository, repositoryId: claims.repositoryId, outcome: verdict.outcome, installationId: verdict.installationId });
      return null;
    }
    // The writes come after the deadline, never under it: a late answer is dropped, not applied.
    const { installation, repo, installationKnown } = verdict;
    if (!installationKnown) {
      await store.upsertInstallation({ id: installation.id, accountLogin: installation.accountLogin, accountType: installation.accountType, suspended: false, deletedAt: null });
    }
    await store.upsertRepos(installation.id, [repo]);
    await store.appendAuditLog({
      event: 'installation_recovered',
      installationId: installation.id,
      repo: repo.fullName,
      actor: claims.actor,
      detail: { via: 'ci_upload', repositoryId: repo.id, account: installation.accountLogin, installationKnown, repositories: 1 },
    });
    log('install recovered', { repo: repo.fullName, repositoryId: repo.id, installationId: installation.id, via: 'ci_upload', installationKnown });
    return store.getRepo(claims.repositoryId);
  }

  /** Reads only; each installation is pushed once its repositories are read in full. */
  async function gatherForUser(user: SignedInUser, found: { installation: AppInstallation; repos: InstallationRepo[] }[]): Promise<void> {
    const installations = await github.listUserInstallations(user.token);
    for (const installation of installations.slice(0, MAX_USER_INSTALLATIONS)) {
      if (installation.suspended) continue;
      try {
        found.push({ installation, repos: await github.listUserInstallationRepos(user.token, installation.id) });
      } catch (err) {
        log('install recovery skipped an installation', { by: user.login, installationId: installation.id, error: errorText(err) });
      }
    }
  }

  return {
    async forUpload(claims) {
      if (!deps.enabled) return null;
      const id = claims.repositoryId;
      const until = refused.get(id);
      if (until !== undefined) {
        if (until > nowMs()) return null;
        refused.delete(id);
      }
      const running = inflight.get(id);
      if (running) return running;
      const p = recoverUpload(claims).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    },

    async forUser(user) {
      try {
        const t = nowMs();
        const last = userAttempts.get(user.userId);
        if (last !== undefined && t - last < USER_RECOVERY_INTERVAL_MS) return 0;
        remember(userAttempts, user.userId, t);
        const found: { installation: AppInstallation; repos: InstallationRepo[] }[] = [];
        try {
          await withDeadline(gatherForUser(user, found), deps.interactiveMs);
        } catch (err) {
          log('install recovery from sign-in incomplete', { by: user.login, error: errorText(err) });
        }
        // Writes only what was read in full before the deadline, and only what the store lacks.
        const knownRepoIds = new Set((await store.listRepos()).map((r) => r.id));
        let added = 0;
        for (const { installation, repos } of found.slice()) {
          const known = await store.getInstallation(installation.id);
          if (known?.deletedAt) continue;
          const missing: InstallationRepo[] = [];
          for (const r of repos) if (!knownRepoIds.has(r.id) && !(await store.getRepo(r.id))) missing.push(r);
          if (!missing.length) continue;
          if (!known) await store.upsertInstallation({ id: installation.id, accountLogin: installation.accountLogin, accountType: installation.accountType, suspended: false, deletedAt: null });
          await store.upsertRepos(installation.id, missing);
          for (const r of missing) knownRepoIds.add(r.id);
          added += missing.length;
          await store.appendAuditLog({
            event: 'installation_recovered',
            installationId: installation.id,
            repo: null,
            actor: user.login,
            detail: { via: 'sign_in', account: installation.accountLogin, installationKnown: !!known, repositories: missing.length },
          });
          log('install recovered', { installationId: installation.id, via: 'sign_in', by: user.login, repositories: missing.length, installationKnown: !!known });
        }
        return added;
      } catch (err) {
        log('install recovery from sign-in failed', { by: user.login, error: errorText(err) });
        return 0;
      }
    },
  };
}
