import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isConfigured, type AppConfig } from './config.js';
import { openSession, sealSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, type Session } from './auth/session.js';
import { GitHubApiError, type GitHubApi } from './github/api.js';
import type { ActionsTokenVerifier } from './github/oidc.js';
import { applyWebhook, verifyWebhookSignature } from './github/webhook.js';
import { buildCheckRun } from './ingest/checkRun.js';
import { countDecisions, sanitizeReport, validateReport } from './ingest/validate.js';
import { prNumber, validateMigrationReport } from './ingest/migrationReport.js';
import { redactSecrets } from './redact.js';
import { APPROVAL_MODES, APPROVAL_STAGES, approvalVersion, type Approval, type ApprovalMode, type ApprovalStage, type Repo, type Store } from './store/types.js';
import { credentialsPage, errorPage, homePage, installedPage, runPage, runsPage, setupPage, workflowRunsUrl } from './ui/pages.js';
import { MENDR_MIGRATE_WORKFLOW_PATH, migrateActionsUrl, setupMigrateWorkflowUrl, setupWorkflowUrl } from './ui/workflowTemplate.js';

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
    const rows: import('./ui/pages.js').RepoRow[] = [];
    if (sess) {
      const [latest, completed] = await Promise.all([store.latestRunPerRepo(), store.latestCompletedRunPerRepo()]);
      for (const repo of (await store.listRepos()).slice(0, 100)) {
        const gh = await github.getRepoAsUser(sess.token, repo.fullName);
        if (gh && gh.id === repo.id) {
          rows.push({ repo, latest: latest.get(repo.id) ?? null, latestCompleted: completed.get(repo.id) ?? null, defaultBranch: gh.defaultBranch });
        }
      }
    }
    return c.html(homePage({ config, configured: isConfigured(config), login: sess?.login ?? null, rows, now: now() }));
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
    if (config.retentionDays > 0) await store.pruneRunsByAge(config.retentionDays);

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
    await store.appendAuditLog({
      event: 'audit_received',
      installationId: repo.installationId,
      repo: claims.repository,
      actor: claims.actor,
      detail: { conclusion: report.conclusion, patch: counts.patch, review: counts.review, informational: counts.informational, sha: sha.slice(0, 7), checkRun: !!checkRun },
    });
    return c.json({ ok: true, run: { id: run.id, url: detailsUrl, conclusion: report.conclusion, counts }, checkRun, checkRunError });
  });

  // --- migrations: what mendr-action did, from the customer's own CI run ---------
  //
  // The action reports its outcome, the PR url, the verdict, the gate statuses,
  // the model swaps and the file paths they touch — NEVER the diff — proven by
  // the run's OIDC token, exactly like the audit. The finding page then shows
  // "PR #12 · verified". This report never resolves anything by itself: the
  // next completed audit is what confirms a resolution.
  app.post('/api/migrations', async (c) => {
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
    const v = validateMigrationReport(await c.req.text(), config.maxBodyBytes);
    if (!v.ok) return c.json({ error: v.message }, v.status);
    const report = v.report;
    // A PR link the dashboard will show must be a pull request of THIS repository
    // on the GitHub this App talks to — never an arbitrary URL from the body.
    if (report.prUrl && !report.prUrl.startsWith(`${config.githubWebUrl}/${claims.repository}/pull/`)) {
      return c.json({ error: `prUrl must be a pull request of ${claims.repository}` }, 400);
    }

    const sha = isSha(report.sha) ? report.sha : claims.sha;
    const rec = await store.saveMigration({
      repoId: repo.id,
      sha,
      ref: claims.ref,
      runId: claims.runId,
      runAttempt: claims.runAttempt,
      workflowRef: claims.workflowRef,
      actor: claims.actor,
      generatedAt: report.generatedAt,
      outcome: report.outcome,
      verdict: report.verdict,
      prUrl: report.prUrl,
      report,
    });
    await store.pruneMigrations(repo.id, config.maxRunsPerRepo);
    if (config.retentionDays > 0) await store.pruneMigrationsByAge(config.retentionDays);
    // Close whatever approval this CI run carried out — from what it reported, never from an event.
    const finished = report.outcome === 'migration-proposed' || report.outcome === 'clean';
    const closed = await store.finishApprovals(repo.id, claims.runId, rec.id, report.outcome, {
      at: now().toISOString(),
      stage: finished ? 'done' : 'failed',
      detail:
        report.outcome === 'migration-proposed'
          ? `pull request ${report.prUrl ? prNumber(report.prUrl) : ''} open · ${report.verdict ?? 'verified'}`.replace(/\s+/g, ' ')
          : report.outcome === 'clean'
            ? 'nothing left to migrate'
            : report.outcome === 'not-verified'
              ? 'not verified — nothing applied, no pull request'
              : 'the migration run failed — nothing applied',
    });
    log('migration', { repo: claims.repository, id: rec.id, outcome: report.outcome, verdict: report.verdict, pr: !!report.prUrl, approvals: closed.length });
    await store.appendAuditLog({
      event: report.outcome === 'migration-proposed' && report.prUrl ? 'pr_created' : 'migration_prepared',
      installationId: repo.installationId,
      repo: claims.repository,
      actor: claims.actor,
      detail: { outcome: report.outcome, verdict: report.verdict, pr: !!report.prUrl, swaps: report.migrations.length, sha: sha.slice(0, 7) },
    });
    return c.json({ ok: true, migration: { id: rec.id, outcome: report.outcome, verdict: report.verdict, prUrl: report.prUrl }, approvals: closed.map((a) => a.id) });
  });

  // --- approvals: decided here, carried out by the customer's own CI ------------
  //
  // An approval is a person's decision on a finding: migrate this model, open a
  // PR (and, if they chose it, merge it when checks pass). The App records it
  // and, when it holds the OPTIONAL `actions: write`, starts the repository's
  // migration workflow at once; otherwise that workflow's own hourly check
  // finds it. Either way the work — verify on a throwaway copy, push one
  // branch, open one PR — happens in the customer's CI with the workflow's
  // token. The App never touches the repository; it records the decision and
  // what the CI streams back, proven by the run's OIDC token like everything else.

  type CiCaller = { claims: Awaited<ReturnType<ActionsTokenVerifier>>; repo: Repo };
  const ciCaller = async (c: Context): Promise<CiCaller | Response> => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) return c.json({ error: 'missing bearer token: send the GitHub Actions OIDC token (permissions: id-token: write)' }, 401);
    let claims: CiCaller['claims'];
    try {
      claims = await deps.verifyActionsToken(m[1]!);
    } catch (e) {
      return c.json({ error: `invalid GitHub Actions token: ${(e as Error).message}` }, 401);
    }
    const repo = await store.getRepo(claims.repositoryId);
    if (!repo || repo.removedAt) return c.json({ error: `the Mendr GitHub App is not installed on ${claims.repository}` }, 403);
    const inst = await store.getInstallation(repo.installationId);
    if (!inst || inst.deletedAt || inst.suspended) return c.json({ error: 'the installation covering this repository is not active' }, 403);
    return { claims, repo };
  };

  /** `mendr-migrate.yml` from an OIDC workflow_ref claim such as `acme/api/.github/workflows/mendr-migrate.yml@refs/heads/main`. */
  const workflowFileOf = (workflowRef: string | null): string | null => {
    const m = workflowRef ? /\.github\/workflows\/([^@/]+)@/.exec(workflowRef) : null;
    return m ? m[1]! : null;
  };

  const brief = (a: Approval) => ({ id: a.id, provider: a.provider, model: a.model, replacement: a.replacement, mode: a.mode });

  // The migration workflow asks: is anything approved for me? (Marks it as listening.)
  app.get('/api/approvals', async (c) => {
    const ci = await ciCaller(c);
    if (ci instanceof Response) return ci;
    await store.markMigrateSeen(ci.repo.id, now().toISOString(), workflowFileOf(ci.claims.workflowRef));
    const queued = [...(await store.activeApprovals(ci.repo.id)).values()].filter((a) => a.status === 'queued');
    return c.json({ ok: true, approvals: queued.map(brief) });
  });

  // The workflow takes the approvals it is about to carry out.
  app.post('/api/approvals/claim', async (c) => {
    const ci = await ciCaller(c);
    if (ci instanceof Response) return ci;
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is number => Number.isInteger(x) && (x as number) > 0).slice(0, 100) : [];
    if (!ids.length) return c.json({ error: 'ids must be a non-empty array of approval ids' }, 400);
    const at = now().toISOString();
    await store.markMigrateSeen(ci.repo.id, at, workflowFileOf(ci.claims.workflowRef));
    const claimed = await store.claimApprovals(ci.repo.id, ids, ci.claims.runId, { at, stage: 'claimed', detail: `picked up by your CI (run ${ci.claims.runId})` });
    return c.json({ ok: true, claimed: claimed.map(brief) });
  });

  // Progress, one stage at a time, with a short redacted line — never code.
  app.post('/api/approvals/:id/events', async (c) => {
    const ci = await ciCaller(c);
    if (ci instanceof Response) return ci;
    const approval = await store.getApproval(Number(c.req.param('id')));
    if (!approval || approval.repoId !== ci.repo.id) return c.json({ error: 'no such approval for this repository' }, 404);
    const body = (await c.req.json().catch(() => null)) as { stage?: unknown; detail?: unknown } | null;
    const stage = typeof body?.stage === 'string' && (APPROVAL_STAGES as readonly string[]).includes(body.stage) ? (body.stage as ApprovalStage) : null;
    if (!stage) return c.json({ error: `stage must be one of ${APPROVAL_STAGES.join(', ')}` }, 400);
    const detail = typeof body?.detail === 'string' && body.detail.trim() ? redactSecrets(body.detail.trim().slice(0, 400)) : null;
    await store.appendApprovalEvent(approval.id, { at: now().toISOString(), stage, detail });
    return c.json({ ok: true });
  });

  // The finding page polls this while an approval is in flight (same sign-in and access as the page).
  app.get('/api/approvals/:id', async (c) => {
    const sess = await session(c);
    if (!sess) return c.json({ error: 'sign in' }, 401);
    const approval = await store.getApproval(Number(c.req.param('id')));
    const repo = approval ? await store.getRepo(approval.repoId) : null;
    if (!approval || !repo || !(await accessibleRepo(sess, repo.fullName))) return c.json({ error: 'not found' }, 404);
    return c.json({ ...brief(approval), status: approval.status, version: approvalVersion(approval), migrationId: approval.migrationId, outcome: approval.outcome, events: approval.events });
  });

  const approveForm = async (c: Context): Promise<{ provider: string; model: string; replacement: string | null; mode: ApprovalMode; back: string } | null> => {
    const form = await c.req.parseBody();
    const field = (key: string, max: number): string => {
      const v = form[key];
      return typeof v === 'string' ? v.trim().slice(0, max) : '';
    };
    const provider = field('provider', 64);
    const model = field('model', 128);
    if (!provider || !model) return null;
    const modeRaw = field('mode', 16);
    const mode: ApprovalMode = (APPROVAL_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as ApprovalMode) : 'pr';
    return { provider, model, replacement: field('replacement', 128) || null, mode, back: safeNext(field('back', 300)) };
  };

  const dispatchRefusal = (e: unknown): string => {
    if (e instanceof GitHubApiError) {
      if (e.status === 404) return 'no migration workflow was found in the repository — add it once (see the Migration card) and its hourly check will pick this up';
      if (e.status === 403 || e.status === 422) return 'Mendr may not start workflows here yet (grant the App "Actions: write" for instant starts); your CI picks it up on its next hourly check';
      return `GitHub answered ${e.status}; your CI picks it up on its next hourly check`;
    }
    return 'your CI picks it up on its next hourly check';
  };

  app.post('/r/:owner/:name/approve', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(`/r/${fullName}`)}`);
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const f = await approveForm(c);
    if (!f) return c.html(errorPage('Bad request', 'An approval names the provider and model of the finding it is about.'), 400);
    const key = `${f.provider}/${f.model}`;
    // One in flight per finding: a second click while it runs changes nothing.
    if ((await store.activeApprovals(repo.id)).has(key)) return c.redirect(f.back, 303);
    const approval = await store.createApproval({ repoId: repo.id, provider: f.provider, model: f.model, replacement: f.replacement, mode: f.mode, approvedBy: sess.login });
    const at = now().toISOString();
    let dispatched = false;
    let why = 'your CI picks it up on its next hourly check';
    if (isConfigured(config)) {
      const gh = await github.getRepoAsUser(sess.token, fullName);
      const file = repo.migrateWorkflow ?? MENDR_MIGRATE_WORKFLOW_PATH.split('/').pop()!;
      try {
        await github.dispatchWorkflow(repo.installationId, fullName, repo.id, file, gh?.defaultBranch ?? 'main', { approval: String(approval.id) });
        dispatched = true;
      } catch (e) {
        why = dispatchRefusal(e);
      }
    }
    if (dispatched) await store.markApprovalDispatched(approval.id, { at, stage: 'dispatched', detail: 'Mendr started your migration workflow' });
    else await store.appendApprovalEvent(approval.id, { at, stage: 'queued', detail: why });
    log('migration approved', { repo: fullName, by: sess.login, model: key, mode: f.mode, dispatched });
    await store.appendAuditLog({
      event: 'migration_approved',
      installationId: repo.installationId,
      repo: fullName,
      actor: sess.login,
      detail: { approval: approval.id, provider: f.provider, model: f.model, replacement: f.replacement, mode: f.mode, dispatched },
    });
    return c.redirect(f.back, 303);
  });

  app.post('/r/:owner/:name/approve/cancel', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(`/r/${fullName}`)}`);
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const form = await c.req.parseBody();
    const id = Number(form.id);
    const back = safeNext(typeof form.back === 'string' ? form.back : '/');
    const approval = Number.isInteger(id) ? await store.getApproval(id) : null;
    if (!approval || approval.repoId !== repo.id) return c.html(errorPage('Not found', 'No such approval is visible to you here.'), 404);
    const cancelled = await store.cancelApproval(id, { at: now().toISOString(), stage: 'cancelled', detail: `cancelled by ${sess.login}` });
    if (cancelled) {
      await store.appendAuditLog({ event: 'approval_cancelled', installationId: repo.installationId, repo: fullName, actor: sess.login, detail: { approval: id, provider: approval.provider, model: approval.model } });
    }
    return c.redirect(back, 303);
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

  // --- read API (JSON; the run page's "Evidence JSON" link) ------------------------

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
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const runs = await store.listRuns(repo.id, 50);
    // Only build the one-click setup link when there is nothing to show yet.
    let setupUrl: string | undefined;
    if (runs.length === 0 && isConfigured(config)) {
      const gh = await github.getRepoAsUser(sess.token, fullName);
      setupUrl = setupWorkflowUrl({
        webUrl: config.githubWebUrl,
        repoFullName: fullName,
        appUrl: config.appUrl,
        audience: config.oidcAudience,
        mendrSpec: config.mendrSpec,
        defaultBranch: gh?.defaultBranch ?? 'main',
      });
    }
    return c.html(runsPage(repo, runs, sess.login, setupUrl));
  });

  app.get('/r/:owner/:name/runs/:id', async (c) => {
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const repo = await accessibleRepo(sess, fullName);
    const run = repo ? await store.getRun(Number(c.req.param('id'))) : null;
    if (!repo || !run || run.repoId !== repo.id) return c.html(errorPage('Not found', 'No such run is visible to you here.'), 404);
    // "Prepare migration for review": the one-click migration workflow (GitHub's
    // prefilled editor) and its Actions page. Both run in the customer's CI with
    // the workflow's own token; the App writes nothing and needs no new scope.
    let migrate: { setupUrl: string; runUrl: string } | undefined;
    if (isConfigured(config)) {
      const gh = await github.getRepoAsUser(sess.token, fullName);
      migrate = {
        setupUrl: setupMigrateWorkflowUrl({ webUrl: config.githubWebUrl, repoFullName: fullName, defaultBranch: gh?.defaultBranch ?? 'main', mendrSpec: config.mendrSpec, appUrl: config.appUrl, private: repo.private }),
        runUrl: migrateActionsUrl(config.githubWebUrl, fullName),
      };
    }
    // What mendr-action last reported for this repo, and the run before this one:
    // a resolution is only ever claimed by comparing completed scans.
    const [migration, runs, acks, approvalList] = await Promise.all([
      store.latestMigration(repo.id),
      store.listRuns(repo.id, 50),
      store.activeAcknowledgements(repo.id),
      store.listApprovals(repo.id, 100),
    ]);
    // The latest approval per finding, whatever its status: in flight, done, failed or cancelled are all shown, never hidden.
    const approvals = new Map<string, Approval>();
    for (const a of approvalList) {
      const key = `${a.provider}/${a.model}`;
      if (!approvals.has(key)) approvals.set(key, a);
    }
    const idx = runs.findIndex((r) => r.id === run.id);
    const prevSummary = idx >= 0 ? runs[idx + 1] : undefined;
    const previous = prevSummary ? await store.getRun(prevSummary.id) : null;
    return c.html(
      runPage(repo, run, sess.login, {
        webUrl: config.githubWebUrl,
        workflowUrl: workflowRunsUrl(config.githubWebUrl, repo.fullName),
        migrate,
        migration,
        previous,
        acks,
        approvals,
        migrateSeenAt: repo.migrateSeenAt,
        now: now(),
      }),
    );
  });

  // Acknowledgement: a signed-in person with access says "seen — X owns this".
  // It is a note ABOUT a finding, keyed by repository + model so it follows the
  // finding across runs. It never changes the finding's status — only a
  // completed scan can — and clearing it is one click. Same CSRF reasoning as
  // deletion below: SameSite=Lax keeps a cross-site POST from carrying the session.
  const ackForm = async (c: Context): Promise<{ provider: string; model: string; owner: string | null; note: string | null; back: string } | null> => {
    const form = await c.req.parseBody();
    const field = (key: string, max: number): string => {
      const v = form[key];
      return typeof v === 'string' ? v.trim().slice(0, max) : '';
    };
    const provider = field('provider', 64);
    const model = field('model', 128);
    if (!provider || !model) return null;
    return { provider, model, owner: field('owner', 80) || null, note: field('note', 400) || null, back: safeNext(field('back', 300)) };
  };

  app.post('/r/:owner/:name/ack', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(`/r/${fullName}`)}`);
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const f = await ackForm(c);
    if (!f) return c.html(errorPage('Bad request', 'An acknowledgement names the provider and model of the finding it is about.'), 400);
    await store.acknowledge({ repoId: repo.id, provider: f.provider, model: f.model, acknowledgedBy: sess.login, owner: f.owner, note: f.note });
    // The note is free text typed by a person: it stays out of the audit log.
    await store.appendAuditLog({ event: 'finding_acknowledged', installationId: repo.installationId, repo: fullName, actor: sess.login, detail: { provider: f.provider, model: f.model, owner: f.owner } });
    return c.redirect(f.back, 303);
  });

  app.post('/r/:owner/:name/ack/clear', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(`/r/${fullName}`)}`);
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const f = await ackForm(c);
    if (!f) return c.html(errorPage('Bad request', 'An acknowledgement names the provider and model of the finding it is about.'), 400);
    const cleared = await store.clearAcknowledgement(repo.id, f.provider, f.model, sess.login);
    if (cleared) {
      await store.appendAuditLog({ event: 'acknowledgement_cleared', installationId: repo.installationId, repo: fullName, actor: sess.login, detail: { provider: f.provider, model: f.model } });
    }
    return c.redirect(f.back, 303);
  });

  // Self-service deletion: a signed-in user with access can delete this repo's
  // stored findings now, without uninstalling. SameSite=Lax blocks a cross-site
  // POST from carrying the session, so this needs no separate CSRF token.
  app.post('/r/:owner/:name/delete', async (c) => {
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(`/r/${c.req.param('owner')}/${c.req.param('name')}`)}`);
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    const gone = await store.deleteRepoData(repo.id);
    log('data deleted', { repo: fullName, by: sess.login, ...gone });
    await store.appendAuditLog({
      event: 'data_deleted',
      installationId: repo.installationId,
      repo: fullName,
      actor: sess.login,
      detail: { ...gone, via: 'self-service' },
    });
    return c.html(
      errorPage(
        'Deleted',
        `Removed ${gone.runsDeleted} stored run(s), ${gone.migrationsDeleted} migration report(s), ${gone.acknowledgementsDeleted} acknowledgement(s) and ${gone.approvalsDeleted} approval(s) for ${fullName}. Nothing of this repository's findings remains. Re-run the audit to repopulate.`,
      ),
    );
  });

  // The pre-App JSON-import prototype ("investigation workspace") used to be served
  // at /app/. It is gone: the run page is the evidence view. The marketing site
  // redirects its old /app URL here.
  app.get('/app', (c) => c.redirect('/'));
  app.get('/app/', (c) => c.redirect('/'));

  return app;
}
