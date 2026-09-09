import type { AppConfig } from '../config.js';
import type { CheckRunPayload } from '../ingest/checkRun.js';
import { redactSecrets } from '../redact.js';
import { appJwt } from './appAuth.js';
import { withRetry } from './retry.js';

export interface ManifestCredentials {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  htmlUrl: string;
}

export interface CheckRunResult {
  id: number;
  html_url: string;
}

export interface UserRepo {
  id: number;
  fullName: string;
  private: boolean;
  /** The repo's default branch, for the one-click workflow setup link. */
  defaultBranch: string;
}

/**
 * Every GitHub call the App makes, behind one interface so tests can inject a
 * fake. Note what is NOT here: no contents, no clone, no file reads.
 */
export interface GitHubApi {
  /** Write the audit result to the commit, scoped to this one repository. */
  createCheckRun(installationId: number, repoFullName: string, repoId: number, payload: CheckRunPayload): Promise<CheckRunResult>;
  /** One-time exchange during /setup: the manifest code for the App's credentials. */
  convertManifest(code: string): Promise<ManifestCredentials>;
  /** Sign-in: OAuth code for a user-to-server token. */
  exchangeOAuthCode(code: string): Promise<{ accessToken: string; expiresAt: string | null }>;
  getViewer(token: string): Promise<{ id: number; login: string }>;
  /** Can this user see this repository? Null means no (or it does not exist). */
  getRepoAsUser(token: string, fullName: string): Promise<UserRepo | null>;
  /**
   * Start the customer's own migration workflow (workflow_dispatch) on a branch.
   * Needs the OPTIONAL `actions: write` permission — which is not code access;
   * without it GitHub refuses and the approval waits for that workflow's own
   * hourly check instead. Still no contents, no clone, no file reads.
   */
  dispatchWorkflow(installationId: number, repoFullName: string, repoId: number, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void>;
}

type ApiConfig = Pick<AppConfig, 'githubApiUrl' | 'githubWebUrl' | 'githubAppId' | 'githubPrivateKey' | 'githubClientId' | 'githubClientSecret'>;

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** How long GitHub asked us to wait (Retry-After / rate-limit reset), when it said. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Worth another try: a network/timeout error (not a GitHub answer at all), a
 * 429, a secondary-rate-limit 403, or a 5xx. A 4xx that means "no" (404, 401,
 * 403 without a rate-limit message, 422) is final.
 */
export function isRetryableGitHubError(e: unknown): boolean {
  if (!(e instanceof GitHubApiError)) return true;
  if (e.status === 429 || e.status >= 500) return true;
  return e.status === 403 && /rate limit/i.test(e.message);
}

/** The wait GitHub asked for, from Retry-After (seconds) or a rate-limit reset (epoch seconds). */
export function retryAfterFromHeaders(headers: Headers, now: number = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra && /^\d+$/.test(ra.trim())) return Number(ra.trim()) * 1000;
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset && /^\d+$/.test(reset.trim())) return Math.max(0, Number(reset.trim()) * 1000 - now);
  return undefined;
}

export const GITHUB_RETRY_ATTEMPTS = 3;

export function createGitHubApi(cfg: ApiConfig): GitHubApi {
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  const baseHeaders = (auth?: string): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mendr-app',
    ...(auth ? { Authorization: auth } : {}),
  });

  // Every call is retried on transient failure (isRetryableGitHubError), honoring
  // GitHub's own Retry-After when it sends one. The check-run POST is included:
  // a 5xx or a dropped connection almost always means nothing was created, and
  // a rare duplicate check run is far cheaper than lost evidence.
  async function call(url: string, init: RequestInit, auth?: string): Promise<{ status: number; json: unknown }> {
    return withRetry(
      async () => {
        const res = await fetch(url, {
          ...init,
          headers: { ...baseHeaders(auth), ...((init.headers as Record<string, string> | undefined) ?? {}) },
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (!res.ok) {
          const detail = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : text.slice(0, 200);
          throw new GitHubApiError(res.status, `GitHub ${res.status} for ${init.method ?? 'GET'} ${new URL(url).pathname}: ${redactSecrets(detail)}`, retryAfterFromHeaders(res.headers));
        }
        return { status: res.status, json };
      },
      { attempts: GITHUB_RETRY_ATTEMPTS, isRetryable: isRetryableGitHubError, retryAfterMs: (e) => (e instanceof GitHubApiError ? e.retryAfterMs : undefined) },
    );
  }

  async function installationToken(installationId: number, repoId: number, permissions: Record<string, string> = { checks: 'write' }): Promise<string> {
    const key = `${installationId}:${repoId}:${Object.entries(permissions)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(',')}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    if (!cfg.githubAppId || !cfg.githubPrivateKey) throw new GitHubApiError(503, 'the App is not configured (GITHUB_APP_ID / GITHUB_PRIVATE_KEY)');
    const jwt = await appJwt(cfg.githubAppId, cfg.githubPrivateKey);
    const { json } = await call(
      `${cfg.githubApiUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Least privilege per call: one repository, one permission.
        body: JSON.stringify({ repository_ids: [repoId], permissions }),
      },
      `Bearer ${jwt}`,
    );
    const r = json as { token?: string; expires_at?: string };
    if (!r?.token) throw new GitHubApiError(502, 'installation token response had no token');
    const expiresAt = r.expires_at ? Date.parse(r.expires_at) : Date.now() + 50 * 60_000;
    tokens.set(key, { token: r.token, expiresAt });
    return r.token;
  }

  return {
    async createCheckRun(installationId, repoFullName, repoId, payload) {
      const token = await installationToken(installationId, repoId);
      const { json } = await call(
        `${cfg.githubApiUrl}/repos/${repoFullName}/check-runs`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        `Bearer ${token}`,
      );
      const r = json as { id?: number; html_url?: string };
      if (typeof r?.id !== 'number' || typeof r.html_url !== 'string') throw new GitHubApiError(502, 'check run response was not a check run');
      return { id: r.id, html_url: r.html_url };
    },

    async convertManifest(code) {
      const { json } = await call(`${cfg.githubApiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
      const r = json as { id?: number; slug?: string; client_id?: string; client_secret?: string; webhook_secret?: string; pem?: string; html_url?: string };
      if (typeof r?.id !== 'number' || !r.pem || !r.client_id || !r.client_secret || !r.webhook_secret) throw new GitHubApiError(502, 'manifest conversion returned incomplete credentials');
      return { id: r.id, slug: r.slug ?? '', clientId: r.client_id, clientSecret: r.client_secret, webhookSecret: r.webhook_secret, pem: r.pem, htmlUrl: r.html_url ?? '' };
    },

    async exchangeOAuthCode(code) {
      if (!cfg.githubClientId || !cfg.githubClientSecret) throw new GitHubApiError(503, 'the App is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)');
      const { json } = await call(`${cfg.githubWebUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: cfg.githubClientId, client_secret: cfg.githubClientSecret, code }),
      });
      const r = json as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
      if (!r?.access_token) throw new GitHubApiError(401, `sign-in failed: ${r?.error_description ?? r?.error ?? 'no token returned'}`);
      const expiresAt = typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null;
      return { accessToken: r.access_token, expiresAt };
    },

    async getViewer(token) {
      const { json } = await call(`${cfg.githubApiUrl}/user`, { method: 'GET' }, `Bearer ${token}`);
      const r = json as { id?: number; login?: string };
      if (typeof r?.id !== 'number' || typeof r.login !== 'string') throw new GitHubApiError(502, 'user response had no id/login');
      return { id: r.id, login: r.login };
    },

    async getRepoAsUser(token, fullName) {
      try {
        const { json } = await call(`${cfg.githubApiUrl}/repos/${fullName}`, { method: 'GET' }, `Bearer ${token}`);
        const r = json as { id?: number; full_name?: string; private?: boolean; default_branch?: string };
        if (typeof r?.id !== 'number' || typeof r.full_name !== 'string') return null;
        return { id: r.id, fullName: r.full_name, private: r.private !== false, defaultBranch: typeof r.default_branch === 'string' && r.default_branch ? r.default_branch : 'main' };
      } catch (e) {
        if (e instanceof GitHubApiError && (e.status === 404 || e.status === 403 || e.status === 401)) return null;
        throw e;
      }
    },

    // Start the customer's own migration workflow on their default branch. This
    // is the one optional permission (actions: write, which is not code access);
    // when the App was never granted it, GitHub answers 422 to the token request
    // and the approval simply waits for that workflow's own hourly check.
    async dispatchWorkflow(installationId, repoFullName, repoId, workflowFile, ref, inputs) {
      const token = await installationToken(installationId, repoId, { actions: 'write' });
      await call(
        `${cfg.githubApiUrl}/repos/${repoFullName}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref, inputs }) },
        `Bearer ${token}`,
      );
    },
  };
}
