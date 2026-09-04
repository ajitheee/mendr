import { describe, expect, it } from 'vitest';
import { buildCheckRun, conclusionFor, MAX_ANNOTATIONS, titleFor } from './checkRun.js';
import { sampleReport } from '../../test/sampleReport.js';

const opts = { sha: 'b'.repeat(40), detailsUrl: 'https://app.example/r/acme/api/runs/1', externalId: '1:99:1' };

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
    expect(cr.output.title).toBe('1 patch eligible · 1 review required · 1 informational');
    expect(cr.output.annotations).toEqual([
      expect.objectContaining({ path: 'src/client.ts', start_line: 4, end_line: 4, annotation_level: 'warning', title: 'Mendr: gpt-4 PATCH ELIGIBLE' }),
      expect.objectContaining({ path: 'config/app.yaml', start_line: 3, annotation_level: 'notice', title: 'Mendr: gemini-1.5-pro REVIEW REQUIRED' }),
    ]);
    // Informational references get no annotation: no migration action.
    expect(cr.output.annotations.some((a) => a.path.startsWith('docs/'))).toBe(false);
    expect(cr.output.summary).toContain('**gpt-4** (openai) — PATCH ELIGIBLE (deprecated, shutdown 2026-10-23)');
    expect(cr.output.summary).toContain('Next action: run mendr fix-llm');
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
