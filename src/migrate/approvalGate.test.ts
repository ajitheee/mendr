import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// A GREEN THAT MEANS "NOTHING HAPPENED" IS WORSE THAN A RED.
//
// `ajitheee/mendr-demo` accumulated 169 workflow runs whose `migrate / migrate`
// check reported `success`, while the migrate path had never once executed. The
// gate finds nothing approved, exits 0, every later step is conditioned on
// `steps.gate.outputs.proceed == 'true'` and skips, and GitHub reports the job
// that started as a success. Reading the check run, a person concludes a
// migration ran. Reading the RC record, they conclude it never has. Both were
// being written from the same runs.
//
// GitHub cannot mark a job `skipped` once it has begun, so the truth has to be
// carried somewhere a reader actually looks: the run page's own summary, plus an
// output a caller can branch on. This suite reads the SHIPPED action.yml, so a
// future edit that drops either one fails here rather than in production.

const ACTION = readFileSync(join(process.cwd(), 'mendr-action', 'action.yml'), 'utf8');

/** The gate step's shell body — everything from the gate id to the next step. */
function gateStep(): string {
  const start = ACTION.indexOf('id: gate');
  expect(start, 'the gate step must exist and carry `id: gate`').toBeGreaterThan(-1);
  const next = ACTION.indexOf('\n    - name:', start);
  return ACTION.slice(start, next === -1 ? ACTION.length : next);
}

describe('the approval gate says what happened, not just that it survived', () => {
  it('writes a step summary when nothing is approved, so the run page states it', () => {
    const gate = gateStep();
    const nothing = gate.slice(gate.indexOf('nothing is approved in the App'));
    expect(nothing).toContain('GITHUB_STEP_SUMMARY');
    expect(nothing).toContain('**No migration ran.**');
    // The point of the line: name the gap between the colour and the fact.
    expect(nothing).toContain('This job is green because the check itself succeeded');
  });

  it('writes a step summary when another run claimed the approvals first', () => {
    const gate = gateStep();
    const taken = gate.slice(gate.indexOf('another run already took these approvals'));
    expect(taken).toContain('GITHUB_STEP_SUMMARY');
    expect(taken).toContain('**No migration ran here.**');
  });

  it('the App-not-installed path says so too — the quietest of the three', () => {
    const gate = gateStep();
    const gone = gate.slice(gate.indexOf('the Mendr App is not installed'));
    expect(gone).toContain('GITHUB_STEP_SUMMARY');
    expect(gone).toContain('**No migration ran, and none can.**');
    expect(gone).toContain('will keep reporting green while doing nothing');
  });

  it('every no-op path sets proceed=false, exits 0, and explains itself', () => {
    const gate = gateStep();
    // Three ways to do nothing: App not installed (403), nothing approved,
    // approvals already claimed elsewhere. The count is asserted so a FOURTH
    // one added later cannot slip through without a summary of its own — which
    // is exactly how the 403 branch went unnoticed when this suite was written.
    const noops = gate.match(/echo "proceed=false" >> "\$GITHUB_OUTPUT"/g) ?? [];
    expect(noops).toHaveLength(3);
    // None of them is a failure: an hourly check must not go red for having
    // nothing to do, or a customer disables the workflow within a week.
    const summaries = gate.match(/GITHUB_STEP_SUMMARY/g) ?? [];
    expect(summaries).toHaveLength(noops.length);
  });

  it('exposes a `migrated` output, because the job conclusion cannot carry this', () => {
    expect(ACTION).toContain('  migrated:');
    expect(ACTION).toContain('value: ${{ steps.gate.outputs.proceed }}');
    // The description has to warn the reader off the conclusion, which is the
    // thing that misled us in the first place.
    const block = ACTION.slice(ACTION.indexOf('  migrated:'), ACTION.indexOf('runs:'));
    expect(block).toContain('JOB CONCLUSION cannot tell you this');
  });

  it('the summary redirects are failure-tolerant: a local run has no summary file', () => {
    // `>> "$GITHUB_STEP_SUMMARY"` unset under `set -u` would abort the gate and
    // turn "nothing to do" into a red run. Every write defaults the path.
    const writes = ACTION.match(/GITHUB_STEP_SUMMARY[^\n]*/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) expect(w).toContain(':-/dev/null');
  });
});
