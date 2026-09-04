import type { AppConfig } from '../config.js';
import type { CheckRunPayload } from '../ingest/checkRun.js';
import { redactSecrets } from '../redact.js';
import { appJwt } from './appAuth.js';

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
}

type ApiConfig = Pick<AppConfig, 'githubApiUrl' | 'githubWebUrl' | 'githubAppId' | 'githubPrivateKey' | 'githubClientId' | 'githubClientSecret'>;

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function createGitHubApi(cfg: ApiConfig): GitHubApi {
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  const baseHeaders = (auth?: string): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mendr-app',
    ...(auth ? { Authorization: auth } : {}),
  });

  async function call(url: string, init: RequestInit, auth?: string): Promise<{ status: number; json: unknown }> {
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
      throw new GitHubApiError(res.status, `GitHub ${res.status} for ${init.method ?? 'GET'} ${new URL(url).pathname}: ${redactSecrets(detail)}`);
    }
    return { status: res.status, json };
  }

  async function installationToken(installationId: number, repoId: number): Promise<string> {
    const key = `${installationId}:${repoId}`;
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
        body: JSON.stringify({ repository_ids: [repoId], permissions: { checks: 'write' } }),
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
        const r = json as { id?: number; full_name?: string; private?: boolean };
        if (typeof r?.id !== 'number' || typeof r.full_name !== 'string') return null;
        return { id: r.id, fullName: r.full_name, private: r.private !== false };
      } catch (e) {
        if (e instanceof GitHubApiError && (e.status === 404 || e.status === 403 || e.status === 401)) return null;
        throw e;
      }
    },
  };
}
