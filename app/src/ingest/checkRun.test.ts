import { describe, expect, it } from 'vitest';
import { buildCheckRun, conclusionFor, MAX_ANNOTATIONS, titleFor } from './checkRun.js';
import { sampleReport } from '../../test/sampleReport.js';

// PIN THE CLOCK. The check title now carries a countdown, so without a fixed `now` every
// assertion below would drift by one day, every day, and go red on a date nobody chose.
const NOW = new Date('2026-09-28T09:00:00Z');
const opts = { sha: 'b'.repeat(40), detailsUrl: 'https://app.example/r/acme/api/runs/1', externalId: '1:99:1', now: NOW };

describe('check run conclusion keeps the CLI weights', () => {
  it('patch eligible -> action_required; review only -> neutral; informational only -> success', () => {
    expect(conclusionFor(sampleReport())).toBe('action_required');
    const reviewOnly = sampleReport({ investigations: sampleReport().investigations.filter((i) => i.decision !== 'patch') });
    expect(conclusionFor(reviewOnly)).toBe('neutral');
    const infoOnly = sampleReport({ investigations: sampleReport().investigations.filter((i) => i.decision === 'monitor') });
    expect(conclusionFor(infoOnly)).toBe('success');
    expect(conclusionFor(sampleReport({ conclusion: 'no_exposure_in_completed_surfaces', investigations: [] }))).toBe('success');
  });

  it('inconclusive and failed audits are neutral and say so, never success', () => {
    expect(conclusionFor(sampleReport({ conclusion: 'inconclusive', investigations: [] }))).toBe('neutral');
    expect(conclusionFor(sampleReport({ conclusion: 'audit_failed', investigations: [] }))).toBe('neutral');
    expect(titleFor(sampleReport({ conclusion: 'inconclusive', investigations: [] }))).toMatch(/^Inconclusive/);
    expect(titleFor(sampleReport({ conclusion: 'audit_failed', investigations: [] }))).toMatch(/failed/);
  });
});

describe('buildCheckRun', () => {
  it('titles with the three counts, annotates selector locations with unequal levels, and normalizes paths', () => {
    const cr = buildCheckRun(sampleReport(), opts);
    expect(cr.name).toBe('Mendr audit');
    expect(cr.head_sha).toBe(opts.sha);
    expect(cr.status).toBe('completed');
    expect(cr.conclusion).toBe('action_required');
    expect(cr.details_url).toBe(opts.detailsUrl);
    // The deadline leads, not the tally. `gemini-1.5-pro` is the soonest-dying ACTIONABLE
    // model in the fixture — it shut down on 2025-09-24, i.e. it is already gone, which is
    // more urgent than gpt-4's 2026-10-23 and so takes the headline.
    expect(cr.output.title).toBe('gemini-1.5-pro stopped serving 369 days ago · 1 patch eligible');
    expect(cr.output.annotations).toEqual([
      expect.objectContaining({ path: 'src/client.ts', start_line: 4, end_line: 4, annotation_level: 'warning', title: 'Mendr: gpt-4 PATCH ELIGIBLE' }),
      expect.objectContaining({ path: 'config/app.yaml', start_line: 3, annotation_level: 'notice', title: 'Mendr: gemini-1.5-pro REVIEW REQUIRED' }),
    ]);
    // Informational references get no annotation: no migration action.
    expect(cr.output.annotations.some((a) => a.path.startsWith('docs/'))).toBe(false);
    expect(cr.output.summary).toContain('**gpt-4** (openai) — PATCH ELIGIBLE (deprecated, shutdown 2026-10-23)');
    expect(cr.output.summary).toContain(`Next action: approve the migration in your Mendr App — ${opts.detailsUrl}`); // App users act in Mendr, not on the command line
    expect(cr.output.summary).not.toContain('run mendr fix-llm');
    expect(cr.output.summary).toContain('1 informational reference');
    expect(cr.output.text).toContain('No code was cloned or stored by Mendr');
  });

  it('lists patch before review in the summary regardless of input order', () => {
    const r = sampleReport();
    r.investigations.reverse();
    const cr = buildCheckRun(r, opts);
    expect(cr.output.summary.indexOf('PATCH ELIGIBLE')).toBeLessThan(cr.output.summary.indexOf('REVIEW REQUIRED'));
  });

  it(`caps annotations at ${MAX_ANNOTATIONS} and says how many were left out`, () => {
    const r = sampleReport();
    const inv = r.investigations[1]!;
    inv.locations.selectors = Array.from({ length: 60 }, (_, i) => ({ file: `f${i}.yaml`, line: i + 1, disposition: 'review' }));
    const cr = buildCheckRun(r, opts);
    expect(cr.output.annotations.length).toBe(MAX_ANNOTATIONS);
    expect(cr.output.text).toContain('11 further locations');
  });
});

describe('the check speaks App, and does not break the model id doing it', () => {
  // Regression: a real check run on ajitheee/mendr-demo published
  //   "migrate it to gpt-5 once you approve in your Mendr App.6-sol"
  // because the capture class excluded dots and stopped inside `gpt-5.6-sol`.
  // That page is what the Gate 2 outreach sends strangers to look at.
  const withReason = (reason: string) => {
    const r = sampleReport();
    const inv = r.investigations.find((i) => i.decision === 'patch')!;
    inv.locations.selectors[0]!.reason = reason;
    return buildCheckRun(r, opts).output.annotations[0]!.message;
  };

  it('keeps a dotted replacement id intact', () => {
    const msg = withReason(
      'A verified auto-fix exists for gpt-4-0613 — fix-llm can rewrite it to gpt-5.6-sol. Nothing is applied by the audit.',
    );
    expect(msg).toContain('Mendr can migrate it to gpt-5.6-sol once you approve in your Mendr App.');
    expect(msg).toContain('Nothing is applied by the audit.');
    expect(msg).not.toContain('App.6-sol');
    expect(msg).not.toContain('fix-llm');
  });

  it('rewrites the plural branch too, so the internal tool name never reaches a reader', () => {
    const msg = withReason(
      'A verified auto-fix exists for gpt-4, o3-mini — fix-llm can rewrite them to gpt-5.6-sol. Nothing is applied by the audit.',
    );
    expect(msg).toContain('Mendr can migrate them to gpt-5.6-sol once you approve in your Mendr App.');
    expect(msg).not.toContain('fix-llm');
  });

  it('still handles an id with no dot in it', () => {
    const msg = withReason('A verified auto-fix exists for gpt-4 — fix-llm can rewrite it to gpt-5. Nothing is applied.');
    expect(msg).toContain('Mendr can migrate it to gpt-5 once you approve in your Mendr App.');
    expect(msg).not.toContain('fix-llm');
  });
});

describe('the check title leads with the deadline, computed at write time', () => {
  // Why this exists: `1 patch eligible · 0 review required · 0 informational` is a count of
  // Mendr's own verdicts. It means nothing to a reviewer who has not read the summary. The
  // fact that decides whether anyone acts is the DATE.
  const withShutdown = (shutdownDate: string | null, decision: 'patch' | 'review' = 'patch') => {
    const r = sampleReport();
    // one actionable finding only, so the assertion is about the date and nothing else
    r.investigations = r.investigations.filter((i) => i.decision === 'patch').slice(0, 1);
    const inv = r.investigations[0]!;
    inv.decision = decision;
    inv.model = 'gpt-4-0613';
    inv.retirementEvidence = { ...(inv.retirementEvidence ?? {}), shutdownDate, daysUntil: 999 } as never;
    return titleFor(r, NOW);
  };

  it('counts the days remaining, in the words a person would use', () => {
    expect(withShutdown('2026-10-23')).toBe('gpt-4-0613 stops serving in 25 days · 1 patch eligible');
    expect(withShutdown('2026-09-29')).toBe('gpt-4-0613 stops serving tomorrow · 1 patch eligible');
    expect(withShutdown('2026-09-28')).toBe('gpt-4-0613 stops serving today · 1 patch eligible');
  });

  it('says so plainly when the model is already gone', () => {
    expect(withShutdown('2026-09-27')).toBe('gpt-4-0613 stopped serving 1 day ago · 1 patch eligible');
    expect(withShutdown('2026-09-18')).toBe('gpt-4-0613 stopped serving 10 days ago · 1 patch eligible');
  });

  it('IGNORES the report\u2019s baked daysUntil and uses the write-time clock', () => {
    // The fixture carries daysUntil: 999. The CLI computes that field at SCAN time, so a
    // report that sat in a queue would count down from the wrong day. This is the whole
    // reason the clock is threaded through buildCheckRun.
    expect(withShutdown('2026-10-23')).toContain('25 days');
    expect(withShutdown('2026-10-23')).not.toContain('999');
  });

  it('falls back to the tally when there is no shutdown date to lead with', () => {
    // Inventing a deadline would be the overclaim this product exists to avoid.
    expect(withShutdown(null)).toBe('1 patch eligible · 0 review required · 0 informational');
  });

  it('picks the SOONEST actionable model, and ignores informational ones', () => {
    const r = sampleReport();
    // gpt-3.5-turbo is `monitor` in the fixture; give it the nearest date of all and it must
    // still not take the headline — no migration action is required for it.
    const info = r.investigations.find((i) => i.decision === 'monitor')!;
    info.retirementEvidence = { status: 'deprecated', shutdownDate: '2026-09-29', daysUntil: 1 } as never;
    expect(titleFor(r, NOW)).toBe('gemini-1.5-pro stopped serving 369 days ago · 1 patch eligible');
  });

  it('keeps the inconclusive and audit-failed prefixes', () => {
    const inc = sampleReport({ conclusion: 'inconclusive' });
    expect(titleFor(inc, NOW).startsWith('Inconclusive · ')).toBe(true);
    expect(titleFor(sampleReport({ conclusion: 'audit_failed', investigations: [] }), NOW)).toMatch(/failed/);
  });

  it('is stable across the working day — calendar days, not 24-hour periods', () => {
    const r = sampleReport();
    const early = titleFor(r, new Date('2026-09-28T00:30:00Z'));
    const late = titleFor(r, new Date('2026-09-28T23:30:00Z'));
    expect(early).toBe(late);
  });
});
