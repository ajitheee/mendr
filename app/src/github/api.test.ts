import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { createGitHubApi, GitHubApiError } from './api.js';

// The install-recovery calls against a GitHub-shaped fetch: which endpoint, with which
// credential, asking for what, and how each answer is read. Nothing here touches the network.

const API = 'https://api.github.test';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** Route every fetch through `route`, recording what the App sent. */
function github(route: (req: Seen) => Answer): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const req = { method: init.method ?? 'GET', path: u.pathname + u.search, auth: headers.Authorization ?? null, body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    seen.push(req);
    const a = route(req);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: a.headers });
  });
  return seen;
}

const api = () => createGitHubApi({ ...loadConfig({}), githubApiUrl: API, githubAppId: '77', githubPrivateKey: privateKey });
const INSTALLATION = { id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null, permissions: { checks: 'write', metadata: 'read' } };
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('install recovery: the GitHub calls behind it', () => {
  it("asks GET /repos/{owner}/{repo}/installation with the App's own JWT", async () => {
    const seen = github(() => ({ status: 200, body: INSTALLATION }));
    expect(await api().getRepoInstallation('acme/api')).toEqual({ id: 42, accountLogin: 'acme', accountType: 'Organization', suspended: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/repos/acme/api/installation' });
    const jwt = seen[0]!.auth!.replace(/^Bearer /, '');
    expect(decodeJwt(jwt).iss).toBe('77');
  });

  it('reads a 404 as "not installed", and a suspended installation as suspended', async () => {
    github(() => ({ status: 404, body: { message: 'Not Found' } }));
    expect(await api().getRepoInstallation('acme/api')).toBeNull();
    github(() => ({ status: 200, body: { ...INSTALLATION, suspended_at: '2026-10-01T00:00:00Z' } }));
    expect((await api().getRepoInstallation('acme/api'))?.suspended).toBe(true);
  });

  it('a GitHub outage is an error, not "not installed"', async () => {
    const seen = github(() => ({ status: 502, body: { message: 'Bad Gateway' }, headers: { 'retry-after': '0' } }));
    await expect(api().getRepoInstallation('acme/api')).rejects.toBeInstanceOf(GitHubApiError);
    expect(seen.length).toBeGreaterThan(1); // retried like every other call
  });

  it('mints a token limited to the one repository id and metadata: read, and reads the repository with it', async () => {
    const seen = github((req) => {
      if (req.method === 'POST' && req.path === '/app/installations/42/access_tokens') return { status: 201, body: { token: 'ghs_recovery', expires_at: inAnHour() } };
      if (req.method === 'GET' && req.path === '/repos/acme/api') return { status: 200, body: { id: 1234, full_name: 'acme/api', private: true, default_branch: 'main' } };
      return { status: 404, body: { message: 'Not Found' } };
    });
    expect(await api().getRepoAsInstallation(42, 'acme/api', 1234)).toEqual({ id: 1234, fullName: 'acme/api', private: true });
    expect(seen[0]!.body).toEqual({ repository_ids: [1234], permissions: { metadata: 'read' } });
    expect(decodeJwt(seen[0]!.auth!.replace(/^Bearer /, '')).iss).toBe('77');
    expect(seen[1]).toMatchObject({ method: 'GET', path: '/repos/acme/api', auth: 'Bearer ghs_recovery' });
  });

  it('a token GitHub will not mint for that repository id, or a repository the token cannot see, is null', async () => {
    let seen = github(() => ({ status: 422, body: { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' } }));
    expect(await api().getRepoAsInstallation(42, 'acme/api', 9999)).toBeNull();
    expect(seen).toHaveLength(1); // no repository read without the token
    seen = github((req) => (req.method === 'POST' ? { status: 201, body: { token: 'ghs_recovery', expires_at: inAnHour() } } : { status: 404, body: { message: 'Not Found' } }));
    expect(await api().getRepoAsInstallation(42, 'acme/gone', 1234)).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it('a rate-limited token request is an error, not a refusal', async () => {
    github(() => ({ status: 403, body: { message: 'API rate limit exceeded for installation.' }, headers: { 'retry-after': '0' } }));
    await expect(api().getRepoAsInstallation(42, 'acme/api', 1234)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("lists the signed-in user's installations and their repositories with the user's own token", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, full_name: `acme/r${from + i}`, private: i % 2 === 0 }));
    const seen = github((req) => {
      if (req.path === '/user/installations?per_page=100') return { status: 200, body: { total_count: 2, installations: [INSTALLATION, { ...INSTALLATION, id: 43, account: { login: 'beta', type: 'User' } }] } };
      if (req.path === '/user/installations/42/repositories?per_page=100&page=1') return { status: 200, body: { total_count: 105, repositories: page(100, 1) } };
      if (req.path === '/user/installations/42/repositories?per_page=100&page=2') return { status: 200, body: { total_count: 105, repositories: page(5, 101) } };
      return { status: 404, body: { message: 'Not Found' } };
    });
    const gh = api();
    expect(await gh.listUserInstallations('ghu_user')).toEqual([
      { id: 42, accountLogin: 'acme', accountType: 'Organization', suspended: false },
      { id: 43, accountLogin: 'beta', accountType: 'User', suspended: false },
    ]);
    const repos = await gh.listUserInstallationRepos('ghu_user', 42);
    expect(repos).toHaveLength(105);
    expect(repos[0]).toEqual({ id: 1, fullName: 'acme/r1', private: true });
    expect(seen.every((s) => s.auth === 'Bearer ghu_user')).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(['/user/installations?per_page=100', '/user/installations/42/repositories?per_page=100&page=1', '/user/installations/42/repositories?per_page=100&page=2']);
  });

  it('reads at most three pages of one installation\'s repositories', async () => {
    let n = 0;
    const seen = github(() => ({ status: 200, body: { total_count: 1000, repositories: Array.from({ length: 100 }, () => ({ id: ++n, full_name: `acme/r${n}`, private: true })) } }));
    expect(await api().listUserInstallationRepos('ghu_user', 42)).toHaveLength(300);
    expect(seen).toHaveLength(3);
  });
});
