import { createHmac } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildManifest, createApp } from './app.js';
import { sealSession, SESSION_COOKIE } from './auth/session.js';
import { loadConfig, type AppConfig } from './config.js';
import type { CheckRunPayload } from './ingest/checkRun.js';
import { sampleReport } from '../test/sampleReport.js';
import { GitHubApiError, type GitHubApi } from './github/api.js';
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
  const dispatches: { installationId: number; fullName: string; repoId: number; workflowFile: string; ref: string; inputs: Record<string, string> }[] = [];
  const api: GitHubApi = {
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
  return { api, checkRuns, dispatches };
}

function harness(userRepos: Record<string, number> = {}, over: Partial<AppConfig> = {}) {
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
  const migrations = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/migrations', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const sessionCookie = async () => `${SESSION_COOKIE}=${await sealSession({ userId: 7, login: 'octocat', token: 'user-token', exp: Math.floor(Date.now() / 1000) + 3600 }, config.sessionSecret)}`;
  return { app, store, gh, config, logs, webhook, install, ingest, migrations, sessionCookie };
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

  it('without Actions: write the approval waits for the workflow\'s hourly check — and says so', async () => {
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
    expect(html).toContain('within the hour');
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
    expect(html).not.toContain('Cancel</button>'); // too late to cancel

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

  it('a queued approval can be cancelled, a running one cannot, and approving twice keeps one in flight', async () => {
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
    expect((await h.store.getApproval(2))?.status).toBe('running');
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
