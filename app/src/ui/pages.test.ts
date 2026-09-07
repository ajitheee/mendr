import { describe, expect, it } from 'vitest';
import type { Repo, RunRecord, RunSummary } from '../store/types.js';
import { runPage, runsPage } from './pages.js';

// "Failure must never look resolved": a run that did not conclude must not
// wear the green "nothing found" pill anywhere a reader scans for status.

const repo: Repo = { id: 1, installationId: 1, fullName: 'acme/api', private: false, removedAt: null };

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

describe('"Prepare migration for review" on the run page', () => {
  type Decision = 'patch' | 'review' | 'monitor';
  const investigation = (decision: Decision) => ({
    provider: 'openai',
    model: 'gpt-4',
    decision,
    reason: 'gpt-4 retires 2026-10-23',
    nextAction: 'Prepare the migration to gpt-5.6-sol.',
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

  it('offers the one-click workflow when the scanner saw none in the repo', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: false } }), 'octocat', view);
    expect(html).toContain('Add the migration workflow ↗');
    expect(html).toContain(view.migrate.setupUrl.replace(/&/g, '&amp;'));
    expect(html).not.toContain('Prepare migration for review ↗');
    expect(html).toContain('Prepare migration for review ↓'); // the finding points at the step
    expect(html).toContain('never merges');
  });

  it('offers "Run workflow" once the workflow exists', () => {
    const html = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', view);
    expect(html).toContain('Prepare migration for review ↗');
    expect(html).toContain(view.migrate.runUrl);
    expect(html).not.toContain('Add the migration workflow ↗');
  });

  it('offers both when the report predates the field (older scanner)', () => {
    const html = runPage(repo, record('patch'), 'octocat', view);
    expect(html).toContain('Add the migration workflow ↗');
    expect(html).toContain('Run it on GitHub ↗');
  });

  it('is absent when nothing is patch eligible, and when the App is unconfigured', () => {
    expect(runPage(repo, record('review', { migration: { workflowPresent: true } }), 'octocat', view)).not.toContain('id="migrate"');
    expect(runPage(repo, record('monitor'), 'octocat', view)).not.toContain('id="migrate"');
    const unconfigured = runPage(repo, record('patch', { migration: { workflowPresent: true } }), 'octocat', { webUrl: view.webUrl, workflowUrl: view.workflowUrl });
    expect(unconfigured).not.toContain('id="migrate"');
    expect(unconfigured).not.toContain('Prepare migration for review ↓');
  });
});
