import { describe, expect, it } from 'vitest';
import type { Repo, RunSummary } from '../store/types.js';
import { runsPage } from './pages.js';

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
