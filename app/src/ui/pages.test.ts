import { describe, expect, it } from 'vitest';
import type { MigrationRecord, Repo, RunRecord, RunSummary } from '../store/types.js';
import { loadConfig } from '../config.js';
import { homePage, runPage, runsPage, type RepoRow } from './pages.js';

// "Failure must never look resolved": a run that did not conclude must not
// wear the green "nothing found" pill anywhere a reader scans for status.

const repo: Repo = { id: 1, installationId: 1, fullName: 'acme/api', private: false, removedAt: null, migrateSeenAt: null, migrateWorkflow: null };

function run(conclusion: string, counts = { patch: 0, review: 0, informational: 0 }): RunSummary {
  return {
    id: 7,
    repoId: 1,
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    runId: 1,
    runAttempt: 1,
    workflowRef: null,
    actor: null,
    receivedAt: '2026-09-06T12:00:00.000Z',
    generatedAt: null,
    conclusion,
    counts,
    checkRunUrl: null,
  };
}

describe('run pills never let a non-conclusion look clean', () => {
  it('a zero-finding INCONCLUSIVE run reads "inconclusive", not "nothing found"', () => {
    const html = runsPage(repo, [run('inconclusive')], 'octocat');
    expect(html).toContain('>inconclusive<');
    expect(html).not.toContain('nothing found');
  });

  it('a FAILED audit reads "audit failed"', () => {
    const html = runsPage(repo, [run('audit_failed')], 'octocat');
    expect(html).toContain('>audit failed<');
    expect(html).not.toContain('nothing found');
  });

  it('an inconclusive run with informational references shows both', () => {
    const html = runsPage(repo, [run('inconclusive', { patch: 0, review: 0, informational: 2 })], 'octocat');
    expect(html).toContain('>inconclusive<');
    expect(html).toContain('2 informational');
  });

  it('a COMPLETED zero-finding run still reads "nothing found"', () => {
    const html = runsPage(repo, [run('no_exposure_in_completed_surfaces')], 'octocat');
    expect(html).toContain('nothing found');
    expect(html).not.toContain('>inconclusive<');
  });
});

describe('overview: the last completed scan vs the latest attempt, and whether monitoring is alive', () => {
  const config = { ...loadConfig({}), githubAppId: '1', githubAppSlug: 'mendr-test', githubPrivateKey: 'x', githubWebhookSecret: 'x', githubClientId: 'x', githubClientSecret: 'x' };
  const NOW = new Date('2026-09-07T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const zero = { patch: 0, review: 0, informational: 0 };
  const page = (rows: RepoRow[]) => homePage({ config, configured: true, login: 'octocat', rows, now: NOW });

  it('a completed scan three hours ago: active, and no separate attempt line', () => {
    const r = { ...run('no_exposure_in_completed_surfaces', zero), id: 5, receivedAt: hoursAgo(3) };
    const html = page([{ repo, latest: r, latestCompleted: r, defaultBranch: 'main' }]);
    expect(html).toContain('>active<');
    expect(html).toContain('3 h ago');
    expect(html).toContain('nothing found');
    expect(html).not.toContain('latest attempt');
  });

  it('a newer inconclusive attempt is shown beneath the last completed scan, never in its place', () => {
    const completed = { ...run('exposure_detected', { patch: 1, review: 0, informational: 0 }), id: 5, receivedAt: hoursAgo(40) };
    const attempt = { ...run('inconclusive', zero), id: 6, receivedAt: hoursAgo(1) };
    const html = page([{ repo, latest: attempt, latestCompleted: completed, defaultBranch: 'main' }]);
    expect(html).toContain('/r/acme/api/runs/5'); // the completed scan is the headline
    expect(html).toContain('1 patch eligible'); // and its result is the row's result
    expect(html).toContain('latest attempt');
    expect(html).toContain('/r/acme/api/runs/6');
    expect(html).toContain('· inconclusive');
    expect(html).toContain('>active<'); // evidence arrived an hour ago — monitoring is alive
  });

  it('three days of silence reads quiet', () => {
    const r = { ...run('no_exposure_in_completed_surfaces', zero), id: 5, receivedAt: hoursAgo(72) };
    const html = page([{ repo, latest: r, latestCompleted: r, defaultBranch: 'main' }]);
    expect(html).toContain('quiet · 3 d');
    expect(html).not.toContain('>active<');
  });

  it('only an inconclusive run so far: "none yet" completed, and the attempt is what the row shows', () => {
    const attempt = { ...run('inconclusive', zero), id: 6, receivedAt: hoursAgo(2) };
    const html = page([{ repo, latest: attempt, latestCompleted: null, defaultBranch: 'main' }]);
    expect(html).toContain('none yet');
    expect(html).toContain('>inconclusive<');
    expect(html).not.toContain('nothing found');
  });

  it('no run at all: the one-click setup, "no run yet", and "not connected"', () => {
    const html = page([{ repo, latest: null, latestCompleted: null, defaultBranch: 'main' }]);
    expect(html).toContain('Set up the audit');
    expect(html).toContain('no run yet — add the workflow');
    expect(html).toContain('>not connected<');
  });

  it('states the expected cadence under the table', () => {
    const r = { ...run('no_exposure_in_completed_surfaces', zero), id: 5, receivedAt: hoursAgo(3) };
    expect(page([{ repo, latest: r, latestCompleted: r, defaultBranch: 'main' }])).toContain('daily at 06:37 UTC');
  });
});

describe('approving a migration on the run page', () => {
  type Decision = 'patch' | 'review' | 'monitor';
  const investigation = (decision: Decision) => ({
    provider: 'openai',
    model: 'gpt-4',
    decision,
    reason: 'gpt-4 retires 2026-10-23',
    nextAction: 'Prepare the migration to gpt-5.6-sol.',
    retirementEvidence: { status: 'deprecated', shutdownDate: '2026-10-23', daysUntil: 45, replacement: 'gpt-5.6-sol', replacementVerdict: 'verified' },
    locations: { selectors: decision === 'monitor' ? [] : [{ file: 'src/ai.ts', line: 4 }], catalog: decision === 'monitor' ? [{ file: 'docs/m.md', line: 1 }] : [] },
  });
  const record = (decision: Decision, coverage: Record<string, unknown> = {}): RunRecord =>
    ({
      ...run('exposure_detected', { patch: decision === 'patch' ? 1 : 0, review: decision === 'review' ? 1 : 0, informational: decision === 'monitor' ? 1 : 0 }),
      report: { schema: 'mendr-audit/v3', conclusion: 'exposure_detected', coverage, investigations: [investigation(decision)] },
    }) as RunRecord;
  const view = {
    webUrl: 'https://github.com',
    workflowUrl: 'https://github.com/acme/api/actions/workflows/mendr-audit.yml',
    migrate: { setupUrl: 'https://github.com/acme/api/new/main?filename=x', runUrl: 'https://github.com/acme/api/actions/workflows/mendr-migrate.yml' },
  };

  const APPROVE = 'Approve migration to gpt-5.6-sol</button>';

  it('when the scanner saw no migration workflow: the one-time add, and no Approve button yet', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: false } }), 'octocat', view);
    expect(html).toContain('migration workflow not added yet');
    expect(html).toContain('Add it once ↗');
    expect(html).toContain(view.migrate.setupUrl.replace(/&/g, '&amp;'));
    expect(html).toContain('add the migration workflow once ↗'); // on the finding itself
    expect(html).not.toContain(APPROVE);
    expect(html).toContain('never touches your default branch');
  });

  it('once the workflow exists: the Approve button with both modes', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', view);
    expect(html).toContain('migration workflow present');
    expect(html).toContain(APPROVE);
    expect(html).toContain('<option value="pr">');
    expect(html).toContain('<option value="auto-merge">');
    expect(html).not.toContain('Add it once');
  });

  it('when the report predates the field (older scanner): Approve is offered, and the add link stays available', () => {
    const html = runPage(repo, record('patch'), 'octocat', view);
    expect(html).toContain('migration workflow not seen yet');
    expect(html).toContain("add it if you haven't ↗");
    expect(html).toContain(APPROVE);
  });

  it('once the workflow has asked for approvals, it reads active — whatever the scanner saw', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: false } }), 'octocat', { ...view, migrateSeenAt: '2026-09-08T11:40:00.000Z', now: new Date('2026-09-08T12:00:00Z') });
    expect(html).toContain('migration workflow active');
    expect(html).toContain('last checked for approvals just now');
    expect(html).toContain(APPROVE);
  });

  it('an in-flight approval shows its status and timeline in place of the button; a done one shows done', () => {
    const base = { id: 9, repoId: 1, provider: 'openai', model: 'gpt-4', replacement: 'gpt-5.6-sol', mode: 'pr' as const, approvedBy: 'octocat', createdAt: '2026-09-08T11:00:00.000Z', startedAt: null, finishedAt: null, runId: null, migrationId: null, outcome: null };
    const queued = { ...base, status: 'queued' as const, dispatchedAt: '2026-09-08T11:00:01.000Z', events: [{ at: '2026-09-08T11:00:01.000Z', stage: 'dispatched' as const, detail: 'Mendr started your migration workflow' }] };
    let html = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', { ...view, approvals: new Map([['openai/gpt-4', queued]]) });
    expect(html).toContain('Approved by <strong>octocat</strong>');
    expect(html).toContain('>queued<');
    expect(html).toContain('workflow started');
    expect(html).toContain('data-approval="9"');
    expect(html).toContain('Cancel</button>');
    expect(html).not.toContain(APPROVE);
    const done = { ...queued, status: 'done' as const, finishedAt: '2026-09-08T11:09:00.000Z', migrationId: 3, outcome: 'migration-proposed', events: [...queued.events, { at: '2026-09-08T11:09:00.000Z', stage: 'done' as const, detail: 'pull request #12 open · verified' }] };
    html = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', { ...view, approvals: new Map([['openai/gpt-4', done]]) });
    expect(html).toContain('>done<');
    expect(html).toContain('pull request #12 open');
    expect(html).not.toContain('Cancel</button>');
    expect(html).not.toContain(APPROVE);
  });

  it('is absent when nothing is patch eligible, and when the App is unconfigured', () => {
    expect(runPage(repo, record('review', { migration: { workflowPresent: true } }), 'octocat', view)).not.toContain('id="migrate"');
    expect(runPage(repo, record('monitor'), 'octocat', view)).not.toContain('id="migrate"');
    const unconfigured = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', { webUrl: view.webUrl, workflowUrl: view.workflowUrl });
    expect(unconfigured).not.toContain('id="migrate"');
    expect(unconfigured).not.toContain(APPROVE);
  });

  const migration = (over: Partial<MigrationRecord> = {}): MigrationRecord => ({
    id: 3,
    repoId: 1,
    sha: 'b'.repeat(40),
    ref: 'refs/heads/main',
    runId: 500,
    runAttempt: 1,
    workflowRef: null,
    actor: 'octocat',
    receivedAt: '2026-09-07T07:00:00.000Z',
    generatedAt: null,
    outcome: 'migration-proposed',
    verdict: 'verified',
    prUrl: 'https://github.com/acme/api/pull/12',
    report: {
      schema: 'mendr-migration-report/v1',
      outcome: 'migration-proposed',
      prUrl: 'https://github.com/acme/api/pull/12',
      sha: 'b'.repeat(40),
      generatedAt: null,
      verdict: 'verified',
      gates: { typeCheck: 'pass', build: 'not-configured', tests: 'pass', eval: 'not-configured' },
      behavioralTested: false,
      migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 1, files: ['src/ai.ts'] }],
      changedFiles: ['src/ai.ts'],
      notes: [],
    },
    ...over,
  });

  it('shows what mendr-action last reported, on the card and on the finding it covers', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', { ...view, migration: migration() });
    expect(html).toContain('Latest migration run');
    expect(html).toContain('PR #12 ↗');
    expect(html).toContain('>verified<');
    expect(html).toContain('type-check ✓');
    expect(html).toContain('build —');
    expect(html).toContain('behavior not tested');
    expect(html).toContain('Migration run:'); // on the gpt-4 finding itself
  });

  it('a not-verified run says so and shows no PR', () => {
    const html = runPage(repo, record('patch'), 'octocat', {
      ...view,
      migration: migration({ outcome: 'not-verified', verdict: 'failed', prUrl: null, report: { ...migration().report, outcome: 'not-verified', verdict: 'failed', prUrl: null, gates: { typeCheck: 'pass', build: 'not-configured', tests: 'fail', eval: 'not-configured' } } }),
    });
    expect(html).toContain('not verified — nothing applied, no PR');
    expect(html).toContain('tests ✗');
    expect(html).not.toContain('PR #12');
  });
});

describe('a resolution is confirmed only by a completed scan on a fresh registry', () => {
  const inv = (model: string, decision: 'patch' | 'monitor' = 'patch') => ({
    provider: 'openai',
    model,
    decision,
    reason: 'r',
    nextAction: 'n',
    locations: { selectors: decision === 'monitor' ? [] : [{ file: 'src/ai.ts', line: 4 }], catalog: [] },
  });
  const rec = (id: number, conclusion: string, models: string[], registry: Record<string, unknown> | null): RunRecord =>
    ({
      ...run(conclusion, { patch: models.length, review: 0, informational: 0 }),
      id,
      report: { schema: 'mendr-audit/v3', conclusion, coverage: registry ? { registry } : {}, investigations: models.map((m) => inv(m)) },
    }) as RunRecord;
  const fresh = { providers: ['openai'], freshness: 'fresh', publishedAt: '2026-09-07T00:00:00Z', ageDays: 0, maxAgeDays: 14 };
  const stale = { ...fresh, freshness: 'stale', reason: 'old' };
  const view = { webUrl: 'https://github.com', workflowUrl: 'https://github.com/acme/api/actions/workflows/mendr-audit.yml' };
  const pr: MigrationRecord = {
    id: 9, repoId: 1, sha: 'b'.repeat(40), ref: 'refs/heads/main', runId: 500, runAttempt: 1, workflowRef: null, actor: null, receivedAt: '2026-09-07T07:00:00.000Z', generatedAt: null,
    outcome: 'migration-proposed', verdict: 'verified', prUrl: 'https://github.com/acme/api/pull/12',
    report: { schema: 'mendr-migration-report/v1', outcome: 'migration-proposed', prUrl: 'https://github.com/acme/api/pull/12', sha: null, generatedAt: null, verdict: 'verified', gates: null, behavioralTested: false, migrations: [{ provider: 'openai', from: 'gpt-4', to: 'gpt-5.6-sol', language: 'ts', sites: 1, files: [] }], changedFiles: [], notes: [] },
  };

  it('names the model that was actionable before and is gone now, with the PR that covered it', () => {
    const previous = rec(1, 'exposure_detected', ['gpt-4', 'gpt-3.5-turbo'], fresh);
    const current = rec(2, 'exposure_detected', ['gpt-3.5-turbo'], fresh);
    const html = runPage(repo, current, 'octocat', { ...view, previous, migration: pr });
    expect(html).toContain('Resolved since run 1');
    expect(html).toContain('<code>gpt-4</code> (openai) no longer found — via <a href="https://github.com/acme/api/pull/12"');
    expect(html).not.toContain('<code>gpt-3.5-turbo</code> (openai) no longer found');
    expect(html).toContain('not by a merge event');
  });

  it('claims nothing from an inconclusive scan, a stale registry, or a report without freshness', () => {
    const previous = rec(1, 'exposure_detected', ['gpt-4'], fresh);
    expect(runPage(repo, rec(2, 'inconclusive', [], stale), 'octocat', { ...view, previous, migration: pr })).not.toContain('Resolved since');
    expect(runPage(repo, rec(2, 'exposure_detected', [], stale), 'octocat', { ...view, previous, migration: pr })).not.toContain('Resolved since');
    expect(runPage(repo, rec(2, 'no_exposure_in_completed_surfaces', [], null), 'octocat', { ...view, previous, migration: pr })).not.toContain('Resolved since');
    expect(runPage(repo, rec(2, 'no_exposure_in_completed_surfaces', [], fresh), 'octocat', { ...view, previous: null })).not.toContain('Resolved since');
  });

  it('a clean completed scan on a fresh registry confirms it, even without a migration PR', () => {
    const previous = rec(1, 'exposure_detected', ['gpt-4'], fresh);
    const html = runPage(repo, rec(2, 'no_exposure_in_completed_surfaces', [], fresh), 'octocat', { ...view, previous });
    expect(html).toContain('Resolved since run 1');
    expect(html).toContain('<code>gpt-4</code> (openai) no longer found</li>');
    expect(html).toContain('Nothing needs action');
  });
});
