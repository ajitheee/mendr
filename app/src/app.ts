import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isConfigured, type AppConfig } from './config.js';
import { openSession, sealSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, type Session } from './auth/session.js';
import type { GitHubApi } from './github/api.js';
import type { ActionsTokenVerifier } from './github/oidc.js';
import { applyWebhook, verifyWebhookSignature } from './github/webhook.js';
import { buildCheckRun } from './ingest/checkRun.js';
import { countDecisions, sanitizeReport, validateReport } from './ingest/validate.js';
import type { Repo, Store } from './store/types.js';
import { credentialsPage, errorPage, homePage, installedPage, runPage, runsPage, setupPage } from './ui/pages.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  github: GitHubApi;
  verifyActionsToken: ActionsTokenVerifier;
  now?: () => Date;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const SETUP_STATE_COOKIE = 'mendr_setup_state';
const LOGIN_STATE_COOKIE = 'mendr_login_state';
const NEXT_COOKIE = 'mendr_next';

/** The GitHub App manifest: least privilege, stated once, reviewable before creation. */
export function buildManifest(config: AppConfig): Record<string, unknown> {
  return {
    name: config.githubAppName,
    url: 'https://github.com/ajitheee/mendr',
    description: 'Receives Mendr audit evidence from your own CI run and writes a check run. Never reads repository contents.',
    hook_attributes: { url: `${config.appUrl}/webhooks/github`, active: true },
    redirect_url: `${config.appUrl}/setup/callback`,
    callback_urls: [`${config.appUrl}/auth/callback`],
    setup_url: `${config.appUrl}/setup/installed`,
    setup_on_update: false,
    public: true,
    // checks:write to write the audit result on the commit; metadata:read is
    // mandatory for every App. No contents, no pull_requests, no issues.
    default_permissions: { checks: 'write', metadata: 'read' },
    default_events: [],
  };
}

function safeNext(v: string | undefined): string {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, github } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, extra) => console.log(extra ? `${message} ${JSON.stringify(extra)}` : message));
  const app = new Hono();
  const secure = config.appUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' };

  const session = async (c: Context): Promise<Session | null> => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (!raw) return null;
    const s = await openSession(raw, config.sessionSecret);
    return s && s.exp * 1000 > now().getTime() ? s : null;
  };

  /**
   * A repository is visible to a signed-in user only if the App is installed
   * on it AND GitHub says the user can see it. Existence is never revealed to
   * anyone else: every failure is a 404.
   */
  const accessibleRepo = async (sess: Session, fullName: string): Promise<Repo | null> => {
    const repo = await store.getRepoByName(fullName);
    if (!repo || repo.removedAt) return null;
    const gh = await github.getRepoAsUser(sess.token, fullName);
    return gh && gh.id === repo.id ? repo : null;
  };

  // --- status ---------------------------------------------------------------

  app.get('/healthz', (c) => c.json({ ok: true, configured: isConfigured(config), store: store.kind }));

  app.get('/', async (c) => {
    const sess = await session(c);
    const rows: { repo: Repo; latest: import('./store/types.js').RunSummary | null }[] = [];
    if (sess) {
      const latest = await store.latestRunPerRepo();
      for (const repo of (await store.listRepos()).slice(0, 100)) {
        const gh = await github.getRepoAsUser(sess.token, repo.fullName);
        if (gh && gh.id === repo.id) rows.push({ repo, latest: latest.get(repo.id) ?? null });
      }
    }
    return c.html(homePage({ config, configured: isConfigured(config), login: sess?.login ?? null, rows }));
  });

  // --- setup: create the App from its manifest --------------------------------

  app.get('/setup', (c) => {
    const state = randomBytes(16).toString('hex');
    setCookie(c, SETUP_STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    const org = c.req.query('org');
    const target = org && /^[A-Za-z0-9-]+$/.test(org) ? `${config.githubWebUrl}/organizations/${org}/settings/apps/new?state=${state}` : `${config.githubWebUrl}/settings/apps/new?state=${state}`;
    return c.html(setupPage({ manifest: JSON.stringify(buildManifest(config)), target, configured: isConfigured(config), appUrl: config.appUrl }));
  });

  app.get('/setup/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const expected = getCookie(c, SETUP_STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) {
      return c.html(errorPage('Setup state mismatch', 'Start again from /setup so the request can be tied to this browser.'), 400);
    }
    deleteCookie(c, SETUP_STATE_COOKIE, cookieOpts);
    try {
      const creds = await github.convertManifest(code);
      log('github app created', { id: creds.id, slug: creds.slug });
      return c.html(credentialsPage(creds));
    } catch (e) {
      return c.html(errorPage('Could not convert the manifest', (e as Error).message), 502);
    }
  });

  app.get('/setup/installed', (c) => c.html(installedPage(config)));

  // --- webhooks: the tenant boundary ------------------------------------------

  app.post('/webhooks/github', async (c) => {
    if (!config.githubWebhookSecret) return c.json({ error: 'webhook secret not configured' }, 503);
    const raw = await c.req.text();
    if (!verifyWebhookSignature(config.githubWebhookSecret, raw, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    const event = c.req.header('x-github-event') ?? '';
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'body is not JSON' }, 400);
    }
    const outcome = await applyWebhook(store, event, payload, now().toISOString());
    log('webhook', { event, outcome });
    return c.json({ ok: true, outcome });
  });

  // --- ingest: evidence from the customer's own CI run -------------------------

  app.post('/api/ingest', async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) return c.json({ error: 'missing bearer token: send the GitHub Actions OIDC token (permissions: id-token: write)' }, 401);
    let claims;
    try {
      claims = await deps.verifyActionsToken(m[1]!);
    } catch (e) {
      return c.json({ error: `invalid GitHub Actions token: ${(e as Error).message}` }, 401);
    }

    const repo = await store.getRepo(claims.repositoryId);
    if (!repo || repo.removedAt) {
      const installUrl = config.githubAppSlug ? `${config.githubWebUrl}/apps/${config.githubAppSlug}/installations/new` : null;
      return c.json({ error: `the Mendr GitHub App is not installed on ${claims.repository}`, install: installUrl }, 403);
    }
    const inst = await store.getInstallation(repo.installationId);
    if (!inst || inst.deletedAt) return c.json({ error: 'the installation covering this repository was removed' }, 403);
    if (inst.suspended) return c.json({ error: 'the installation covering this repository is suspended' }, 403);

    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) return c.json({ error: `report exceeds ${config.maxBodyBytes} bytes` }, 413);
    const raw = await c.req.text();
    const v = validateReport(raw, config.maxBodyBytes);
    if (!v.ok) return c.json({ error: v.message }, v.status);

    // Never trust client-side sanitation: redact and cap again here.
    const report = sanitizeReport(v.report);
    const counts = countDecisions(report);
    if (repo.fullName !== claims.repository) await store.upsertRepos(repo.installationId, [{ id: repo.id, fullName: claims.repository, private: repo.private }]);

    // For pull_request events the token's sha is the merge commit; the workflow
    // passes the head sha through `mendr audit --sha` so the check lands on the PR.
    const sha = isSha(report.sha) ? report.sha : claims.sha;
    const run = await store.saveRun({
      repoId: repo.id,
      sha,
      ref: claims.ref,
      runId: claims.runId,
      runAttempt: claims.runAttempt,
      workflowRef: claims.workflowRef,
      actor: claims.actor,
      generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : null,
      conclusion: report.conclusion,
      counts,
      report,
      checkRunUrl: null,
    });
    await store.pruneRuns(repo.id, config.maxRunsPerRepo);

    const detailsUrl = `${config.appUrl}/r/${claims.repository}/runs/${run.id}`;
    let checkRun: string | null = null;
    let checkRunError: string | null = null;
    try {
      const payload = buildCheckRun(report, { sha, detailsUrl, externalId: `${repo.id}:${claims.runId}:${claims.runAttempt}` });
      const res = await github.createCheckRun(repo.installationId, claims.repository, repo.id, payload);
      await store.setRunCheckUrl(run.id, res.html_url);
      checkRun = res.html_url;
    } catch (e) {
      checkRunError = (e as Error).message;
      log('check run failed', { repo: claims.repository, error: checkRunError });
    }
    log('ingest', { repo: claims.repository, run: run.id, sha: sha.slice(0, 7), counts, conclusion: report.conclusion, checkRun: !!checkRun });
    return c.json({ ok: true, run: { id: run.id, url: detailsUrl, conclusion: report.conclusion, counts }, checkRun, checkRunError });
  });

  // --- sign-in ------------------------------------------------------------------

  app.get('/auth/login', (c) => {
    if (!config.githubClientId) return c.html(errorPage('Sign-in unavailable', 'The App is not configured yet (GITHUB_CLIENT_ID).'), 503);
    const state = randomBytes(16).toString('hex');
    setCookie(c, LOGIN_STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    setCookie(c, NEXT_COOKIE, safeNext(c.req.query('next')), { ...cookieOpts, maxAge: 600 });
    const url = new URL(`${config.githubWebUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', config.githubClientId);
    url.searchParams.set('redirect_uri', `${config.appUrl}/auth/callback`);
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const expected = getCookie(c, LOGIN_STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) return c.html(errorPage('Sign-in state mismatch', 'Start again from the sign-in link.'), 400);
    deleteCookie(c, LOGIN_STATE_COOKIE, cookieOpts);
    const next = safeNext(getCookie(c, NEXT_COOKIE));
    deleteCookie(c, NEXT_COOKIE, cookieOpts);
    try {
      const tok = await github.exchangeOAuthCode(code);
      const user = await github.getViewer(tok.accessToken);
      const nowSec = Math.floor(now().getTime() / 1000);
      const tokenExp = tok.expiresAt ? Math.floor(Date.parse(tok.expiresAt) / 1000) : Infinity;
      const exp = Math.min(nowSec + SESSION_MAX_AGE_SECONDS, tokenExp);
      const sealed = await sealSession({ userId: user.id, login: user.login, token: tok.accessToken, exp }, config.sessionSecret);
      setCookie(c, SESSION_COOKIE, sealed, { ...cookieOpts, maxAge: Math.max(60, exp - nowSec) });
      return c.redirect(next);
    } catch (e) {
      return c.html(errorPage('Sign-in failed', (e as Error).message), 502);
    }
  });

  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return c.redirect('/');
  });

  // --- read API (for the workspace) --------------------------------------------

  app.get('/api/me', async (c) => {
    const sess = await session(c);
    return sess ? c.json({ login: sess.login, id: sess.userId }) : c.json({ error: 'sign in required' }, 401);
  });

  app.get('/api/repos', async (c) => {
    const sess = await session(c);
    if (!sess) return c.json({ error: 'sign in required' }, 401);
    const latest = await store.latestRunPerRepo();
    const out = [];
    for (const repo of (await store.listRepos()).slice(0, 100)) {
      const gh = await github.getRepoAsUser(sess.token, repo.fullName);
      if (gh && gh.id === repo.id) out.push({ id: repo.id, fullName: repo.fullName, private: repo.private, latest: latest.get(repo.id) ?? null });
    }
    return c.json({ repos: out });
  });

  app.get('/api/repos/:owner/:name/runs', async (c) => {
    const sess = await session(c);
    if (!sess) return c.json({ error: 'sign in required' }, 401);
    const repo = await accessibleRepo(sess, `${c.req.param('owner')}/${c.req.param('name')}`);
    if (!repo) return c.json({ error: 'not found' }, 404);
    return c.json({ repo: { id: repo.id, fullName: repo.fullName }, runs: await store.listRuns(repo.id, 50) });
  });

  app.get('/api/runs/:id', async (c) => {
    const sess = await session(c);
    if (!sess) return c.json({ error: 'sign in required' }, 401);
    const run = await store.getRun(Number(c.req.param('id')));
    const repo = run ? await store.getRepo(run.repoId) : null;
    if (!run || !repo || !(await accessibleRepo(sess, repo.fullName))) return c.json({ error: 'not found' }, 404);
    return c.json({ repo: { id: repo.id, fullName: repo.fullName }, run });
  });

  // --- HTML views -----------------------------------------------------------------

  app.get('/r/:owner/:name', async (c) => {
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
    const repo = await accessibleRepo(sess, `${c.req.param('owner')}/${c.req.param('name')}`);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    return c.html(runsPage(repo, await store.listRuns(repo.id, 50), sess.login));
  });

  app.get('/r/:owner/:name/runs/:id', async (c) => {
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
    const repo = await accessibleRepo(sess, `${c.req.param('owner')}/${c.req.param('name')}`);
    const run = repo ? await store.getRun(Number(c.req.param('id'))) : null;
    if (!repo || !run || run.repoId !== repo.id) return c.html(errorPage('Not found', 'No such run is visible to you here.'), 404);
    return c.html(runPage(repo, run, sess.login));
  });

  // --- the static investigation workspace (site/app) -------------------------------

  app.get('/app', (c) => c.redirect('/app/'));
  app.get('/app/', async (c) => {
    if (!config.uiDir) return c.text('UI_DIR is not set; the investigation workspace is not served from this deployment.', 404);
    try {
      return c.html(await readFile(join(config.uiDir, 'index.html'), 'utf8'));
    } catch {
      return c.text('the investigation workspace file was not found', 404);
    }
  });

  return app;
}
