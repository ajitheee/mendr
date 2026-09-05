import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { auditUsage } from '../recon/usageAudit.js';
import { foldConfigExposure, scanConfigText } from '../config/scanConfig.js';
import type { ConfigMatch } from '../config/scanConfig.js';
import type { ExposedModel } from '../watch/exposure.js';
import { buildInvestigations, type AuditCoverage } from './investigation.js';
import { NO_RUNTIME_EVIDENCE, runtimeEvidenceFromUsage, type RuntimeEvidence } from '../runtime/evidence.js';
import { renderAuditReport, type AuditMeta } from '../report/auditReport.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', sourceUrl: 'https://platform.openai.com/docs/deprecations', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-4o-mini', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'text-davinci-003', replacement: 'gpt-4o-mini', status: 'retired', shutdownDate: '2024-01-04', verification: withheldVerification('unverified') },
];
const NOW = new Date('2026-08-26T00:00:00Z');

/** gpt-4 in a runtime selector (app.yaml) AND a catalog definition (pricing.yaml). */
function gpt4Config(): ConfigMatch[] {
  return [
    ...scanConfigText('app.yaml', 'model: gpt-4\n', REGISTRY),
    ...scanConfigText('pricing.yaml', 'model: gpt-4\nlabel: GPT-4\npricing:\n  input: 0.03\n', REGISTRY),
  ];
}

/** A minimal source-code ExposedModel (as the watch scanner would fold one). */
function codeModel(id: string, tier: 'A' | 'B' | 'C', reason?: string): ExposedModel {
  return {
    id,
    provider: 'openai',
    entryId: `${id}.${tier}.${reason ?? 'x'}`,
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-4o',
    replacementVerdict: 'verified',
    autoApplyAllowed: true,
    sourceUrl: null,
    occurrences: 1,
    tierCounts: { A: tier === 'A' ? 1 : 0, B: tier === 'B' ? 1 : 0, C: tier === 'C' ? 1 : 0 },
    highestTier: tier,
    disposition: 'review_required',
    locations: [{ file: 'src/llm.ts', line: 12, column: 20, tier, reason, usageVerdict: 'verified' }],
  } as unknown as ExposedModel;
}

function fullCoverage(over: Partial<AuditCoverage> = {}): AuditCoverage {
  return {
    source: { analyzed: true, filesScanned: 10, tsFiles: 10, pyFiles: 0 },
    config: { analyzed: true, filesScanned: 5 },
    registry: { providers: ['anthropic', 'google', 'openai'] },
    runtime: { connected: false, source: null },
    readerTieBack: { proven: false },
    ...over,
  };
}

describe('buildInvestigations — selector + observed usage => REVIEW, tie-back never claimed', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-4', requests: 48210, inputTokens: 9_000_000, outputTokens: 2_000_000, costUsd: 1284 }],
    REGISTRY,
    NOW,
    { start: '2026-07-27', end: '2026-08-26' },
  );
  const config = foldConfigExposure(gpt4Config());
  const [inv] = buildInvestigations(runtimeEvidenceFromUsage(usage), config, NOW);

  it('joins the same model across MEASURE and LOCATE into one record', () => {
    expect(inv.model).toBe('gpt-4');
    expect(inv.productionUsage.observed).toBe(true);
    expect(inv.productionUsage.requests).toBe(48210);
    expect(inv.productionUsage.costUsd).toBe(1284);
    expect(inv.locations.selectors).toHaveLength(1);
    expect(inv.locations.selectors[0].file).toBe('app.yaml');
    expect(inv.locations.selectors[0].role).toBe('runtime_selector_candidate');
    expect(inv.locations.selectors[0].surface).toBe('config');
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.locations.catalog[0].role).toBe('catalog_definition');
  });

  it('decides REVIEW REQUIRED and NEVER claims the tie-back is proven', () => {
    expect(inv.decision).toBe('review');
    expect(inv.verification.readerTieBackProven).toBe(false);
    expect(inv.reason).toContain('tie-back');
    expect(inv.reason).toContain('not proven');
  });

  it('carries the registry replacement as evidence, not as an applied change', () => {
    expect(inv.retirementEvidence.replacement).toBe('gpt-4o');
    expect(inv.retirementEvidence.replacementVerdict).toBe('verified');
    expect(inv.reason).not.toContain('change to gpt-4o');
  });

  it('does not evaluate migration compatibility (no sandbox verify exists yet)', () => {
    expect(inv.compatibility.checked).toBe(false);
    expect(inv.compatibility.result).toBeNull();
  });
});

describe('buildInvestigations — code call sites drive the patch/review split', () => {
  it('a Tier-A call site with a VERIFIED replacement => PATCH (a reviewed PR, never auto-merge)', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-4', 'A')]);
    expect(inv.locations.selectors).toHaveLength(1);
    expect(inv.locations.selectors[0].surface).toBe('code');
    expect(inv.locations.selectors[0].role).toBe('code_call_site');
    expect(inv.decision).toBe('patch');
    expect(inv.reason).toContain('never auto-merged');
  });

  it('a config selector is NEVER patchable — tie-back is unproven', () => {
    const config = foldConfigExposure(scanConfigText('app.yaml', 'model: gpt-4\n', REGISTRY));
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, config, NOW);
    expect(inv.retirementEvidence.replacementVerdict).toBe('verified');
    expect(inv.decision).toBe('review'); // verified successor, but config => never patch
  });

  it('treats a Tier-B usage_unverified occurrence as a candidate, not a proven call site', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-4', 'B', 'usage_unverified')]);
    expect(inv.locations.selectors[0].role).toBe('code_candidate');
    expect(inv.decision).toBe('review');
    expect(inv.reason).toContain('not proven');
  });

  it('treats a Tier-C code occurrence as a data reference => MONITOR', () => {
    const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, [], NOW, [codeModel('gpt-4', 'C')]);
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.locations.catalog[0].role).toBe('code_reference');
    expect(inv.decision).toBe('monitor');
  });
});

describe('buildInvestigations — usage without any located selector => REVIEW (measured, not located)', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-3.5-turbo', requests: 900, inputTokens: 1000, outputTokens: 200, costUsd: 12 }],
    REGISTRY,
    NOW,
  );
  const [inv] = buildInvestigations(runtimeEvidenceFromUsage(usage), [], NOW, [], REGISTRY);

  it('flags it for review and says no code or config location was found', () => {
    expect(inv.model).toBe('gpt-3.5-turbo');
    expect(inv.decision).toBe('review');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.reason).toContain('no code or config location was found');
  });
});

describe('buildInvestigations — catalog reference only, no usage => MONITOR', () => {
  const usage = auditUsage([], REGISTRY, NOW);
  const config = foldConfigExposure(scanConfigText('legacy/models.yaml', 'supported:\n  - text-davinci-003\n', REGISTRY));
  const [inv] = buildInvestigations(runtimeEvidenceFromUsage(usage), config, NOW);

  it('does not treat a bare reference as something live to change', () => {
    expect(inv.model).toBe('text-davinci-003');
    expect(inv.decision).toBe('monitor');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.reason).toContain('Nothing is proven live to change');
  });
});

describe('buildInvestigations — a config selector with usage NOT measured => REVIEW', () => {
  const config = foldConfigExposure(scanConfigText('app.yaml', 'model: gpt-4\n', REGISTRY));
  const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, config, NOW);

  it('still needs review, located as a candidate, deadline from the registry', () => {
    expect(inv.decision).toBe('review');
    expect(inv.productionUsage.measured).toBe(false);
    expect(inv.reason).toContain('config selector candidate');
    expect(inv.reason).toContain('Human review required');
    expect(inv.retirementEvidence.daysUntil).toBe(58); // 2026-08-26 -> 2026-10-23
  });
});

describe('buildInvestigations — ordering: review_required before monitor, by cost', () => {
  it('ranks the actionable, costly exposure first', () => {
    const usage = auditUsage(
      [
        { provider: 'openai', model: 'gpt-4', requests: 48210, inputTokens: 1, outputTokens: 1, costUsd: 1284 },
        { provider: 'openai', model: 'gpt-3.5-turbo', requests: 5, inputTokens: 1, outputTokens: 1, costUsd: 2 },
      ],
      REGISTRY,
      NOW,
    );
    const config = foldConfigExposure([
      ...gpt4Config(),
      ...scanConfigText('legacy/models.yaml', 'supported:\n  - text-davinci-003\n', REGISTRY),
    ]);
    const order = buildInvestigations(runtimeEvidenceFromUsage(usage), config, NOW).map((i) => `${i.model}:${i.decision}`);
    expect(order[0]).toBe('gpt-4:review');
    expect(order[order.length - 1]).toBe('text-davinci-003:monitor');
  });
});

describe('buildInvestigations — a deprecated id in a test/data fixture is NOT a selector', () => {
  // Real-repo finding (LibreChat): `model_slug: "gpt-4"` inside a conversation-export
  // fixture under api/server/utils/import/__data__/ was flagged as a runtime selector.
  const config = foldConfigExposure(
    scanConfigText('api/server/utils/import/__data__/chatgpt-export.json', '  "model_slug": "gpt-4",\n', REGISTRY),
  );
  const [inv] = buildInvestigations(NO_RUNTIME_EVIDENCE, config, NOW);

  it('demotes the fixture occurrence to a Tier-C data role and MONITOR', () => {
    expect(inv.model).toBe('gpt-4');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.locations.catalog[0].role).toBe('test_fixture');
    expect(inv.decision).toBe('monitor');
  });

  it('renders it as a fixture, never a runtime selector candidate', () => {
    const meta: AuditMeta = {
      from: null, to: null,  coverage: fullCoverage(),
    };
    const out = renderAuditReport(buildInvestigations(NO_RUNTIME_EVIDENCE, config, NOW), meta).join('\n');
    expect(out).toContain('test/data fixture (not a selector)');
    expect(out).not.toContain('runtime selector candidate');
  });
});

describe('renderAuditReport — the conclusion is one of exactly four, and never a general "clean"', () => {
  const base = { from: null, to: null,  };

  // Runtime is OPTIONAL by design: a repo-only audit is a COMPLETE audit of the
  // surfaces it covers. It must not be downgraded merely for having no key — but
  // it must still disclose that liveness is unknown.
  it('source completed, runtime NOT connected => NO EXPOSURE IN COMPLETED SURFACES', () => {
    const out = renderAuditReport([], { ...base, coverage: fullCoverage() }).join('\n');
    expect(out).toContain('Conclusion: NO EXPOSURE IN COMPLETED SURFACES');
    expect(out).toContain('runtime measurement was not enabled');
    expect(out).not.toMatch(/\bCLEAN\b/);
  });

  it('usage measured + source scanned + 0 findings => NO EXPOSURE IN COMPLETED SURFACES (not "clean")', () => {
    const meta: AuditMeta = {
      ...base, 
      coverage: fullCoverage({ usage: { analyzed: true, provider: 'openai' } }),
    };
    const out = renderAuditReport([], meta).join('\n');
    expect(out).toContain('Conclusion: NO EXPOSURE IN COMPLETED SURFACES');
    expect(out).toContain('not a general all-clear');
    expect(out).not.toMatch(/\bCLEAN\b/);
  });

  it('source SKIPPED => INCONCLUSIVE even when usage was measured', () => {
    const meta: AuditMeta = {
      ...base, 
      coverage: fullCoverage({
        source: { analyzed: false, filesScanned: 0, tsFiles: 0, pyFiles: 0 },
        runtime: { connected: true, source: 'provider_api' },
      }),
    };
    const out = renderAuditReport([], meta).join('\n');
    expect(out).toContain('Conclusion: INCONCLUSIVE');
    expect(out).toContain('source code (TS/TSX/Python) was not scanned');
  });

  it('a FAILED surface => AUDIT FAILED, never a no-exposure verdict', () => {
    const meta: AuditMeta = {
      ...base, 
      coverage: fullCoverage({
        source: { analyzed: false, failed: true, filesScanned: 0, tsFiles: 0, pyFiles: 0 },
        runtime: { connected: true, source: 'provider_api' },
      }),
    };
    const out = renderAuditReport([], meta).join('\n');
    expect(out).toContain('Conclusion: AUDIT FAILED');
    expect(out).toContain('these results are unreliable');
  });

  it('always prints the coverage report with every surface and the tie-back row', () => {
    const out = renderAuditReport([], { ...base, coverage: fullCoverage() }).join('\n');
    expect(out).toContain('Audit coverage');
    expect(out).toContain('✓ Source code:');
    expect(out).toContain('✓ Configuration:');
    expect(out).toContain('✓ Registry:');
    expect(out).toContain('○ Runtime usage:     not measured — no runtime source connected (optional)');
    expect(out).toContain('○ Reader tie-back:   not proven');
  });

  it('discloses the provider notes (unqueried categories) when usage was read', () => {
    const meta: AuditMeta = {
      ...base, 
      coverage: fullCoverage({
        runtime: { connected: true, source: 'provider_api', notes: ['Chat Completions + Responses only. Embeddings … are NOT queried.'] },
      }),
    };
    const out = renderAuditReport([], meta).join('\n');
    expect(out).toContain('are NOT queried');
  });
});

describe('renderAuditReport — matches the intended per-model report shape', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-4', requests: 48210, inputTokens: 1, outputTokens: 1, costUsd: 1284 }],
    REGISTRY,
    NOW,
    { start: '2026-07-27', end: '2026-08-26' },
  );
  const investigations = buildInvestigations(runtimeEvidenceFromUsage(usage), foldConfigExposure(gpt4Config()), NOW);
  const meta: AuditMeta = {
    from: '2026-07-27', to: '2026-08-26', 
    coverage: fullCoverage({ config: { analyzed: true, filesScanned: 2 }, usage: { analyzed: true, provider: 'openai' } }),
  };
  const out = renderAuditReport(investigations, meta).join('\n');

  it('prints the per-model investigation fields', () => {
    expect(out).toContain('Model: gpt-4  (openai)');
    expect(out).toContain('Production usage: OBSERVED — 48,210 requests');
    expect(out).toContain('app.yaml:1 — config runtime selector candidate');
    expect(out).toContain('pricing.yaml:1 — config catalog definition');
    expect(out).toContain('Decision: REVIEW REQUIRED');
    expect(out).toContain('Status: No change applied');
  });

  it('shows the replacement as registry evidence, never as an instruction to change code', () => {
    expect(out).toContain('Migration evidence: gpt-4o [registry: verified]');
    expect(out).not.toMatch(/change .*gpt-4.* to gpt-4o/i);
  });

  it('states the human-review boundary in the footer', () => {
    expect(out).toContain('reader tie-back');
    expect(out).toContain('is not traced');
    expect(out).toContain('every config change stays under human review');
  });
});
