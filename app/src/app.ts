import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { deploymentId, isConfigured, type AppConfig } from './config.js';
import { openSession, sealSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, type Session } from './auth/session.js';
import { GitHubApiError, type GitHubApi } from './github/api.js';
import type { ActionsTokenVerifier } from './github/oidc.js';
import { applyWebhook, verifyWebhookSignature } from './github/webhook.js';
import { buildCheckRun } from './ingest/checkRun.js';
import { countDecisions, sanitizeReport, validateReport } from './ingest/validate.js';
import { prNumber, validateMigrationReport } from './ingest/migrationReport.js';
import { migrationWorkflowFile } from './ingest/migration.js';
import { redactSecrets } from './redact.js';
import { APPROVAL_STAGES, approvalVersion, type Approval, type ApprovalMode, type ApprovalOutcome, type ApprovalStage, type EncryptionStatus, type Repo, type Store } from './store/types.js';
import { credentialsPage, errorPage, homePage, installedPage, runPage, runsPage, setupPage, workflowRunsUrl } from './ui/pages.js';
import { MENDR_MIGRATE_WORKFLOW_PATH, migrateActionsUrl, setupMigrateWorkflowUrl, setupWorkflowUrl } from './ui/workflowTemplate.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  github: GitHubApi;
  verifyActionsToken: ActionsTokenVerifier;
  now?: () => Date;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /**
   * Deadline for an outbound call made while a person is watching a spinner.
   * Defaults to {@link INTERACTIVE_GITHUB_MS}; overridden in tests so asserting the
   * timeout does not cost the suite eight real seconds.
   */
  interactiveTimeoutMs?: number;
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

/**
 * Mark the return path AND send the browser to the explanation rather than to the finding.
 *
 * The redirect used to keep the caller's fragment on purpose, and `back` always carries one
 * (`#f-<provider>-<model>`, set on the card). The notice, meanwhile, renders at the top of
 * the page. So the flag arrived, the notice rendered — and the browser jumped straight past
 * it to the finding, which still showed an un-clicked Approve button.
 *
 * The page a person gets back is then byte-for-byte the page they left, with the reason
 * scrolled off the top of the viewport. That is how "your session expired, so nothing was
 * approved" reads as "it spun and nothing happened": the App did say it, somewhere the
 * browser was instructed not to look.
 *
 * Anchoring on the notice keeps the finding immediately below it, because the notice sits
 * directly above the list it is about — the reader loses nothing and gains the sentence.
 */
function atNotice(path: string, flag: string): string {
  const h = path.indexOf('#');
  const base = h === -1 ? path : path.slice(0, h);
  return `${base}${base.includes('?') ? '&' : '?'}${flag}=1#${flag}`;
}

function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
}

/**
 * How long an OUTBOUND call may take while a person is watching a spinner.
 *
 * The shared GitHub client retries three times with a 30s timeout each, which is right for CI
 * — a migration is worth waiting 92 seconds for. It is wrong for a button press: the browser
 * spins past every reasonable patience and, on a proxy with a shorter idle timeout, the answer
 * never arrives at all.
 */
const INTERACTIVE_GITHUB_MS = 8_000;

/**
 * Resolve `p`, or reject once `ms` has passed.
 *
 * The underlying request is NOT cancelled — this is a deadline on the ANSWER, not on the work.
 * That is deliberate and safe here: the only caller is a read (`getRepoAsUser`), so an
 * abandoned attempt changes nothing. Never wrap a write in this.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, github } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, extra) => console.log(extra ? `${message} ${JSON.stringify(extra)}` : message));
  const interactiveMs = deps.interactiveTimeoutMs ?? INTERACTIVE_GITHUB_MS;

  /**
   * Record an approval attempt that did NOT become an approval — containment items 1–3 for P1-A.
   *
   * Every exit of the approve handler already said something, to `console.log`. On the host that
   * is ephemeral, so the single successful approval left a durable row and the 170 failures left
   * lines that have since rotated away — which is the whole reason P1-A's status is "root cause
   * unknown; historical telemetry unavailable" rather than a diagnosis. A click that dies is now
   * exactly as durable as a click that works.
   *
   * SANITIZED by construction: a closed `outcome` class, the deployment that served it, and at
   * most a redacted, truncated message. Never a token, never customer source, never a finding —
   * the `detail` contract on AuditLogInput is scalars only, and `redactSecrets` is applied to the
   * one free-text field because an upstream error string is the one place a credential could
   * plausibly surface.
   */
  const recordApprovalFailure = async (args: {
    outcome: ApprovalOutcome;
    repo: string;
    installationId: number | null;
    actor: string | null;
    model?: string | null;
    message?: string;
  }): Promise<void> => {
    try {
      await store.appendAuditLog({
        event: 'approval_failed',
        installationId: args.installationId,
        repo: args.repo,
        actor: args.actor,
        detail: {
          outcome: args.outcome,
          deployment: deploymentId(config),
          model: args.model ?? null,
          message: args.message ? redactSecrets(args.message).slice(0, 200) : null,
        },
      });
    } catch (err) {
      // The record is diagnostics. If writing it fails, the click must still get its answer —
      // turning a refusal into a 500 because the audit insert failed would be a worse bug than
      // the one this exists to diagnose.
      log('approval failure record not written', { repo: args.repo, error: String(err).slice(0, 200) });
    }
  };
  const app = new Hono();
  const secure = config.appUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' };

  /**
   * Stamp EVERY response with the build that produced it.
   *
   * P1-A containment item 4 needs to bind an assertion to a build, and reading the commit from
   * `/healthz` cannot do that: `/healthz` and the request being judged are two separate requests,
   * and during a rolling deployment they can be served by different instances running different
   * builds. So the smoke test would report "the approve route works on the new build" having
   * actually exercised the old one — a confident claim about the wrong artifact, which is the
   * failure mode this whole item exists to remove.
   *
   * With the header, the response that is asserted carries its own provenance and the two cannot
   * be separated. Not a secret: a commit sha identifies a deployment, not a credential, and it is
   * already public in `/healthz` and in this repository's history.
   */
  app.use('*', async (c, next) => {
    await next();
    const commit = config.deployCommit;
    if (commit) c.header('X-Mendr-Deployment-Commit', commit);
    c.header('X-Mendr-Deployment', deploymentId(config));
  });

  // THE APP HAD NO ERROR HANDLER AT ALL, so an exception anywhere fell through to Hono's
  // default: `console.error(err)` and the bare text "Internal Server Error". That stack
  // carries no route, no repository and no actor, which is why a failed Approve could not be
  // told afterwards from a click that never arrived.
  //
  // Two jobs, and the logging one is the point. The page is a courtesy; the log line is what
  // makes the next failure diagnosable instead of a mystery.
  app.onError((err, c) => {
    log('unhandled error', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err).slice(0, 200),
    });
    if (err instanceof Error && err.stack) console.error(err.stack);
    // A machine caller gets JSON; a person gets a sentence. Neither gets a stack trace: the
    // audit and migrate endpoints are reached by a customer's CI, and this App's whole claim
    // is that what leaves it is bounded.
    if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ ok: false, error: 'internal error' }, 500);
    return c.html(
      errorPage(
        'Something went wrong',
        'Mendr hit an unexpected error handling that request. Nothing was changed. If you were approving a migration, no approval was created and no workflow was started — press the button again.',
      ),
      500,
    );
  });

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

  // Render's health check (render.yaml healthCheckPath): this process is up and serving, and
  // nothing else. It never touches the database. Render probes every few seconds, and /healthz
  // runs three queries, so probing /healthz would keep a scale-to-zero database (Neon's free plan
  // suspends after 5 idle minutes and caps compute hours a month) awake for as long as the
  // instance runs, until the allowance is spent and the database is suspended: the outage this
  // exists to avoid. Boot already proved the database (no database, no listening port), and a
  // restart cannot bring a lost database back, so the database check stays on /healthz.
  app.get('/livez', (c) => c.json({ ok: true }));

  // Health, plus proof of encryption at rest from the outside: is a data key
  // configured, how many stored reports are sealed vs plaintext, and does the
  // newest sealed one open with the current key. Counts and a verdict — never data.
  app.get('/healthz', async (c) => {
    const deployment = { commit: config.deployCommit, instance: config.deployInstance, id: deploymentId(config) };
    let enc: EncryptionStatus;
    try {
      enc = await store.encryptionStatus();
    } catch (err) {
      // The database went away after boot. Say so in JSON, not onError's page about approvals.
      log('healthz: database unavailable', { error: err instanceof Error ? redactSecrets(err.message).slice(0, 200) : 'unknown' });
      const error = 'Cannot reach the database at DATABASE_URL. Check the connection string in the Render dashboard.';
      return c.json({ ok: false, db: 'unavailable', error, store: store.kind, deployment }, 503);
    }
    return c.json({
      ok: true,
      db: 'ok',
      configured: isConfigured(config),
      store: store.kind,
      encryption: { enabled: !!config.dataKey, ...enc },
      // WHICH BUILD IS ANSWERING — P1-A containment item 4 depends on this and nothing else does.
      // A post-deploy smoke test that cannot tell builds apart is worse than none: it passes
      // against whatever is still serving, which is precisely the "proven on the build it was
      // last tested on" failure the item exists to close. Neither value is a secret — a commit
      // sha and an instance id identify a deployment, not a credential.
      deployment,
    });
  });

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
    // The scanner can see .github/workflows; the App cannot. Remember which file
    // carries the migration job, so an approval starts the right workflow.
    const migrateFile = migrationWorkflowFile(report);
    if (migrateFile) await store.setMigrateWorkflow(repo.id, migrateFile);

    const detailsUrl = `${config.appUrl}/r/${claims.repository}/runs/${run.id}`;
    let checkRun: string | null = null;
    let checkRunError: string | null = null;
    try {
      // The App's own clock, not the report's baked `daysUntil`: the countdown in the check
      // title must be right at the moment it is WRITTEN, not at the moment the scan ran.
      const payload = buildCheckRun(report, { sha, detailsUrl, externalId: `${repo.id}:${claims.runId}:${claims.runAttempt}`, now: now() });
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
  // the model swaps and the file paths they touch, and (unless told not to) the
  // diff of the swap itself — redacted and capped, for display, never whole
  // files — proven by the run's OIDC token, exactly like the audit. The finding
  // page then shows "PR #12 · verified" and what changes. This report never
  // resolves anything by itself: the next completed audit confirms a resolution.
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
            : report.outcome === 'pr-blocked'
              ? `verified and pushed${report.branch ? ` to ${report.branch}` : ''}, but GitHub refused to open the pull request from Actions (repository setting) — enable "Allow GitHub Actions to create and approve pull requests" and approve again, or open it yourself`
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
  // migration workflow at once; otherwise that workflow's own scheduled check
  // finds it, whenever GitHub gets round to running it. Either way the work — verify on a throwaway copy, push one
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
    // Auto-merge is offered only when the operator enabled it (off in the beta);
    // anything else — including a hand-crafted form — is a pull request for review.
    const mode: ApprovalMode = config.autoMerge && field('mode', 16) === 'auto-merge' ? 'auto-merge' : 'pr';
    return { provider, model, replacement: field('replacement', 128) || null, mode, back: safeNext(field('back', 300)) };
  };

  // DO NOT NAME A CADENCE HERE. Mendr writes the cron, but GitHub decides whether to honour it:
  // scheduled workflows are best-effort and are dropped under load. Measured on mendr-demo across a
  // 73-hour window with an hourly cron requested: 17 runs, not 73. Median gap 4.5 hours, worst 7.5.
  // Lowering the requested interval from three hours to one changed nothing measurable, because the
  // throttle dominates the request.
  //
  // So the schedule is a BACKSTOP, and the instant path is the App's own dispatch, which needs the
  // optional `actions: write`. Telling someone "within the hour" and delivering four hours later is
  // the first promise Mendr would break to a new customer, on the very screen where they are waiting.
  const pickup = (): string =>
    'your CI picks it up on its next scheduled check — GitHub runs those best-effort, so it can be several hours';

  const dispatchRefusal = (e: unknown): string => {
    if (e instanceof GitHubApiError) {
      if (e.status === 404) return `no migration workflow was found in the repository — add it once (see the Migration card) and ${pickup()}`;
      if (e.status === 403 || e.status === 422) return `Mendr may not start workflows here yet (grant the App "Actions: write" for instant starts); ${pickup()}`;
      return `GitHub answered ${e.status}; ${pickup()}`;
    }
    return pickup();
  };

  app.post('/r/:owner/:name/approve', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    // EVERY EXIT FROM THIS HANDLER SAYS SOMETHING, and every one of them is logged.
    //
    // It used to log exactly once, at the end, after the dispatch. So the four early
    // returns below wrote nothing anywhere: not to the audit log, not to the approvals
    // table, not to the page. A click that died here left the finding looking untouched,
    // `GET /api/approvals` empty, and the Render log holding at best an anonymous stack —
    // which is how a real approval came to be reported as "it spun and nothing happened",
    // with no way to tell afterwards whether the click had even arrived.
    //
    // This is the money path. Audit lands, finding shows, APPROVE, pull request opens.
    // A silent failure anywhere on it is worse than a loud one.
    // Read the form BEFORE the session check. A click made with an expired session used to redirect to
    // the repository overview, so the approval was never created and nothing said so: the intent vanished.
    // Coming back to the finding itself means the un-clicked Approve button is the signal.
    const f = await approveForm(c);
    const sess = await session(c);
    log('approve clicked', { repo: fullName, by: sess?.login ?? null, model: f ? `${f.provider}/${f.model}` : null });
    // Coming back is not enough on its own: an un-clicked button looks the same as one never pressed.
    // The flag makes the page say it outright.
    if (!sess) {
      log('approve refused', { repo: fullName, why: 'signed out' });
      await recordApprovalFailure({
        outcome: 'signed_out',
        repo: fullName,
        installationId: null, // the repo is not resolved yet on this path
        actor: null,
        model: f ? `${f.provider}/${f.model}` : null,
      });
      return c.redirect(`/auth/login?next=${encodeURIComponent(atNotice(f?.back ?? `/r/${fullName}`, 'signedout'))}`);
    }
    // THE ACCESS CHECK IS AN OUTBOUND GITHUB CALL, and on this path a person is watching a
    // spinner. Left bare it inherits the shared retry budget — 30s x 3 attempts plus backoff,
    // about 92 seconds — and any non-404 failure rethrew into a handler with no try/catch and
    // an app with no onError, so the browser got Hono's bare "Internal Server Error", or
    // nothing at all if the proxy hung up first. Either way the approval was never reached.
    let repo: Repo | null;
    try {
      repo = await withDeadline(accessibleRepo(sess, fullName), interactiveMs);
    } catch (err) {
      log('approve failed', { repo: fullName, by: sess.login, why: 'github access check', error: String(err).slice(0, 200) });
      await recordApprovalFailure({
        outcome: 'github_access_check',
        repo: fullName,
        installationId: null,
        actor: sess.login,
        model: f ? `${f.provider}/${f.model}` : null,
        message: String(err),
      });
      return c.html(
        errorPage(
          'GitHub did not answer',
          'Mendr could not check your access to this repository in time, so nothing was approved and no workflow was started. Nothing has changed. Press Approve again.',
        ),
        503,
      );
    }
    if (!repo) {
      log('approve refused', { repo: fullName, by: sess.login, why: 'repository not visible' });
      await recordApprovalFailure({
        outcome: 'repo_not_visible',
        repo: fullName,
        installationId: null,
        actor: sess.login,
        model: f ? `${f.provider}/${f.model}` : null,
      });
      return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
    }
    if (!f) {
      log('approve refused', { repo: fullName, by: sess.login, why: 'malformed form' });
      await recordApprovalFailure({
        outcome: 'malformed_form',
        repo: fullName,
        installationId: repo.installationId,
        actor: sess.login,
        model: null, // there is no well-formed model to name; that IS the failure
      });
      return c.html(errorPage('Bad request', 'An approval names the provider and model of the finding it is about.'), 400);
    }
    const key = `${f.provider}/${f.model}`;
    // One in flight per finding: a second click while it runs changes nothing.
    //
    // It used to return a bare 303 to a page that looked identical, which is indistinguishable
    // from a click that vanished. Worse, this guard reads `activeApprovals` (queued OR running)
    // while the page decides whether to draw the button from `listApprovals` (newest per model,
    // any status) — so the button can legitimately be on screen while this line discards the
    // press. A `running` approval is the sharp case: it blocks the click here and is invisible
    // to `GET /api/approvals`, which lists `queued` only. The flag makes the page say so; the
    // two sets still disagree and that is tracked separately.
    if ((await store.activeApprovals(repo.id)).has(key)) {
      log('approve ignored', { repo: fullName, by: sess.login, model: key, why: 'one already in flight' });
      await recordApprovalFailure({
        outcome: 'already_in_flight',
        repo: fullName,
        installationId: repo.installationId,
        actor: sess.login,
        model: key,
      });
      return c.redirect(atNotice(f.back, 'inflight'), 303);
    }
    const approval = await store.createApproval({ repoId: repo.id, provider: f.provider, model: f.model, replacement: f.replacement, mode: f.mode, approvedBy: sess.login });
    const at = now().toISOString();
    let dispatched = false;
    let why = pickup();
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
      // `deployment` on the SUCCESS row too, not only on failures: "it works now" and "it works
      // on the instance that happens to be warm" are the two readings of P1-A, and only a build
      // stamp on both outcomes can separate them.
      detail: { approval: approval.id, provider: f.provider, model: f.model, replacement: f.replacement, mode: f.mode, dispatched, deployment: deploymentId(config) },
    });
    // The approval EXISTS and the workflow did not start. This is the shape a person experiences
    // as "it spun and nothing happened", and the one the hourly schedule will silently paper over
    // by picking the approval up later — so it needs its own counted class, not just a `false` in
    // a field on a row named "approved".
    if (!dispatched) {
      await recordApprovalFailure({
        outcome: 'dispatch_failed',
        repo: fullName,
        installationId: repo.installationId,
        actor: sess.login,
        model: key,
        message: why,
      });
    }
    return c.redirect(f.back, 303);
  });

  app.post('/r/:owner/:name/approve/cancel', async (c) => {
    const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
    // Same ordering as Approve, for the same reason: a click made with an expired session has to come
    // back to the finding it was made on and say that nothing happened.
    const form = await c.req.parseBody();
    const id = Number(form.id);
    const back = safeNext(typeof form.back === 'string' ? form.back : '/');
    const sess = await session(c);
    if (!sess) return c.redirect(`/auth/login?next=${encodeURIComponent(atNotice(back === '/' ? `/r/${fullName}` : back, 'signedout'))}`);
    const repo = await accessibleRepo(sess, fullName);
    if (!repo) return c.html(errorPage('Not found', 'No such repository is visible to you here.'), 404);
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
        private: repo.private,
      });
    }
    return c.html(runsPage(repo, runs, sess.login, setupUrl, c.req.query('signedout') === '1'));
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
        autoMerge: config.autoMerge,
        signedOut: c.req.query('signedout') === '1',
        inFlight: c.req.query('inflight') === '1',
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
