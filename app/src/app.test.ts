import { createHmac } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildManifest, createApp } from './app.js';
import { sealSession, SESSION_COOKIE } from './auth/session.js';
import { loadConfig, type AppConfig } from './config.js';
import type { CheckRunPayload } from './ingest/checkRun.js';
import { sampleReport } from '../test/sampleReport.js';
import type { GitHubApi } from './github/api.js';
import { createActionsVerifier } from './github/oidc.js';
import { MemoryStore } from './store/memory.js';

// The whole App exercised through app.request(): a GitHub-shaped world with a
// local OIDC signing key, a recording fake of the GitHub API, and the memory
// store. Nothing here touches the network.

const ISSUER = 'https://token.actions.githubusercontent.com';
const WEBHOOK_SECRET = 'whsec_test';
const REPO = { id: 1234, full_name: 'acme/api', private: true };
const INSTALLATION = { id: 42, account: { login: 'acme', type: 'Organization' } };

let privateKey: CryptoKey;
let verify: ReturnType<typeof createActionsVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  verify = createActionsVerifier(createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), { issuer: ISSUER, audience: 'mendr' });
});

async function actionsToken(extra: Partial<JWTPayload> = {}): Promise<string> {
  return new SignJWT({
    repository: REPO.full_name,
    repository_id: String(REPO.id),
    repository_owner: 'acme',
    sha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    run_id: '99',
    run_attempt: '1',
    workflow_ref: 'acme/api/.github/workflows/mendr-audit.yml@refs/heads/main',
    actor: 'octocat',
    event_name: 'push',
    ...extra,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('mendr')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function fakeGitHub(userRepos: Record<string, number> = {}) {
  const checkRuns: { installationId: number; fullName: string; repoId: number; payload: CheckRunPayload }[] = [];
  const api: GitHubApi = {
    async createCheckRun(installationId, fullName, repoId, payload) {
      checkRuns.push({ installationId, fullName, repoId, payload });
      return { id: checkRuns.length, html_url: `https://github.com/${fullName}/runs/${checkRuns.length}` };
    },
    async convertManifest() {
      return { id: 77, slug: 'mendr-test', clientId: 'Iv1.test', clientSecret: 'cs_test', webhookSecret: 'whs_test', pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----', htmlUrl: 'https://github.com/apps/mendr-test' };
    },
    async exchangeOAuthCode() {
      return { accessToken: 'user-token', expiresAt: null };
    },
    async getViewer() {
      return { id: 7, login: 'octocat' };
    },
    async getRepoAsUser(_token, fullName) {
      const id = userRepos[fullName];
      return id ? { id, fullName, private: true, defaultBranch: 'main' } : null;
    },
  };
  return { api, checkRuns };
}

function harness(userRepos: Record<string, number> = {}) {
  const config: AppConfig = {
    ...loadConfig({}),
    appUrl: 'https://app.example',
    githubAppId: '77',
    githubAppSlug: 'mendr-test',
    githubPrivateKey: 'pem',
    githubWebhookSecret: WEBHOOK_SECRET,
    githubClientId: 'Iv1.test',
    githubClientSecret: 'cs_test',
    sessionSecret: 'a-session-secret-that-is-long-enough',
  };
  const store = new MemoryStore();
  const gh = fakeGitHub(userRepos);
  const logs: string[] = [];
  const app = createApp({ config, store, github: gh.api, verifyActionsToken: verify, log: (m) => logs.push(m) });
  const webhook = (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}` },
      body,
    });
  };
  const install = () => webhook('installation', { action: 'created', installation: INSTALLATION, repositories: [REPO] });
  const ingest = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const sessionCookie = async () => `${SESSION_COOKIE}=${await sealSession({ userId: 7, login: 'octocat', token: 'user-token', exp: Math.floor(Date.now() / 1000) + 3600 }, config.sessionSecret)}`;
  return { app, store, gh, config, logs, webhook, install, ingest, sessionCookie };
}

describe('manifest: least privilege, stated before creation', () => {
  it('asks for checks:write and metadata:read only, and points every URL at APP_URL', () => {
    const { config } = harness();
    const m = buildManifest(config);
    expect(m.default_permissions).toEqual({ checks: 'write', metadata: 'read' });
    expect(m.default_events).toEqual([]);
    expect(m.hook_attributes).toEqual({ url: 'https://app.example/webhooks/github', active: true });
    expect(m.redirect_url).toBe('https://app.example/setup/callback');
    expect(m.callback_urls).toEqual(['https://app.example/auth/callback']);
    expect(Object.keys(m.default_permissions as object).sort()).toEqual(['checks', 'metadata']);
  });

  it('the setup page carries the manifest, and the callback refuses a state it did not issue', async () => {
    const { app } = harness();
    const page = await app.request('/setup');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="manifest"');
    const cb = await app.request('/setup/callback?code=abc&state=forged');
    expect(cb.status).toBe(400);
  });
});

describe('webhooks define who may send evidence', () => {
  it('rejects a bad signature and records a good installation', async () => {
    const h = harness();
    const bad = await h.app.request('/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'installation', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    expect(bad.status).toBe(401);
    const ok = await h.install();
    expect(ok.status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ fullName: 'acme/api', installationId: 42 });
  });
});

describe('ingest: evidence from the customer CI, proven by OIDC', () => {
  it('needs a bearer token, and a valid one', async () => {
    const h = harness();
    await h.install();
    expect((await h.app.request('/api/ingest', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await h.ingest('not-a-jwt', sampleReport())).status).toBe(401);
  });

  it('refuses repositories where the App is not installed, and tells the caller where to install it', async () => {
    const h = harness();
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; install: string };
    expect(body.error).toContain('not installed on acme/api');
    expect(body.install).toBe('https://github.com/apps/mendr-test/installations/new');
    expect(h.gh.checkRuns.length).toBe(0);
  });

  it('stores sanitized evidence, writes a check run scoped to that repository, and reports back', async () => {
    const h = harness();
    await h.install();
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; run: { id: number; url: string; counts: { patch: number } }; checkRun: string | null; checkRunError: string | null };
    expect(body.ok).toBe(true);
    expect(body.run.counts).toEqual({ patch: 1, review: 1, informational: 1 });
    expect(body.run.url).toBe(`https://app.example/r/acme/api/runs/${body.run.id}`);
    expect(body.checkRun).toBe('https://github.com/acme/api/runs/1');
    expect(body.checkRunError).toBeNull();

    const cr = h.gh.checkRuns[0]!;
    expect(cr).toMatchObject({ installationId: 42, fullName: 'acme/api', repoId: REPO.id });
    expect(cr.payload.head_sha).toBe('c'.repeat(40));
    expect(cr.payload.conclusion).toBe('action_required');
    expect(cr.payload.details_url).toBe(body.run.url);
    expect(cr.payload.output.annotations[0]).toMatchObject({ path: 'src/client.ts', start_line: 4, annotation_level: 'warning' });

    const stored = await h.store.getRun(body.run.id);
    expect(stored?.checkRunUrl).toBe('https://github.com/acme/api/runs/1');
    const json = JSON.stringify(stored);
    expect(json).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(json).toContain('REDACTED');
    // Only evidence is stored: paths, lines, classifications, a capped snippet.
    expect(stored?.report.investigations[0]?.locations.selectors[0]?.snippet?.lines.length).toBe(7);
  });

  it('uses the report sha when the workflow passed the PR head through --sha', async () => {
    const h = harness();
    await h.install();
    await h.ingest(await actionsToken({ event_name: 'pull_request', sha: 'd'.repeat(40) }), sampleReport({ sha: 'e'.repeat(40) }));
    expect(h.gh.checkRuns[0]!.payload.head_sha).toBe('e'.repeat(40));
  });

  it('is idempotent per workflow run attempt: a re-post replaces, never duplicates', async () => {
    const h = harness();
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    await h.ingest(await actionsToken(), sampleReport({ investigations: [] , conclusion: 'no_exposure_in_completed_surfaces' }));
    const runs = await h.store.listRuns(REPO.id, 10);
    expect(runs.length).toBe(1);
    expect(runs[0]!.counts).toEqual({ patch: 0, review: 0, informational: 0 });
    await h.ingest(await actionsToken({ run_attempt: '2' }), sampleReport());
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(2);
  });

  it('rejects malformed, wrong-schema and oversized bodies without storing anything', async () => {
    const h = harness();
    await h.install();
    expect((await h.ingest(await actionsToken(), 'nope')).status).toBe(400);
    expect((await h.ingest(await actionsToken(), { ...sampleReport(), schema: 'x' })).status).toBe(400);
    h.config.maxBodyBytes = 200;
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(413);
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(0);
  });

  it('stops accepting evidence when the installation is suspended or deleted', async () => {
    const h = harness();
    await h.install();
    await h.webhook('installation', { action: 'suspend', installation: INSTALLATION });
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(403);
    await h.webhook('installation', { action: 'unsuspend', installation: INSTALLATION });
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(200);
    await h.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    expect((await h.ingest(await actionsToken({ run_id: '100' }), sampleReport())).status).toBe(403);
  });

  it('a failed check-run write does not lose the evidence', async () => {
    const h = harness();
    await h.install();
    h.gh.api.createCheckRun = async () => {
      throw new Error('GitHub 403 for POST /repos/acme/api/check-runs: Resource not accessible by integration');
    };
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkRun: string | null; checkRunError: string | null };
    expect(body.checkRun).toBeNull();
    expect(body.checkRunError).toContain('Resource not accessible');
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(1);
  });
});

describe('reading evidence requires sign-in AND GitHub access to the repository', () => {
  it('anonymous callers get 401 from the API and a sign-in redirect from pages', async () => {
    const h = harness();
    expect((await h.app.request('/api/repos')).status).toBe(401);
    expect((await h.app.request('/api/repos/acme/api/runs')).status).toBe(401);
    const page = await h.app.request('/r/acme/api');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/login?next=%2Fr%2Facme%2Fapi');
  });

  it('a signed-in user sees only repositories GitHub says they can access', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.webhook('installation_repositories', { action: 'added', installation: INSTALLATION, repositories_added: [{ id: 5, full_name: 'acme/secret' }], repositories_removed: [] });
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    const repos = (await (await h.app.request('/api/repos', { headers: { cookie } })).json()) as { repos: { fullName: string; latest: { counts: { patch: number } } }[] };
    expect(repos.repos.map((r) => r.fullName)).toEqual(['acme/api']);
    expect(repos.repos[0]!.latest.counts.patch).toBe(1);
    expect((await h.app.request('/api/repos/acme/secret/runs', { headers: { cookie } })).status).toBe(404);
    const runs = (await (await h.app.request('/api/repos/acme/api/runs', { headers: { cookie } })).json()) as { runs: { id: number }[] };
    expect(runs.runs.length).toBe(1);
    const run = await h.app.request(`/api/runs/${runs.runs[0]!.id}`, { headers: { cookie } });
    expect(run.status).toBe(200);
    const page = await h.app.request(`/r/acme/api/runs/${runs.runs[0]!.id}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('PATCH ELIGIBLE');
  });

  it('a user whose GitHub access does not cover the repository gets 404, not the evidence', async () => {
    const h = harness({});
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    expect((await h.app.request('/api/repos/acme/api/runs', { headers: { cookie } })).status).toBe(404);
    expect((await h.app.request('/api/runs/1', { headers: { cookie } })).status).toBe(404);
    expect(((await (await h.app.request('/api/repos', { headers: { cookie } })).json()) as { repos: unknown[] }).repos).toEqual([]);
  });

  it('offers a one-click "Set up the audit" link for an installed repo with no run yet', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install(); // installed, but no run ingested
    const cookie = await h.sessionCookie();
    const page = await (await h.app.request('/', { headers: { cookie } })).text();
    expect(page).toContain('Set up the audit');
    // the link points at GitHub's prefilled new-file editor for this repo + workflow
    expect(page).toContain('github.com/acme/api/new/main?filename=');
    expect(page).toContain(encodeURIComponent('.github/workflows/mendr-audit.yml'));
    // the repo page shows the same call to action
    const repoPage = await (await h.app.request('/r/acme/api', { headers: { cookie } })).text();
    expect(repoPage).toContain('Not connected yet');
    expect(repoPage).toContain('/acme/api/new/main?filename=');
  });

  it('sign-in redirects to GitHub with the client id and a state cookie', async () => {
    const h = harness();
    const res = await h.app.request('/auth/login?next=/r/acme/api');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Iv1.test');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://app.example/auth/callback');
    expect(res.headers.get('set-cookie')).toContain('mendr_login_state=');
  });
});
