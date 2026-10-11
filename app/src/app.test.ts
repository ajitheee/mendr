import { createHmac, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildManifest, createApp } from './app.js';
import { sealSession, SESSION_COOKIE } from './auth/session.js';
import { loadConfig, type AppConfig } from './config.js';
import type { CheckRunPayload } from './ingest/checkRun.js';
import { sampleReport } from '../test/sampleReport.js';
import { createGitHubApi, GitHubApiError, type GitHubApi } from './github/api.js';
import { FAILED_LOOKUP_TTL_MS, REFUSAL_TTL_MS, USER_RECOVERY_INTERVAL_MS } from './github/installRecovery.js';
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

/** An installation of the App as GitHub holds it, for the install-recovery lookups. */
interface WorldInstallation {
  id: number;
  account: { login: string; type: 'User' | 'Organization' };
  suspended_at: string | null;
  /** The repository ids its selection covers. */
  repositoryIds: number[];
  /** Listed by `GET /user/installations` for the signed-in user. */
  userCanAccess?: boolean;
}

function fakeGitHub(userRepos: Record<string, number> = {}) {
  const checkRuns: { installationId: number; fullName: string; repoId: number; payload: CheckRunPayload }[] = [];
  const dispatches: { installationId: number; fullName: string; repoId: number; workflowFile: string; ref: string; inputs: Record<string, string> }[] = [];
  // GitHub's own state, which the webhooks normally copy into the store: which repositories
  // exist and which installation of the App covers which repository ids. Empty by default, so
  // GitHub, like the store, knows of no installation until a test says so.
  const world = { repos: {} as Record<string, { id: number; private: boolean }>, installations: [] as WorldInstallation[] };
  const lookups = { repoInstallation: [] as string[], repoAsInstallation: [] as { installationId: number; fullName: string; repoId: number }[], userInstallations: 0, userInstallationRepos: [] as number[] };
  const asInstallation = (i: WorldInstallation) => ({ id: i.id, accountLogin: i.account.login, accountType: i.account.type, suspended: i.suspended_at !== null });
  const api: GitHubApi = {
    // GET /repos/{owner}/{repo}/installation with the App JWT: 404 (null) unless an installation covers it.
    async getRepoInstallation(fullName) {
      lookups.repoInstallation.push(fullName);
      const repo = world.repos[fullName];
      const inst = repo ? world.installations.find((i) => i.repositoryIds.includes(repo.id)) : undefined;
      return inst ? asInstallation(inst) : null;
    },
    // A token limited to repoId (refused, null, when the installation does not cover it), then
    // GET /repos/{owner}/{repo}, which answers with whatever repository has that name.
    async getRepoAsInstallation(installationId, fullName, repoId) {
      lookups.repoAsInstallation.push({ installationId, fullName, repoId });
      const inst = world.installations.find((i) => i.id === installationId);
      if (!inst || !inst.repositoryIds.includes(repoId)) return null;
      const repo = world.repos[fullName];
      return repo ? { id: repo.id, fullName, private: repo.private } : null;
    },
    async listUserInstallations() {
      lookups.userInstallations++;
      return world.installations.filter((i) => i.userCanAccess).map(asInstallation);
    },
    async listUserInstallationRepos(_token, installationId) {
      lookups.userInstallationRepos.push(installationId);
      const inst = world.installations.find((i) => i.id === installationId);
      return Object.entries(world.repos)
        .filter(([, r]) => inst?.repositoryIds.includes(r.id))
        .map(([fullName, r]) => ({ id: r.id, fullName, private: r.private }));
    },
    async dispatchWorkflow(installationId, fullName, repoId, workflowFile, ref, inputs) {
      dispatches.push({ installationId, fullName, repoId, workflowFile, ref, inputs });
    },
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
  return { api, checkRuns, dispatches, world, lookups };
}

interface HarnessOptions {
  /** Use this GitHub client instead of the recording fake (gh.api), e.g. the real createGitHubApi over a stubbed fetch. */
  github?: (config: AppConfig) => GitHubApi;
  /** The upload's install-lookup deadline; 40 ms unless a test needs the real client's crypto to fit. */
  installLookupTimeoutMs?: number;
}

function harness(userRepos: Record<string, number> = {}, over: Partial<AppConfig> = {}, opts: HarnessOptions = {}) {
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
    ...over,
  };
  const store = new MemoryStore();
  const gh = fakeGitHub(userRepos);
  const logs: string[] = [];
  // The full records too, not only the message. Half this suite's point is that an early exit
  // now says WHICH repository and WHY, and a string[] cannot assert that.
  const logEvents: { message: string; extra?: Record<string, unknown> }[] = [];
  // The App's clock runs with the real one plus whatever a test skips ahead (h.advance), so the
  // install-recovery cache can be expired without waiting. OIDC tokens keep the real clock.
  let skewMs = 0;
  const app = createApp({
    config,
    store,
    github: opts.github ? opts.github(config) : gh.api,
    now: () => new Date(Date.now() + skewMs),
    verifyActionsToken: verify,
    log: (m, extra) => {
      logs.push(m);
      logEvents.push(extra ? { message: m, extra } : { message: m });
    },
    // Real value is 8s; asserting the deadline should not cost the suite eight seconds.
    interactiveTimeoutMs: 40,
    // Real value is 20s, for the same reason.
    installLookupTimeoutMs: opts.installLookupTimeoutMs ?? 40,
  });
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
  const migrations = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/migrations', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const sessionCookie = async () => `${SESSION_COOKIE}=${await sealSession({ userId: 7, login: 'octocat', token: 'user-token', exp: Math.floor(Date.now() / 1000) + 3600 }, config.sessionSecret)}`;
  const advance = (ms: number) => {
    skewMs += ms;
  };
  return { app, store, gh, config, logs, logEvents, webhook, install, ingest, migrations, sessionCookie, advance };
}

/** What mendr-action would send after a verified migration of the sample report's gpt-4 finding — with a diff the App must drop. */
function sampleMigration(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'mendr-migration-report/v1',
    outcome: 'migration-proposed',
    prUrl: 'https://github.com/acme/api/pull/12',
    sha: 'c'.repeat(40),
    generatedAt: '2026-09-07T07:00:00Z',
    verdict: 'verified',
    gates: { typeCheck: 'pass', build: 'not-configured', tests: 'pass', eval: 'not-configured' },
    behavioralTested: false,
    migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-4.1', language: 'ts', sites: 1, files: ['src/client.ts'] }],
    changedFiles: ['src/client.ts'],
    notes: ['Behavior was NOT verified.'],
    diff: 'diff --git a/src/client.ts b/src/client.ts\n-  model: "gpt-4"\n+  model: "gpt-4.1"\n',
    ...over,
  };
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

  it('uninstalling the App purges the installation\'s findings and repos (data cleanup)', async () => {
    const h = harness();
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(1);
    await h.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    // findings and the repo are gone; the installation row survives as a record.
    expect(await h.store.getRun(1)).toBeNull();
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect((await h.store.getInstallation(INSTALLATION.id))?.deletedAt).toBeTruthy();
  });

  it('removing a repository from the installation deletes that repo\'s findings', async () => {
    const h = harness();
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    await h.webhook('installation_repositories', { action: 'removed', installation: INSTALLATION, repositories_added: [], repositories_removed: [REPO] });
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(0);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
  });

  it('a signed-in user can delete their repo\'s stored data on demand', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    const res = await h.app.request('/r/acme/api/delete', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Removed 1 stored run');
    expect((await h.store.listRuns(REPO.id, 10)).length).toBe(0);
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

describe('migrations: what mendr-action did, proven by OIDC', () => {
  it('needs a valid token and an installed repository', async () => {
    const h = harness();
    expect((await h.app.request('/api/migrations', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await h.migrations('not-a-jwt', sampleMigration())).status).toBe(401);
    const res = await h.migrations(await actionsToken(), sampleMigration());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { install: string | null }).install).toBe('https://github.com/apps/mendr-test/installations/new');
  });

  it('stores the whitelisted report with the change itself — redacted and capped, never whole files — logs it, and reports back', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    const diff = 'diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n@@ -3,2 +3,2 @@\n-  model: "gpt-4",\n+  model: "gpt-4.1",\n+  apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",\n';
    const res = await h.migrations(await actionsToken(), sampleMigration({ diff }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, migration: { id: 1, outcome: 'migration-proposed', verdict: 'verified', prUrl: 'https://github.com/acme/api/pull/12' }, approvals: [] });
    const stored = await h.store.latestMigration(REPO.id);
    expect(stored?.report.migrations).toEqual([{ provider: 'openai', from: 'gpt-4', to: 'gpt-4.1', language: 'ts', sites: 1, files: ['src/client.ts'] }]);
    expect(stored?.report.diff).toContain('+  model: "gpt-4.1",');
    expect(stored?.report.diff).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'); // redacted again here
    const events = (await h.store.listAuditLog()).map((e) => e.event);
    expect(events).toContain('pr_created');
    // and the finding shows what changes, without leaving the App
    await h.ingest(await actionsToken(), sampleReport());
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie: await h.sessionCookie() } })).text();
    expect(html).toContain('What changes in <code>src/client.ts</code>');
    expect(html).toContain('<span class="add">+  model: &quot;gpt-4.1&quot;,</span>');
    expect(html).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('keeps only a real diff, capped with a visible mark; the action can withhold it', async () => {
    const h = harness();
    await h.install();
    await h.migrations(await actionsToken({ run_id: '1' }), sampleMigration({ diff: 'const secret = "not a diff at all";' }));
    expect((await h.store.latestMigration(REPO.id))?.report.diff).toBeNull();
    await h.migrations(await actionsToken({ run_id: '2' }), sampleMigration({ diff: `diff --git a/x b/x\n${'+'.repeat(120_000)}` }));
    const big = (await h.store.latestMigration(REPO.id))?.report.diff ?? '';
    expect(big.length).toBeLessThan(101_000);
    expect(big).toContain('truncated by Mendr');
    await h.migrations(await actionsToken({ run_id: '3' }), sampleMigration({ diff: undefined }));
    expect((await h.store.latestMigration(REPO.id))?.report.diff).toBeNull();
  });

  it('learns from the audit which file carries the migration job, and starts that one on approval', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport({ coverage: { migration: { workflowPresent: true, workflowFile: 'mendr-audit.yml' } } }));
    expect((await h.store.getRepo(REPO.id))?.migrateWorkflow).toBe('mendr-audit.yml');
    const cookie = await h.sessionCookie();
    await h.app.request('/r/acme/api/approve', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ provider: 'openai', model: 'gpt-4', replacement: 'gpt-4.1', back: '/r/acme/api/runs/1' }).toString(),
    });
    expect(h.gh.dispatches.map((d) => d.workflowFile)).toEqual(['mendr-audit.yml']);
  });

  it('refuses a PR url that is not a pull request of this repository on this GitHub', async () => {
    const h = harness();
    await h.install();
    expect((await h.migrations(await actionsToken(), sampleMigration({ prUrl: 'https://github.com/evil/other/pull/1' }))).status).toBe(400);
    expect((await h.migrations(await actionsToken(), sampleMigration({ prUrl: 'https://gitlab.example/acme/api/pull/1' }))).status).toBe(400);
    expect(await h.store.latestMigration(REPO.id)).toBeNull();
  });

  it('is idempotent per workflow run attempt', async () => {
    const h = harness();
    await h.install();
    await h.migrations(await actionsToken(), sampleMigration());
    await h.migrations(await actionsToken(), sampleMigration({ outcome: 'not-verified', verdict: 'failed', prUrl: null }));
    const list = await h.store.listMigrations(REPO.id, 10);
    expect(list.length).toBe(1);
    expect(list[0]!.outcome).toBe('not-verified');
    await h.migrations(await actionsToken({ run_attempt: '2' }), sampleMigration());
    expect((await h.store.listMigrations(REPO.id, 10)).length).toBe(2);
  });

  it('the run page shows the PR and the verdict on the finding it covers', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    await h.migrations(await actionsToken({ run_id: '500' }), sampleMigration());
    const page = await h.app.request('/r/acme/api/runs/1', { headers: { cookie: await h.sessionCookie() } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Latest migration run');
    expect(html).toContain('PR #12 ↗');
    expect(html).toContain('Migration run:');
    expect(html).toContain('What changes in <code>src/client.ts</code>'); // the change itself, shown here
  });

  it('uninstalling the App purges migration reports along with the findings', async () => {
    const h = harness();
    await h.install();
    await h.migrations(await actionsToken(), sampleMigration());
    expect(await h.store.latestMigration(REPO.id)).not.toBeNull();
    await h.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    expect(await h.store.latestMigration(REPO.id)).toBeNull();
  });
});

describe('acknowledgement: who owns a finding', () => {
  // A browser form post: session cookie + urlencoded fields.
  const post = (h: ReturnType<typeof harness>, path: string, fields: Record<string, string>, cookie?: string) =>
    h.app.request(path, {
      method: 'POST',
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  const finding = { provider: 'openai', model: 'gpt-4', back: '/r/acme/api/runs/1' };

  it('a signed-in user acknowledges a finding; it shows on the run page; clearing removes it', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();

    const ack = await post(h, '/r/acme/api/ack', { ...finding, owner: '@acme/platform', note: 'migrating in the Q4 sprint' }, cookie);
    expect(ack.status).toBe(303);
    expect(ack.headers.get('location')).toBe('/r/acme/api/runs/1');
    expect((await h.store.activeAcknowledgements(REPO.id)).get('openai/gpt-4')?.acknowledgedBy).toBe('octocat'); // from the session, never the form
    expect((await h.store.listAuditLog()).some((e) => e.event === 'finding_acknowledged' && e.actor === 'octocat')).toBe(true);

    let html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('Acknowledged by <strong>octocat</strong>');
    expect(html).toContain('@acme/platform');
    expect(html).toContain('migrating in the Q4 sprint');
    expect(html).toContain('1 patch eligible'); // the status did not move

    const clear = await post(h, '/r/acme/api/ack/clear', finding, cookie);
    expect(clear.status).toBe(303);
    expect((await h.store.activeAcknowledgements(REPO.id)).size).toBe(0);
    expect((await h.store.listAuditLog()).some((e) => e.event === 'acknowledgement_cleared')).toBe(true);
    html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).not.toContain('Acknowledged by');
    expect(html).toContain('Acknowledge</button>');
  });

  it('follows the finding across runs and never changes the result', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    await post(h, '/r/acme/api/ack', { ...finding, owner: 'octocat' }, cookie);
    await h.ingest(await actionsToken({ run_id: '100' }), sampleReport()); // the next scan still finds gpt-4
    const html = await (await h.app.request('/r/acme/api/runs/2', { headers: { cookie } })).text();
    expect(html).toContain('Acknowledged by <strong>octocat</strong>');
    expect(html).toContain('1 patch eligible');
  });

  it('a note is capped and escaped, never rendered as markup', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    await post(h, '/r/acme/api/ack', { ...finding, note: `<script>alert(1)</script>${'x'.repeat(1000)}` }, cookie);
    const stored = (await h.store.activeAcknowledgements(REPO.id)).get('openai/gpt-4');
    expect(stored?.note?.length).toBe(400);
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('needs sign-in, GitHub access to the repository, and a named finding', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    expect((await post(h, '/r/acme/api/ack', finding)).status).toBe(302); // anonymous → sign-in
    const noAccess = harness();
    await noAccess.install();
    expect((await post(noAccess, '/r/acme/api/ack', finding, await noAccess.sessionCookie())).status).toBe(404);
    expect((await post(h, '/r/acme/api/ack', { back: '/' }, await h.sessionCookie())).status).toBe(400);
  });

  it('is purged with the repository\'s data — on demand and on uninstall', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    await post(h, '/r/acme/api/ack', finding, cookie);
    const res = await h.app.request('/r/acme/api/delete', { method: 'POST', headers: { cookie } });
    expect(await res.text()).toContain('1 acknowledgement(s)');
    expect((await h.store.activeAcknowledgements(REPO.id)).size).toBe(0);

    const u = harness({ 'acme/api': REPO.id });
    await u.install();
    await post(u, '/r/acme/api/ack', finding, await u.sessionCookie());
    await u.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    expect((await u.store.activeAcknowledgements(REPO.id)).size).toBe(0);
  });
});

describe('approvals: decided in Mendr, carried out by the customer\'s own CI', () => {
  const post = (h: ReturnType<typeof harness>, path: string, fields: Record<string, string>, cookie?: string) =>
    h.app.request(path, {
      method: 'POST',
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  // What the CI run does, proven by its OIDC token.
  const ci = (h: ReturnType<typeof harness>, path: string, token: string, body?: unknown) =>
    h.app.request(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const finding = { provider: 'openai', model: 'gpt-4', replacement: 'gpt-4.1', back: '/r/acme/api/runs/1' };
  const MIGRATE_REF = 'acme/api/.github/workflows/mendr-migrate.yml@refs/heads/main';

  async function approved(mode: 'pr' | 'auto-merge' = 'pr', over: Partial<AppConfig> = {}) {
    const h = harness({ 'acme/api': REPO.id }, over);
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    const res = await post(h, '/r/acme/api/approve', { ...finding, mode }, cookie);
    return { h, cookie, res };
  }

  // Regression: the session was checked BEFORE the form was read, so a click made with an expired
  // session was answered with a redirect to the repository overview — the finding it came from was
  // lost, no approval was created, and nothing said so. It looked like it had worked.
  it('a signed-out Approve click comes back to the REASON it failed, and creates nothing', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const res = await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' }); // no session cookie
    expect(res.status).toBe(302);
    // Anchored on the NOTICE, not the finding. The fragment used to be the finding's, so the
    // browser jumped past the explanation to a card whose Approve button still looked un-clicked
    // -- a page byte-for-byte identical to the one the click was made on. That is the whole
    // difference between "nothing happened" and "your session expired, so nothing was approved".
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent('/r/acme/api/runs/1?signedout=1#signedout')}`);
    expect(await h.store.getApproval(1)).toBeFalsy();
    expect(h.gh.dispatches).toEqual([]);
  });

  // Coming back was only half of it. An Approve button that is simply un-clicked reads exactly like a
  // page never touched, so the finding has to state that the click was lost.
  it('the finding then says out loud that nothing was approved', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    const page = await (await h.app.request('/r/acme/api/runs/1?signedout=1', { headers: { cookie } })).text();
    expect(page).toContain('You were signed out, so nothing was approved');
    const clean = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(clean).not.toContain('You were signed out');
  });

  it('a signed-out Cancel click comes back to the reason too, and cancels nothing', async () => {
    const { h } = await approved();
    const res = await post(h, '/r/acme/api/approve/cancel', { id: '1', back: '/r/acme/api/runs/1#f-openai-gpt-4' }); // no session cookie
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent('/r/acme/api/runs/1?signedout=1#signedout')}`);
    expect((await h.store.getApproval(1))?.status).not.toBe('cancelled');
  });

  it('Approve starts the workflow at once when the App may, and the finding shows it in flight', async () => {
    const { h, cookie, res } = await approved();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/r/acme/api/runs/1');
    expect(h.gh.dispatches).toEqual([{ installationId: INSTALLATION.id, fullName: 'acme/api', repoId: REPO.id, workflowFile: 'mendr-migrate.yml', ref: 'main', inputs: { approval: '1' } }]);
    const a = await h.store.getApproval(1);
    expect(a).toMatchObject({ status: 'queued', approvedBy: 'octocat', mode: 'pr', replacement: 'gpt-4.1' }); // approvedBy from the session, never the form
    expect(a?.dispatchedAt).toBeTruthy();
    expect(a?.events.map((e) => e.stage)).toEqual(['dispatched']);
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('Approved by <strong>octocat</strong>');
    expect(html).toContain('>queued<');
    expect(html).toContain('data-approval="1"');
    expect(html).toContain('Cancel</button>');
    expect(html).not.toContain('Approve migration to gpt-4.1</button>');
    expect((await h.store.listAuditLog()).some((e) => e.event === 'migration_approved' && e.actor === 'octocat')).toBe(true);
  });

  it('without Actions: write the approval waits for the scheduled check — and never names an hour', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    h.gh.api.dispatchWorkflow = async () => {
      throw new GitHubApiError(403, 'GitHub 403 for POST /repos/acme/api/actions/workflows/mendr-migrate.yml/dispatches: Resource not accessible by integration');
    };
    const cookie = await h.sessionCookie();
    expect((await post(h, '/r/acme/api/approve', finding, cookie)).status).toBe(303);
    const a = await h.store.getApproval(1);
    expect(a?.status).toBe('queued');
    expect(a?.dispatchedAt).toBeNull();
    expect(a?.events[0]?.detail).toContain('Actions: write');
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    // GitHub runs scheduled workflows best-effort and drops most of them: measured on mendr-demo,
    // an hourly cron produced 17 runs where 73 were requested, median gap 4.5 hours, worst 7.5.
    // Any number printed here is a promise GitHub never made, so print none.
    expect(html).toContain('scheduled check');
    expect(html).not.toMatch(/within (the hour|three hours)/);
  });

  // The same rule on a public repository. It used to be told "within the hour" because its cron asks
  // for one — but the cron asking is not the same as GitHub running it.
  it('a public repository is not promised an hour either', async () => {
    const h = harness({ 'acme/pub': 999 });
    await h.install();
    await h.webhook('installation_repositories', { action: 'added', installation: INSTALLATION, repositories_added: [{ id: 999, full_name: 'acme/pub', private: false }], repositories_removed: [] });
    await h.ingest(await actionsToken({ repository: 'acme/pub', repository_id: '999' }), sampleReport());
    h.gh.api.dispatchWorkflow = async () => {
      throw new GitHubApiError(403, 'Resource not accessible by integration');
    };
    const cookie = await h.sessionCookie();
    expect((await post(h, '/r/acme/pub/approve', finding, cookie)).status).toBe(303);
    expect((await h.store.getApproval(1))?.events[0]?.detail).toContain('next scheduled check');
    expect((await h.store.getApproval(1))?.events[0]?.detail).not.toContain('hourly');
    const html = await (await h.app.request('/r/acme/pub/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('scheduled check');
    expect(html).not.toMatch(/within (the hour|three hours)/);
    expect(html).not.toContain('within three hours');
  });

  it('the CI carries it out: list → claim → progress → the report closes it as done; the live status agrees', async () => {
    const { h, cookie } = await approved('auto-merge', { autoMerge: true }); // the operator enabled the merge option
    const token = await actionsToken({ run_id: '700', workflow_ref: MIGRATE_REF });
    const listed = (await (await ci(h, '/api/approvals', token)).json()) as { approvals: unknown[] };
    expect(listed.approvals).toEqual([{ id: 1, provider: 'openai', model: 'gpt-4', replacement: 'gpt-4.1', mode: 'auto-merge' }]);
    const repo = await h.store.getRepo(REPO.id);
    expect(repo?.migrateWorkflow).toBe('mendr-migrate.yml'); // learned from the OIDC workflow_ref claim
    expect(repo?.migrateSeenAt).toBeTruthy();

    const claimed = (await (await ci(h, '/api/approvals/claim', token, { ids: [1, 999] })).json()) as { claimed: { id: number }[] };
    expect(claimed.claimed.map((c) => c.id)).toEqual([1]);
    expect((await h.store.getApproval(1))?.status).toBe('running');
    expect((await ci(h, '/api/approvals', token)).status).toBe(200);
    expect(((await (await ci(h, '/api/approvals', token)).json()) as { approvals: unknown[] }).approvals).toEqual([]); // no longer queued

    expect((await ci(h, '/api/approvals/1/events', token, { stage: 'verifying', detail: 'type-check, build, tests on a throwaway copy sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' })).status).toBe(200);
    expect((await ci(h, '/api/approvals/1/events', token, { stage: 'bogus' })).status).toBe(400);
    expect((await ci(h, '/api/approvals/999/events', token, { stage: 'verifying' })).status).toBe(404);
    let a = await h.store.getApproval(1);
    expect(a?.events.map((e) => e.stage)).toEqual(['dispatched', 'claimed', 'verifying']);
    expect(a?.events[2]?.detail).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'); // redacted, like everything else

    const live = (await (await h.app.request('/api/approvals/1', { headers: { cookie } })).json()) as { status: string; version: string };
    expect(live).toMatchObject({ status: 'running', version: 'running:3' });
    let html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('>running<');
    expect(html).toContain('verifying on a throwaway copy');
    expect(html).toContain('Cancel</button>'); // a run that dies without reporting must not block the finding: cancel stays available while running

    // The report from the same run closes it — from what it says, not from an event.
    const rep = await h.migrations(token, sampleMigration());
    expect(((await rep.json()) as { approvals: number[] }).approvals).toEqual([1]);
    a = await h.store.getApproval(1);
    expect(a).toMatchObject({ status: 'done', migrationId: 1, outcome: 'migration-proposed' });
    html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('>done<');
    expect(html).toContain('pull request #12 open');
    expect(html).toContain('migration workflow active');
  });

  it('auto-merge is refused unless the operator enabled it — every beta approval is a pull request for review', async () => {
    const { h, cookie } = await approved('auto-merge');
    expect((await h.store.getApproval(1))?.mode).toBe('pr');
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('pull request for review');
    expect(html).not.toContain('<option value="auto-merge">');
  });

  it('/healthz proves encryption at rest from the outside — counts and a verdict, never data', async () => {
    const h = harness();
    const body = (await (await h.app.request('/healthz')).json()) as { ok: boolean; encryption: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.encryption).toEqual({ enabled: false, sealedRuns: 0, plaintextRuns: 0, sealedMigrations: 0, plaintextMigrations: 0, decrypt: 'none' });
  });

  it('/healthz says 503 and why when the database goes away after boot, never the connection string', async () => {
    const h = harness();
    h.store.encryptionStatus = async () => {
      throw new Error('connect ECONNREFUSED postgres://mendr:hunter2-not-for-logs@db:5432/mendr');
    };
    const res = await h.app.request('/healthz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, db: 'unavailable', error: 'Cannot reach the database at DATABASE_URL. Check the connection string in the Render dashboard.' });
    expect(body.deployment.id).toBeTruthy();
    expect(h.logs).toContain('healthz: database unavailable');
    expect(JSON.stringify(body) + JSON.stringify(h.logEvents)).not.toContain('hunter2-not-for-logs');
  });

  it("/livez, Render's health check, answers without the database, so the probe never keeps a scale-to-zero database awake", async () => {
    const h = harness();
    const touched: string[] = [];
    for (const name of Object.getOwnPropertyNames(MemoryStore.prototype)) {
      if (name === 'constructor') continue;
      (h.store as unknown as Record<string, unknown>)[name] = () => {
        touched.push(name);
        throw new Error('the database is gone');
      };
    }
    const res = await h.app.request('/livez');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(touched).toEqual([]);
    // The database check is still there, on /healthz, for people and monitors.
    expect((await h.app.request('/healthz')).status).toBe(503);
    expect(touched).toEqual(['encryptionStatus']);
  });

  it("render.yaml points Render's health check at /livez, not at the path that queries the database", () => {
    const blueprint = readFileSync(fileURLToPath(new URL('../../render.yaml', import.meta.url)), 'utf8');
    expect(blueprint).toMatch(/^\s*healthCheckPath: \/livez\s*$/m);
  });

  it('a run that could not verify closes the approval as failed and offers the decision again', async () => {
    const { h, cookie } = await approved();
    const token = await actionsToken({ run_id: '701', workflow_ref: MIGRATE_REF });
    await ci(h, '/api/approvals/claim', token, { ids: [1] });
    await h.migrations(token, sampleMigration({ outcome: 'not-verified', prUrl: '', verdict: 'failed', gates: { typeCheck: 'pass', build: 'pass', tests: 'fail', eval: 'not-configured' } }));
    expect((await h.store.getApproval(1))?.status).toBe('failed');
    const html = await (await h.app.request('/r/acme/api/runs/1', { headers: { cookie } })).text();
    expect(html).toContain('Earlier approval by octocat');
    expect(html).toContain('>failed<');
    expect(html).toContain('Approve migration to gpt-4.1</button>');
  });

  it('a queued or running approval can be cancelled (a stuck run must not block the finding), and approving twice keeps one in flight', async () => {
    const { h, cookie } = await approved();
    expect((await post(h, '/r/acme/api/approve', finding, cookie)).status).toBe(303);
    expect((await h.store.listApprovals(REPO.id, 10)).length).toBe(1);
    expect((await post(h, '/r/acme/api/approve/cancel', { id: '1', back: '/r/acme/api/runs/1' }, cookie)).status).toBe(303);
    expect((await h.store.getApproval(1))?.status).toBe('cancelled');
    expect((await h.store.listAuditLog()).some((e) => e.event === 'approval_cancelled')).toBe(true);
    // approve again → #2, claim it, then cancelling does nothing
    await post(h, '/r/acme/api/approve', finding, cookie);
    const token = await actionsToken({ run_id: '702', workflow_ref: MIGRATE_REF });
    await ci(h, '/api/approvals/claim', token, { ids: [2] });
    await post(h, '/r/acme/api/approve/cancel', { id: '2', back: '/' }, cookie);
    expect((await h.store.getApproval(2))?.status).toBe('cancelled'); // the CI run died without reporting; the person moves on
    expect((await post(h, '/r/acme/api/approve', finding, cookie)).status).toBe(303);
    expect((await h.store.getApproval(3))?.status).toBe('queued'); // and can approve again
  });

  it('needs sign-in, access and a named finding; the CI endpoints need a valid token for an installed repository', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    expect((await post(h, '/r/acme/api/approve', finding)).status).toBe(302);
    const noAccess = harness();
    await noAccess.install();
    expect((await post(noAccess, '/r/acme/api/approve', finding, await noAccess.sessionCookie())).status).toBe(404);
    expect((await post(h, '/r/acme/api/approve', { back: '/' }, await h.sessionCookie())).status).toBe(400);
    expect((await h.app.request('/api/approvals')).status).toBe(401);
    expect((await h.app.request('/api/approvals/1')).status).toBe(401);
    const token = await actionsToken({ run_id: '703' });
    expect((await ci(h, '/api/approvals/claim', token, { ids: 'nope' })).status).toBe(400);
    const uninstalled = harness();
    expect((await ci(uninstalled, '/api/approvals', token)).status).toBe(403);
  });

  it('is purged with the repository\'s data', async () => {
    const { h, cookie } = await approved();
    const res = await h.app.request('/r/acme/api/delete', { method: 'POST', headers: { cookie } });
    expect(await res.text()).toContain('1 approval(s)');
    expect(await h.store.getApproval(1)).toBeNull();
  });

  // P1-A CONTAINMENT, items 1-3: every approval attempt leaves a DURABLE, CLASSIFIED,
  // BUILD-STAMPED record — not a console line.
  //
  // Why these exist. The Approve button was dead for 170 runs and then worked, and the cause is
  // still unknown, because the only approval that ever left a durable row was the one that
  // SUCCEEDED (`migration_approved`). Every failure wrote `console.log` and nothing else, and on
  // the host those lines have long since rotated away. P1-A's recorded status is "failure no longer
  // reproduces; root cause unknown; historical telemetry unavailable" — and the third clause is the
  // one that is fixable after the fact. It is fixed by writing the record, not by waiting for the
  // failure to come back.
  describe('an approval attempt that fails is as durable as one that works', () => {
    const DEPLOY: Partial<AppConfig> = { deployCommit: 'abc1234567890', deployInstance: 'srv-7' };
    const failures = async (h: ReturnType<typeof harness>) =>
      (await h.store.listAuditLog()).filter((e) => e.event === 'approval_failed');

    it('records a signed-out click, with its class and the build that served it', async () => {
      const h = harness({ 'acme/api': REPO.id }, DEPLOY);
      await h.install();
      await h.ingest(await actionsToken(), sampleReport());
      await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' }); // no session cookie
      const rows = await failures(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].detail.outcome).toBe('signed_out');
      // Item 2: WHICH build and WHICH instance. Without this, "it works now" cannot be told apart
      // from "it works on the instance that happens to be warm".
      expect(rows[0].detail.deployment).toBe('abc12345@srv-7');
      expect(rows[0].repo).toBe('acme/api');
    });

    it('records a malformed form against the repository, with no model to name', async () => {
      const h = harness({ 'acme/api': REPO.id }, DEPLOY);
      await h.install();
      await h.ingest(await actionsToken(), sampleReport());
      const cookie = await h.sessionCookie();
      await post(h, '/r/acme/api/approve', { back: '/r/acme/api/runs/1' }, cookie); // no provider/model
      const rows = await failures(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].detail.outcome).toBe('malformed_form');
      expect(rows[0].detail.model).toBeNull();
      expect(rows[0].actor).toBe('octocat');
    });

    it('records a duplicate click as its own class, not as a success', async () => {
      const { h, cookie } = await approved('pr', DEPLOY);
      await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' }, cookie); // the second click
      const rows = await failures(h);
      expect(rows.map((r) => r.detail.outcome)).toEqual(['already_in_flight']);
    });

    it('stamps the build on the SUCCESS row too, which is what makes the two comparable', async () => {
      const { h } = await approved('pr', DEPLOY);
      const ok = (await h.store.listAuditLog()).find((e) => e.event === 'migration_approved');
      expect(ok?.detail.deployment).toBe('abc12345@srv-7');
    });

    it('says `unknown` rather than inventing a build when the host supplies none', async () => {
      const h = harness({ 'acme/api': REPO.id }, { deployCommit: null, deployInstance: null });
      await h.install();
      await h.ingest(await actionsToken(), sampleReport());
      await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' });
      expect((await failures(h))[0].detail.deployment).toBe('unknown');
    });

    it('a failed record never costs the click its answer', async () => {
      // The record is diagnostics. If the audit insert throws, the person must still be told what
      // happened — turning a refusal into a 500 because the logging failed would be a worse bug
      // than the one this instrumentation exists to diagnose.
      const h = harness({ 'acme/api': REPO.id }, DEPLOY);
      await h.install();
      await h.ingest(await actionsToken(), sampleReport());
      h.store.appendAuditLog = async () => {
        throw new Error('audit table unavailable');
      };
      const res = await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' });
      expect(res.status).toBe(302); // still the signed-out redirect, not a 500
    });
  });
});

// INSTALL RECOVERY. The App moved to a new, empty database. It learns installations only from
// GitHub's installation webhooks, which GitHub never sends again, so every existing install was
// refused until its account reinstalled the App. Each test here starts in that state: GitHub
// knows the installation (h.gh.world), the store does not.
describe('install recovery: an upload the database cannot place is checked with GitHub before it is refused', () => {
  const NOT_INSTALLED = { error: 'the Mendr GitHub App is not installed on acme/api', install: 'https://github.com/apps/mendr-test/installations/new' };

  /** GitHub has the App installed on acme/api (installation 42); the store has never heard of it. */
  const installedOnGitHub = (h: ReturnType<typeof harness>, over: Partial<WorldInstallation> = {}) => {
    h.gh.world.repos[REPO.full_name] = { id: REPO.id, private: true };
    h.gh.world.installations.push({ id: INSTALLATION.id, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id], ...over });
  };
  const refusal = (h: ReturnType<typeof harness>) => h.logEvents.filter((l) => l.message === 'install recovery refused' || l.message === 'install recovery failed').map((l) => l.extra?.outcome);
  const recoveredEvents = async (h: ReturnType<typeof harness>) => (await h.store.listAuditLog()).filter((e) => e.event === 'installation_recovered');

  it('accepts an upload from an installed repository the store does not know, stores it, and records it in the audit log', async () => {
    const h = harness();
    installedOnGitHub(h);
    // The body names another repository; only the OIDC token's claims are used.
    const res = await h.ingest(await actionsToken(), sampleReport({ repo: 'evil/other' }));
    expect(res.status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ fullName: 'acme/api', installationId: 42, private: true, removedAt: null });
    expect(await h.store.getInstallation(42)).toMatchObject({ accountLogin: 'acme', accountType: 'Organization', suspended: false, deletedAt: null });
    expect(h.gh.checkRuns[0]).toMatchObject({ installationId: 42, fullName: 'acme/api', repoId: REPO.id });
    expect(h.gh.lookups.repoInstallation).toEqual(['acme/api']);
    expect(h.gh.lookups.repoAsInstallation).toEqual([{ installationId: 42, fullName: 'acme/api', repoId: REPO.id }]);
    const events = await recoveredEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ installationId: 42, repo: 'acme/api', actor: 'octocat', detail: { via: 'ci_upload', repositoryId: REPO.id, account: 'acme', installationKnown: false, repositories: 1 } });
    // Known now: the next upload goes through the store, not GitHub.
    expect((await h.ingest(await actionsToken({ run_id: '100' }), sampleReport())).status).toBe(200);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
    expect(await recoveredEvents(h)).toHaveLength(1);
  });

  it('refuses a repository GitHub says is not installed exactly as before, and does not ask GitHub again for a few minutes', async () => {
    const h = harness();
    h.gh.world.repos[REPO.full_name] = { id: REPO.id, private: true }; // exists on GitHub, App not installed
    const first = await h.ingest(await actionsToken(), sampleReport());
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual(NOT_INSTALLED);
    expect(refusal(h)).toEqual(['not_installed']);
    // curl's retries, the next scans and the migration report all meet the cached answer.
    for (const run of ['100', '101', '102']) expect((await h.ingest(await actionsToken({ run_id: run }), sampleReport())).status).toBe(403);
    const mig = await h.migrations(await actionsToken(), sampleMigration());
    expect(mig.status).toBe(403);
    expect(await mig.json()).toEqual(NOT_INSTALLED);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
    expect(h.gh.lookups.repoAsInstallation).toHaveLength(0);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect(await h.store.getInstallation(42)).toBeNull();
    expect(await recoveredEvents(h)).toEqual([]);
    expect(h.gh.checkRuns).toHaveLength(0);

    // Installed on GitHub meanwhile with its webhook lost: the cached answer holds until it expires.
    installedOnGitHub(h);
    expect((await h.ingest(await actionsToken({ run_id: '103' }), sampleReport())).status).toBe(403);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
    h.advance(REFUSAL_TTL_MS + 1);
    expect((await h.ingest(await actionsToken({ run_id: '104' }), sampleReport())).status).toBe(200);
    expect(h.gh.lookups.repoInstallation).toHaveLength(2);
  });

  it('a cached refusal never delays an install GitHub announced by webhook', async () => {
    const h = harness();
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(403);
    await h.install();
    expect((await h.ingest(await actionsToken({ run_id: '100' }), sampleReport())).status).toBe(200);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
  });

  it("refuses when GitHub's id for the named repository is not the token's repository_id", async () => {
    const h = harness();
    // The installation covers both ids, so GitHub mints the token for 9999; but acme/api is 1234.
    h.gh.world.repos['acme/api'] = { id: REPO.id, private: true };
    h.gh.world.repos['acme/other'] = { id: 9999, private: true };
    h.gh.world.installations.push({ id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id, 9999] });
    const res = await h.ingest(await actionsToken({ repository_id: '9999' }), sampleReport());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_INSTALLED);
    expect(refusal(h)).toEqual(['repository_id_mismatch']);
    expect(await h.store.getRepo(9999)).toBeNull();
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect(await h.store.getInstallation(42)).toBeNull();
    expect(await recoveredEvents(h)).toEqual([]);
    // Cached like any other refusal.
    expect((await h.ingest(await actionsToken({ repository_id: '9999', run_id: '100' }), sampleReport())).status).toBe(403);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
  });

  it("refuses when the installation that covers the name does not cover the token's repository id", async () => {
    const h = harness();
    installedOnGitHub(h); // covers 1234 only
    const res = await h.ingest(await actionsToken({ repository_id: '9999' }), sampleReport());
    expect(res.status).toBe(403);
    expect(refusal(h)).toEqual(['repository_not_covered']);
    expect(h.gh.lookups.repoAsInstallation).toEqual([{ installationId: 42, fullName: 'acme/api', repoId: 9999 }]);
    expect(await h.store.getRepo(9999)).toBeNull();
    expect(await h.store.getInstallation(42)).toBeNull();
  });

  // This fake has no token cache and applies the coverage check on every call. The real client
  // is driven through the same path, twice, under "install recovery against the real GitHub
  // client" below.
  it('does not rely on the installation lookup alone: a repository outside the selection is refused at the token', async () => {
    const h = harness();
    h.gh.world.repos[REPO.full_name] = { id: REPO.id, private: true };
    h.gh.world.installations.push({ id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [5678] });
    // Suppose GitHub named the account's installation for a repository its selection leaves out.
    h.gh.api.getRepoInstallation = async () => ({ id: 42, accountLogin: 'acme', accountType: 'Organization', suspended: false });
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_INSTALLED);
    expect(refusal(h)).toEqual(['repository_not_covered']);
    expect(await h.store.getInstallation(42)).toBeNull();
    expect(await h.store.getRepo(REPO.id)).toBeNull();
  });

  it('stores nothing for an installation GitHub reports suspended', async () => {
    const h = harness();
    installedOnGitHub(h, { suspended_at: '2026-10-01T00:00:00Z' });
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_INSTALLED);
    expect(refusal(h)).toEqual(['installation_suspended']);
    expect(h.gh.lookups.repoAsInstallation).toHaveLength(0);
    expect(await h.store.getInstallation(42)).toBeNull();
    expect(await h.store.getRepo(REPO.id)).toBeNull();
  });

  it('never brings back an installation the store holds as uninstalled', async () => {
    const h = harness();
    await h.install();
    await h.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    installedOnGitHub(h); // GitHub still answering with installation 42
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    expect(refusal(h)).toEqual(['installation_deleted']);
    expect((await h.store.getInstallation(42))?.deletedAt).toBeTruthy();
    expect(await h.store.getRepo(REPO.id)).toBeNull();
  });

  it('adds a repository the store lacks to an installation it knows, without rewriting the installation', async () => {
    const h = harness();
    await h.install(); // installation 42 and acme/api, from the webhook
    h.gh.world.repos['acme/web'] = { id: 5678, private: false };
    h.gh.world.installations.push({ id: 42, account: { login: 'acme-renamed', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id, 5678] });
    const res = await h.ingest(await actionsToken({ repository: 'acme/web', repository_id: '5678' }), sampleReport());
    expect(res.status).toBe(200);
    expect(await h.store.getRepo(5678)).toMatchObject({ fullName: 'acme/web', installationId: 42, private: false });
    expect((await h.store.getInstallation(42))?.accountLogin).toBe('acme');
    expect((await recoveredEvents(h))[0]?.detail).toMatchObject({ via: 'ci_upload', installationKnown: true });
  });

  it('a known installation that is suspended still refuses the upload', async () => {
    const h = harness();
    await h.install();
    await h.webhook('installation', { action: 'suspend', installation: INSTALLATION });
    h.gh.world.repos['acme/web'] = { id: 5678, private: false };
    h.gh.world.installations.push({ id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id, 5678] });
    const res = await h.ingest(await actionsToken({ repository: 'acme/web', repository_id: '5678' }), sampleReport());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('the installation covering this repository is suspended');
    expect((await h.store.getInstallation(42))?.suspended).toBe(true);
    expect(await h.store.listRuns(5678, 10)).toEqual([]);
  });

  it("recovers on the migration report and on the migration workflow's approvals check too", async () => {
    const h = harness();
    installedOnGitHub(h);
    expect((await h.migrations(await actionsToken(), sampleMigration())).status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ installationId: 42 });

    const h2 = harness();
    installedOnGitHub(h2);
    const res = await h2.app.request('/api/approvals', { headers: { authorization: `Bearer ${await actionsToken()}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, approvals: [] });
    expect(await h2.store.getRepo(REPO.id)).toMatchObject({ installationId: 42 });

    const h3 = harness(); // not installed: the approvals check answers as before
    const refused = await h3.app.request('/api/approvals', { headers: { authorization: `Bearer ${await actionsToken()}` } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'the Mendr GitHub App is not installed on acme/api' });
  });

  it('a GitHub failure is answered as before and asked again after a minute, not five', async () => {
    const h = harness();
    installedOnGitHub(h);
    const real = h.gh.api.getRepoInstallation;
    h.gh.api.getRepoInstallation = async () => {
      throw new GitHubApiError(502, 'GitHub 502 for GET /repos/acme/api/installation: Bad Gateway');
    };
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_INSTALLED);
    expect(refusal(h)).toEqual(['lookup_failed']);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    h.gh.api.getRepoInstallation = real;
    expect((await h.ingest(await actionsToken({ run_id: '100' }), sampleReport())).status).toBe(403); // still remembered
    h.advance(FAILED_LOOKUP_TTL_MS + 1);
    expect((await h.ingest(await actionsToken({ run_id: '101' }), sampleReport())).status).toBe(200);
  });

  it('a GitHub that never answers does not hold the upload past the lookup deadline, and a late answer is not applied', async () => {
    const h = harness();
    installedOnGitHub(h);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = h.gh.api.getRepoInstallation;
    h.gh.api.getRepoInstallation = async (name) => {
      await gate;
      return real(name);
    };
    const res = await h.ingest(await actionsToken(), sampleReport());
    expect(res.status).toBe(403);
    expect(refusal(h)).toEqual(['lookup_failed']);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect(await h.store.getInstallation(42)).toBeNull();
  });

  it('concurrent uploads for one unknown repository share one lookup', async () => {
    const h = harness();
    installedOnGitHub(h);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = h.gh.api.getRepoInstallation;
    h.gh.api.getRepoInstallation = async (name) => {
      const answer = await real(name);
      await gate;
      return answer;
    };
    const [t1, t2] = await Promise.all([actionsToken({ run_id: '1' }), actionsToken({ run_id: '2' })]);
    const pending = Promise.all([h.ingest(t1, sampleReport()), h.ingest(t2, sampleReport())]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [a, b] = await pending;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.gh.lookups.repoInstallation).toHaveLength(1);
    expect(await recoveredEvents(h)).toHaveLength(1);
  });

  it('does not ask GitHub at all without the App id and private key', async () => {
    const h = harness({}, { githubAppId: null, githubPrivateKey: null });
    installedOnGitHub(h);
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(403);
    expect(h.gh.lookups.repoInstallation).toHaveLength(0);
  });

  it('asks for no new permission: the manifest is unchanged', () => {
    const { config } = harness();
    expect(buildManifest(config).default_permissions).toEqual({ checks: 'write', metadata: 'read' });
  });
});

// The fake above has no token cache. The real client does (for check runs), so these tests run
// install recovery through createGitHubApi itself, on a GitHub-shaped fetch, and recover twice on
// one client. acme/api is public here: GET /repos/acme/api answers any token, so step 3 proves
// nothing about coverage. And GET /repos/acme/api/installation answers installation 42 whatever its
// selection holds: the case step 2, the token mint, exists for.
describe('install recovery against the real GitHub client: coverage is asked on every lookup', () => {
  const API = 'https://api.github.test';
  const { privateKey: appKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** GitHub as seen through fetch. `covered` is installation 42's selection; `mints` records each token request and GitHub's answer. */
  function githubOverFetch() {
    const covered = new Set<number>([REPO.id]);
    const mints: { permissions: Record<string, string>; status: number }[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === '/repos/acme/api/installation') return answer(200, { id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null });
      if (method === 'POST' && path === '/app/installations/42/access_tokens') {
        const body = JSON.parse(String(init.body)) as { repository_ids: number[]; permissions: Record<string, string> };
        const ok = body.repository_ids.every((id) => covered.has(id));
        mints.push({ permissions: body.permissions, status: ok ? 201 : 422 });
        return ok
          ? answer(201, { token: `ghs_${++n}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
          : answer(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
      }
      if (method === 'GET' && path === '/repos/acme/api') return answer(200, { id: REPO.id, full_name: REPO.full_name, private: false });
      if (method === 'POST' && path === '/repos/acme/api/check-runs') return answer(201, { id: 1, html_url: 'https://github.test/acme/api/runs/1' });
      return answer(404, { message: 'Not Found' });
    });
    const metadataMints = () => mints.filter((m) => m.permissions.metadata === 'read').map((m) => m.status);
    return { covered, mints, metadataMints };
  }

  const realHarness = () =>
    harness({}, { githubApiUrl: API, githubPrivateKey: appKey }, { github: (config) => createGitHubApi(config), installLookupTimeoutMs: 10_000 });
  const outcomes = (h: ReturnType<typeof harness>) => h.logEvents.filter((l) => l.message === 'install recovery refused' || l.message === 'install recovery failed').map((l) => l.extra?.outcome);
  const recovered = async (h: ReturnType<typeof harness>) => (await h.store.listAuditLog()).filter((e) => e.event === 'installation_recovered');

  it('a public repository taken out of the selection within the hour is refused, not stored again', async () => {
    const gh = githubOverFetch();
    const h = realHarness();
    // (1) Recovered on a CI upload.
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ installationId: 42, private: false });
    // (2) The owner removes acme/api from the App's selection; the webhook hard-deletes the row.
    gh.covered.delete(REPO.id);
    await h.webhook('installation_repositories', { action: 'removed', installation: INSTALLATION, repositories_added: [], repositories_removed: [REPO] });
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    // (3) Within the hour the repository's own workflow uploads again, and step 1 still names 42.
    const res = await h.ingest(await actionsToken({ run_id: '100' }), sampleReport());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('the Mendr GitHub App is not installed on acme/api');
    expect(outcomes(h)).toEqual(['repository_not_covered']);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect(await h.store.listRuns(REPO.id, 10)).toEqual([]);
    // GitHub was asked to mint a token for the second lookup too, and refused it.
    expect(gh.metadataMints()).toEqual([201, 422]);
    expect(await recovered(h)).toHaveLength(1);
  });

  it('a repository GitHub still covers is recovered again with a new token, not refused', async () => {
    const gh = githubOverFetch();
    const h = realHarness();
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(200);
    // The database loses the row again; GitHub's selection still holds acme/api.
    await h.store.deleteRepoData(REPO.id);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect((await h.ingest(await actionsToken({ run_id: '100' }), sampleReport())).status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ installationId: 42 });
    expect(outcomes(h)).toEqual([]);
    expect(gh.metadataMints()).toEqual([201, 201]);
    expect(await recovered(h)).toHaveLength(2);
  });
});

describe("install recovery: a signed-in overview with nothing to show checks the user's own installations", () => {
  const userInstalled = (h: ReturnType<typeof harness>, over: Partial<WorldInstallation> = {}) => {
    h.gh.world.repos[REPO.full_name] = { id: REPO.id, private: true };
    h.gh.world.installations.push({ id: INSTALLATION.id, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id], userCanAccess: true, ...over });
  };

  it('adds the installations and repositories GitHub says the user can access, and lists them', async () => {
    const h = harness({ 'acme/api': REPO.id });
    userInstalled(h);
    const cookie = await h.sessionCookie();
    const page = await (await h.app.request('/', { headers: { cookie } })).text();
    expect(page).toContain('Set up the audit');
    expect(page).toContain('github.com/acme/api/new/main?filename=');
    expect(await h.store.getRepo(REPO.id)).toMatchObject({ fullName: 'acme/api', installationId: 42 });
    expect(await h.store.getInstallation(42)).toMatchObject({ accountLogin: 'acme', suspended: false, deletedAt: null });
    const events = (await h.store.listAuditLog()).filter((e) => e.event === 'installation_recovered');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ installationId: 42, repo: null, actor: 'octocat', detail: { via: 'sign_in', installationKnown: false, repositories: 1 } });
    // The repository page works too, and a CI upload needs no lookup now.
    expect((await h.app.request('/r/acme/api', { headers: { cookie } })).status).toBe(200);
    expect((await h.ingest(await actionsToken(), sampleReport())).status).toBe(200);
    expect(h.gh.lookups.repoInstallation).toHaveLength(0);
  });

  it('a user who already sees a repository costs no extra GitHub call', async () => {
    const h = harness({ 'acme/api': REPO.id });
    await h.install();
    userInstalled(h);
    await h.app.request('/', { headers: { cookie: await h.sessionCookie() } });
    expect(h.gh.lookups.userInstallations).toBe(0);
  });

  it("reads a user's installations at most once every ten minutes", async () => {
    const h = harness({});
    const cookie = await h.sessionCookie();
    await h.app.request('/', { headers: { cookie } });
    await h.app.request('/', { headers: { cookie } });
    expect(h.gh.lookups.userInstallations).toBe(1);
    h.advance(USER_RECOVERY_INTERVAL_MS + 1);
    await h.app.request('/', { headers: { cookie } });
    expect(h.gh.lookups.userInstallations).toBe(2);
  });

  it('skips suspended installations and ones the store holds as uninstalled, and leaves known repositories alone', async () => {
    // The user can see acme/api and beta/app on GitHub, not gamma/svc, so the overview starts empty.
    const h = harness({ 'acme/api': REPO.id, 'beta/app': 77 });
    // The store: installation 42 uninstalled (acme/api purged); gamma/svc known under installation 50.
    await h.install();
    await h.webhook('installation', { action: 'deleted', installation: INSTALLATION });
    await h.webhook('installation', { action: 'created', installation: { id: 50, account: { login: 'gamma', type: 'Organization' } }, repositories: [{ id: 88, full_name: 'gamma/svc', private: true }] });
    // GitHub: 42 still listed, 43 suspended, 44 covering the gamma/svc the store already knows.
    h.gh.world.repos['acme/api'] = { id: REPO.id, private: true };
    h.gh.world.repos['beta/app'] = { id: 77, private: true };
    h.gh.world.repos['gamma/svc'] = { id: 88, private: true };
    h.gh.world.installations.push(
      { id: 42, account: { login: 'acme', type: 'Organization' }, suspended_at: null, repositoryIds: [REPO.id], userCanAccess: true },
      { id: 43, account: { login: 'beta', type: 'User' }, suspended_at: '2026-10-01T00:00:00Z', repositoryIds: [77], userCanAccess: true },
      { id: 44, account: { login: 'gamma', type: 'Organization' }, suspended_at: null, repositoryIds: [88], userCanAccess: true },
    );
    const page = await (await h.app.request('/', { headers: { cookie: await h.sessionCookie() } })).text();
    expect(page).not.toContain('acme/api');
    expect(page).not.toContain('beta/app');
    expect(h.gh.lookups.userInstallations).toBe(1);
    expect(h.gh.lookups.userInstallationRepos).toEqual([42, 44]); // 43 is suspended: not even read
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect((await h.store.getInstallation(42))?.deletedAt).toBeTruthy();
    expect(await h.store.getRepo(77)).toBeNull();
    expect(await h.store.getInstallation(43)).toBeNull();
    // gamma/svc stays under installation 50, where its webhook put it, and 44 is not created for nothing.
    expect(await h.store.getRepo(88)).toMatchObject({ installationId: 50 });
    expect(await h.store.getInstallation(44)).toBeNull();
    expect((await h.store.listAuditLog()).filter((e) => e.event === 'installation_recovered')).toEqual([]);
  });

  it('a GitHub that never answers still renders the overview, and nothing is written', async () => {
    const h = harness({ 'acme/api': REPO.id });
    userInstalled(h);
    h.gh.api.listUserInstallations = () => new Promise(() => {}); // never settles
    const res = await h.app.request('/', { headers: { cookie: await h.sessionCookie() } });
    expect(res.status).toBe(200);
    expect(await h.store.getRepo(REPO.id)).toBeNull();
    expect(h.logs).toContain('install recovery from sign-in incomplete');
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
    const html = await page.text();
    expect(html).toContain('PATCH ELIGIBLE');
    // the five-part finding structure
    expect(html).toContain('Possible cause');
    expect(html).toContain('Evidence');
    expect(html).toContain('Confidence boundary');
    expect(html).toContain('lbl">Migration<');
    expect(html).toContain('Next action');
    // never overclaims the cause without runtime evidence
    expect(html).toContain('production traffic not measured');
    expect(html).toContain('repository usage confirmed');
    // Open in GitHub: exact blob line link at the scanned sha
    expect(html).toContain(`github.com/acme/api/blob/${'c'.repeat(40)}/src/client.ts#L4`);
    // Rerun audit: the workflow's Actions page
    expect(html).toContain('github.com/acme/api/actions/workflows/mendr-audit.yml');
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

// Every exit from the Approve handler says something, and every one is logged.
//
// It used to log once, at the end, after the dispatch — so the four early returns wrote
// nothing anywhere. A click that died there left the finding looking untouched, the
// approvals list empty, and the Render log holding at best an anonymous stack. That is
// how a real approval came to be reported as "it spun and nothing happened", with no way
// to tell afterwards whether the click had even arrived.
describe('an Approve click that does not create an approval still says so', () => {
  const post = (h: ReturnType<typeof harness>, path: string, fields: Record<string, string>, cookie?: string) =>
    h.app.request(path, {
      method: 'POST',
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  const finding = { provider: 'openai', model: 'gpt-4', replacement: 'gpt-4.1', back: '/r/acme/api/runs/1' };

  it('logs the click on arrival, before anything can fail', async () => {
    const h = harness({ 'acme/api': REPO.id });
    const lines = h.logEvents;
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    await post(h, '/r/acme/api/approve', finding, await h.sessionCookie());
    const clicked = lines.find((l) => l.message === 'approve clicked');
    expect(clicked).toBeDefined();
    expect(clicked?.extra).toMatchObject({ repo: 'acme/api', by: 'octocat' });
  });

  it('a second click while one is in flight is refused OUT LOUD, not with an identical page', async () => {
    // The guard is right; its silence was not. It also reads a different set than the page
    // uses to decide whether to draw the button (`activeApprovals` is queued|running, the
    // page's map is newest-per-model whatever the status), so the button can be on screen
    // while this branch discards the press.
    const h = harness({ 'acme/api': REPO.id });
    const lines = h.logEvents;
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    const cookie = await h.sessionCookie();
    expect((await post(h, '/r/acme/api/approve', finding, cookie)).status).toBe(303);

    const second = await post(h, '/r/acme/api/approve', finding, cookie);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toContain('inflight=1');
    expect(lines.some((l) => l.message === 'approve ignored')).toBe(true);
    // Exactly one approval exists: the guard did its job.
    expect(await h.store.getApproval(2)).toBeNull();

    const html = await (await h.app.request(`/r/acme/api/runs/1?inflight=1`, { headers: { cookie } })).text();
    expect(html).toContain('already has an approval in flight');
    expect(html).toContain('this click changed nothing');
  });

  it('a GitHub access check that never answers is stated, not spun on', async () => {
    // accessibleRepo is an outbound call on a path where a person is watching. Left bare it
    // inherited the shared retry budget -- 30s x 3 plus backoff, about 92 seconds -- and any
    // non-404 failure rethrew into a handler with no try/catch and an app with no onError.
    const h = harness({ 'acme/api': REPO.id });
    const lines = h.logEvents;
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    h.gh.api.getRepoAsUser = () => new Promise(() => {}); // never settles
    const res = await post(h, '/r/acme/api/approve', finding, await h.sessionCookie());
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('GitHub did not answer');
    expect(html).toContain('nothing was approved');
    expect(lines.some((l) => l.message === 'approve failed')).toBe(true);
    expect(await h.store.getApproval(1)).toBeNull();
  });

  it('an unexpected throw anywhere is logged with its route and shown as a sentence', async () => {
    const h = harness({ 'acme/api': REPO.id });
    const lines = h.logEvents;
    await h.install();
    await h.ingest(await actionsToken(), sampleReport());
    h.gh.api.getRepoAsUser = async () => {
      throw new Error('socket hang up');
    };
    const res = await post(h, '/r/acme/api/approve', finding, await h.sessionCookie());
    // The approve path catches its own GitHub failures, so this asserts the STATED outcome
    // rather than reaching onError -- what matters is that the person is told and the event
    // is logged with the repository on it.
    expect([500, 503]).toContain(res.status);
    expect(await res.text()).toContain('nothing was approved');
    const failed = lines.find((l) => l.message === 'approve failed');
    expect(failed?.extra).toMatchObject({ repo: 'acme/api' });
  });

  // The header that lets item 4's smoke test bind an assertion to a BUILD.
  //
  // Reading the commit from /healthz cannot do that: /healthz and the request being judged are two
  // separate requests, and during a rolling deployment they can be served by different instances
  // running different builds. The smoke test would then report "the approve route works on the new
  // build" having actually exercised the old one -- a confident claim about the wrong artifact,
  // which is the failure mode item 4 exists to remove.
  describe('every response carries the build that produced it', () => {
    it('stamps the commit on a redirect, not only on healthz', async () => {
      const h = harness({ 'acme/api': REPO.id }, { deployCommit: 'abc1234567890', deployInstance: 'srv-7' });
      await h.install();
      await h.ingest(await actionsToken(), sampleReport());
      // The signed-out approve POST -- the exact response the smoke job asserts.
      const res = await post(h, '/r/acme/api/approve', { ...finding, mode: 'pr' });
      expect(res.status).toBe(302);
      expect(res.headers.get('x-mendr-deployment-commit')).toBe('abc1234567890');
      expect(res.headers.get('x-mendr-deployment')).toBe('abc12345@srv-7');
    });

    it('omits the commit header entirely when the host supplies none, rather than sending a lie', async () => {
      const h = harness({}, { deployCommit: null, deployInstance: null });
      const res = await h.app.request('/healthz');
      expect(res.headers.get('x-mendr-deployment-commit')).toBeNull();
      // The derived id is still present and honest about not knowing.
      expect(res.headers.get('x-mendr-deployment')).toBe('unknown');
    });

    it('stamps error responses too, so a failure can be attributed to a build', async () => {
      const h = harness({}, { deployCommit: 'deadbeefcafe', deployInstance: 'i-2' });
      const res = await h.app.request('/r/nobody/nothing/runs/1');
      expect(res.headers.get('x-mendr-deployment-commit')).toBe('deadbeefcafe');
    });
  });
});

// P1-A CONTAINMENT, item 4's precondition: /healthz says WHICH BUILD answered.
//
// A post-deploy smoke test that cannot tell builds apart is worse than none — it passes against
// whatever is still serving, which is exactly the "proven on the build it was last tested on"
// failure item 4 exists to close. So the workflow waits for this field to report the commit it
// just deployed before it exercises anything.
describe('healthz names the build that answered', () => {
  it('reports the commit, the instance, and a single legible id', async () => {
    const h = harness({}, { deployCommit: 'abc1234567890', deployInstance: 'srv-7' });
    const body = await (await h.app.request('/healthz')).json();
    expect(body.deployment).toEqual({ commit: 'abc1234567890', instance: 'srv-7', id: 'abc12345@srv-7' });
  });

  it('says `unknown` off-host rather than inventing a build', async () => {
    const h = harness({}, { deployCommit: null, deployInstance: null });
    const body = await (await h.app.request('/healthz')).json();
    expect(body.deployment.id).toBe('unknown');
    expect(body.deployment.commit).toBeNull();
  });

  it('carries no credential — only the two deployment identifiers', async () => {
    // /healthz is unauthenticated. A field added here is public by construction, so this asserts
    // the shape stays exactly the two ids and the derived string, and never grows a secret.
    const h = harness({}, { deployCommit: 'deadbeef', deployInstance: 'i-1', githubPrivateKey: 'pem-secret' });
    const body = await (await h.app.request('/healthz')).json();
    expect(Object.keys(body.deployment).sort()).toEqual(['commit', 'id', 'instance']);
    expect(JSON.stringify(body)).not.toContain('pem-secret');
  });
});
