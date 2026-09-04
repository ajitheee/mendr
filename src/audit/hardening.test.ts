import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import type { ExposedModel } from '../watch/exposure.js';
import { NO_RUNTIME_EVIDENCE } from '../runtime/evidence.js';
import { analyzedIsMinority, buildInvestigations, concludeAudit, coverageGaps, type AuditCoverage } from './investigation.js';
import { decisionLines, INFORMATIONAL_PREVIEW, renderAuditReport } from '../report/auditReport.js';

// Decision-engine hardening — regression suite for the external-validation
// defects (VALIDATION-2026-09-03.md): M1 "verified" keyed on role, M6
// per-investigation patch eligibility, M8 clean-sounding conclusions over
// mostly-unread repositories, M10 undisclosed test-file skips, m1 "track" on
// already-retired models.

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'retired', shutdownDate: '2024-09-13', verification: autoApplyVerification() },
];
const NOW = new Date('2026-09-03T00:00:00Z');

function codeModel(
  id: string,
  locs: Array<{ line: number; tier: 'A' | 'B' | 'C'; reason?: string }>,
  sourceUrl: string | null = 'https://developers.openai.com/api/docs/deprecations',
): ExposedModel {
  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const l of locs) tierCounts[l.tier] += 1;
  const highest = tierCounts.A ? 'A' : tierCounts.B ? 'B' : 'C';
  const entry = REGISTRY.find((e) => e.deprecated === id)!;
  return {
    id,
    provider: 'openai',
    entryId: `${id}.x`,
    status: entry.status,
    shutdownDate: entry.shutdownDate,
    replacement: entry.replacement,
    replacementVerdict: 'verified',
    autoApplyAllowed: true,
    sourceUrl,
    occurrences: locs.length,
    tierCounts,
    highestTier: highest,
    disposition: 'review_required',
    locations: locs.map((l) => ({ file: 'src/llm.ts', line: l.line, column: 1, tier: l.tier, reason: l.reason, usageVerdict: 'verified' })),
  } as unknown as ExposedModel;
}

function coverage(over: Partial<AuditCoverage['source']> = {}): AuditCoverage {
  return {
    source: { analyzed: true, filesScanned: 10, tsFiles: 10, pyFiles: 0, ...over },
    config: { analyzed: true, filesScanned: 0 },
    registry: { providers: ['openai'] },
    runtime: { connected: false, source: null },
    readerTieBack: { proven: false },
  };
}

describe('M1 — the role is keyed on the tier, nothing else', () => {
  it('a Tier-B code occurrence is a candidate and never patch-eligible', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-4', [{ line: 12, tier: 'B', reason: 'insufficient_dataflow' }])], REGISTRY);
    expect(inv.locations.selectors[0].role).toBe('code_candidate');
    expect(inv.locations.selectors[0].patchEligible).toBe(false);
    expect(inv.decision).toBe('review');
    expect(inv.reason).not.toContain('verified provider SDK call site');
  });
  it('a Tier-A code occurrence is the verified call site', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-4', [{ line: 12, tier: 'A' }])], REGISTRY);
    expect(inv.locations.selectors[0].role).toBe('code_call_site');
    expect(inv.locations.selectors[0].patchEligible).toBe(true);
    expect(inv.decision).toBe('patch');
  });
});

describe('M6 — patch eligibility is per line, and the report says which lines', () => {
  it('a Tier-B line under a patch-eligible model is named as NOT rewritten', () => {
    const [inv] = buildInvestigations(
      NO_RUNTIME_EVIDENCE, [], NOW,
      [codeModel('gpt-4', [{ line: 24, tier: 'A' }, { line: 162, tier: 'B', reason: 'type_cast_masked' }])],
      REGISTRY,
    );
    expect(inv.decision).toBe('patch');
    const flags = Object.fromEntries(inv.locations.selectors.map((l) => [l.line, l.patchEligible]));
    expect(flags).toEqual({ 24: true, 162: false });
    expect(inv.reason).toContain('src/llm.ts:24');
    expect(inv.reason).toContain('1 other listed location(s) are not Tier A and will NOT be rewritten');
    const next = decisionLines(inv).find((l) => l.startsWith('Next action'))!;
    expect(next).toContain('mendr fix-llm <path>');
    expect(next).toContain('src/llm.ts:24');
    expect(next).not.toContain('src/llm.ts:162');
  });
});

describe('m1 — next actions never contradict the finding they sit under', () => {
  it('an INFORMATIONAL reference to a retired id asks for no migration (partner audits, 2026-09-04)', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-3.5-turbo', [{ line: 3, tier: 'C' }])], REGISTRY);
    expect(inv.decision).toBe('monitor');
    expect(inv.locations.selectors).toHaveLength(0);
    const next = decisionLines(inv).find((l) => l.startsWith('Next action'))!;
    expect(next).toBe('Next action: No migration action required from this reference. Monitor provider status.');
    expect(next).not.toContain('Migrate now');
  });
  it('a real selector on a retired id with a provider notice says migrate now', () => {
    const [inv] = buildInvestigations(
      NO_RUNTIME_EVIDENCE, [], NOW,
      [codeModel('gpt-3.5-turbo', [{ line: 3, tier: 'B', reason: 'insufficient_dataflow' }])],
      REGISTRY,
    );
    // Tier B selectors decide 'review'; force the MONITOR renderer to see the dated branch.
    const monitor = { ...inv, decision: 'monitor' as const };
    const next = decisionLines(monitor).find((l) => l.startsWith('Next action'))!;
    expect(next).toContain('Migrate now');
    expect(next).toContain('2024-09-13');
    expect(next).not.toContain('Track until');
  });
  it('a registry date with NO provider notice is never called overdue, and asks for verification', () => {
    const [inv] = buildInvestigations(
      NO_RUNTIME_EVIDENCE, [], NOW,
      [codeModel('gpt-3.5-turbo', [{ line: 3, tier: 'B', reason: 'insufficient_dataflow' }], null)],
      REGISTRY,
    );
    const monitor = { ...inv, decision: 'monitor' as const };
    const next = decisionLines(monitor).find((l) => l.startsWith('Next action'))!;
    expect(next).toContain('Verify the retirement date with the provider before acting');
    expect(next).not.toContain('Migrate now');
    const report = renderAuditReport([inv], { from: null, to: null, coverage: coverage() }).join('\n');
    expect(report).toContain('registry date 2024-09-13');
    expect(report).toContain('UNVERIFIED: no provider notice on file');
    expect(report).not.toContain('OVERDUE');
  });
});

describe('informational references are collapsed by default', () => {
  const many = Array.from({ length: INFORMATIONAL_PREVIEW + 3 }, (_, i) =>
    ({ ...codeModel('gpt-4', [{ line: i + 1, tier: 'C' as const }]), id: `gpt-4`, entryId: `gpt-4.${i}` }),
  );
  const exposure = codeModel('gpt-3.5-turbo', [{ line: 9, tier: 'B', reason: 'insufficient_dataflow' }]);
  it('shows every exposure, the first few references, and a count with the way to see the rest', () => {
    const invs = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [exposure, ...many], REGISTRY);
    const out = renderAuditReport(invs, { from: null, to: null, coverage: coverage() }).join('\n');
    expect(out).toContain('Deprecated model dependency located');
    expect(out.match(/Informational reference \(not a dependency\)/g)?.length).toBe(INFORMATIONAL_PREVIEW);
    expect(out).toContain('more informational references (not dependencies). Use --verbose to list them all, or --json.');
  });
  it('--verbose lists them all', () => {
    const invs = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [exposure, ...many], REGISTRY);
    const out = renderAuditReport(invs, { from: null, to: null, coverage: coverage(), verbose: true }).join('\n');
    expect(out.match(/Informational reference \(not a dependency\)/g)?.length).toBe(many.length);
    expect(out).not.toContain('more informational references');
  });
});

describe('M8 — a mostly-unread repository is inconclusive, not clean', () => {
  it('22 analyzed files against 1,220 JavaScript files cannot conclude no exposure', () => {
    const c = coverage({ filesScanned: 22, tsFiles: 22, unanalyzedFiles: 1220, unanalyzedLanguages: ['JavaScript (1220 files)'] });
    expect(analyzedIsMinority(c)).toBe(true);
    expect(concludeAudit(c, 0)).toBe('inconclusive');
    expect(coverageGaps(c).join('\n')).toContain('only 22 of 1242 source files');
  });
  it('a majority-analyzed repository still completes', () => {
    const c = coverage({ filesScanned: 2350, tsFiles: 2350, unanalyzedFiles: 677, unanalyzedLanguages: ['JavaScript (677 files)'] });
    expect(analyzedIsMinority(c)).toBe(false);
    expect(concludeAudit(c, 0)).toBe('no_exposure_in_completed_surfaces');
  });
  it('exposure always wins over the minority rule', () => {
    const c = coverage({ filesScanned: 22, tsFiles: 22, unanalyzedFiles: 1220 });
    expect(concludeAudit(c, 1)).toBe('exposure_detected');
  });
});

describe('M10 — skipped test files are disclosed', () => {
  it('the limits list names the count', () => {
    const c = coverage({ testFilesSkipped: 815 });
    expect(coverageGaps(c).join('\n')).toContain('815 test/spec/fixture source files were counted but their model ids were not examined');
  });
});
