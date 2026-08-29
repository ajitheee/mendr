import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { auditUsage } from '../recon/usageAudit.js';
import { foldConfigExposure, scanConfigText } from '../config/scanConfig.js';
import type { ConfigMatch } from '../config/scanConfig.js';
import { buildInvestigations } from './investigation.js';
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

describe('buildInvestigations — selector + observed usage => REVIEW, tie-back never claimed', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-4', requests: 48210, inputTokens: 9_000_000, outputTokens: 2_000_000, costUsd: 1284 }],
    REGISTRY,
    NOW,
    { start: '2026-07-27', end: '2026-08-26' },
  );
  const config = foldConfigExposure(gpt4Config());
  const [inv] = buildInvestigations(usage, config, NOW);

  it('joins the same model across MEASURE and LOCATE into one record', () => {
    expect(inv.model).toBe('gpt-4');
    expect(inv.runtimeExposure.observed).toBe(true);
    expect(inv.runtimeExposure.requests).toBe(48210);
    expect(inv.runtimeExposure.costUsd).toBe(1284);
    expect(inv.locations.selectors).toHaveLength(1);
    expect(inv.locations.selectors[0].file).toBe('app.yaml');
    expect(inv.locations.selectors[0].role).toBe('runtime_selector_candidate');
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.locations.catalog[0].role).toBe('catalog_definition');
  });

  it('decides REVIEW REQUIRED and NEVER claims the tie-back is proven', () => {
    expect(inv.decision).toBe('review_required');
    expect(inv.verification.readerTieBackProven).toBe(false);
    expect(inv.reason).toContain('tie-back');
    expect(inv.reason).toContain('not proven');
  });

  it('carries the registry replacement as evidence, not as an applied change', () => {
    expect(inv.retirementEvidence.replacement).toBe('gpt-4o');
    expect(inv.retirementEvidence.replacementVerdict).toBe('verified');
    // The record itself never instructs a swap.
    expect(inv.reason).not.toContain('change to gpt-4o');
  });

  it('does not evaluate migration compatibility (no sandbox verify exists yet)', () => {
    expect(inv.compatibility.checked).toBe(false);
    expect(inv.compatibility.result).toBeNull();
  });
});

describe('buildInvestigations — usage without a located selector => REVIEW (measured, not located)', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-3.5-turbo', requests: 900, inputTokens: 1000, outputTokens: 200, costUsd: 12 }],
    REGISTRY,
    NOW,
  );
  const [inv] = buildInvestigations(usage, [], NOW);

  it('flags it for review and says the controlling configuration was not located', () => {
    expect(inv.model).toBe('gpt-3.5-turbo');
    expect(inv.decision).toBe('review_required');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.reason).toContain('no controlling configuration was located');
  });
});

describe('buildInvestigations — catalog reference only, no usage => MONITOR', () => {
  const usage = auditUsage([], REGISTRY, NOW); // measured, but nothing observed
  const config = foldConfigExposure(scanConfigText('legacy/models.yaml', 'supported:\n  - text-davinci-003\n', REGISTRY));
  const [inv] = buildInvestigations(usage, config, NOW);

  it('does not treat a bare reference as something live to change', () => {
    expect(inv.model).toBe('text-davinci-003');
    expect(inv.decision).toBe('monitor');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.reason).toContain('Nothing is proven live to change');
  });
});

describe('buildInvestigations — a selector with usage NOT measured => REVIEW (says not measured)', () => {
  const config = foldConfigExposure(scanConfigText('app.yaml', 'model: gpt-4\n', REGISTRY));
  const [inv] = buildInvestigations(null, config, NOW);

  it('still needs review, and admits usage was not measured', () => {
    expect(inv.decision).toBe('review_required');
    expect(inv.runtimeExposure.measured).toBe(false);
    expect(inv.reason).toContain('not measured');
    // The daysUntil fallback is computed from the registry shutdownDate.
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
    const order = buildInvestigations(usage, config, NOW).map((i) => `${i.model}:${i.decision}`);
    expect(order[0]).toBe('gpt-4:review_required');
    expect(order[order.length - 1]).toBe('text-davinci-003:monitor');
  });
});

describe('buildInvestigations — a deprecated id in a test/data fixture is NOT a selector', () => {
  // Real-repo finding (LibreChat): `model_slug: "gpt-4"` inside a conversation-export
  // fixture under api/server/utils/import/__data__/ was flagged as a runtime selector.
  const config = foldConfigExposure(
    scanConfigText('api/server/utils/import/__data__/chatgpt-export.json', '  "model_slug": "gpt-4",\n', REGISTRY),
  );
  const [inv] = buildInvestigations(null, config, NOW);

  it('demotes the fixture occurrence to a Tier-C data role and MONITOR', () => {
    expect(inv.model).toBe('gpt-4');
    expect(inv.locations.selectors).toHaveLength(0);
    expect(inv.locations.catalog).toHaveLength(1);
    expect(inv.locations.catalog[0].role).toBe('test_fixture');
    expect(inv.decision).toBe('monitor');
  });

  it('renders it as a fixture, never a runtime selector candidate', () => {
    const meta: AuditMeta = {
      from: null, to: null, usageStatus: 'not_measured', providers: [],
      totalRequests: null, totalCostUsd: null, filesScanned: 1,
    };
    const out = renderAuditReport(buildInvestigations(null, config, NOW), meta).join('\n');
    expect(out).toContain('test/data fixture (not a runtime selector)');
    expect(out).not.toContain('runtime selector candidate');
  });
});

describe('renderAuditReport — the empty-state claims only the ground it covered', () => {
  const empty: AuditMeta = { from: null, to: null, usageStatus: 'not_measured', providers: [], totalRequests: null, totalCostUsd: null, filesScanned: 5 };

  it('does NOT claim "in usage" when usage was not measured', () => {
    const out = renderAuditReport([], empty).join('\n');
    expect(out).toContain('No deprecated models found in configuration');
    expect(out).not.toContain('in usage or configuration');
  });

  it('does claim usage coverage when usage WAS measured clean', () => {
    const out = renderAuditReport([], { ...empty, usageStatus: 'ok', providers: ['openai'], totalRequests: 0, totalCostUsd: 0 }).join('\n');
    expect(out).toContain('in usage or configuration');
  });
});

describe('renderAuditReport — matches the intended per-model report shape', () => {
  const usage = auditUsage(
    [{ provider: 'openai', model: 'gpt-4', requests: 48210, inputTokens: 1, outputTokens: 1, costUsd: 1284 }],
    REGISTRY,
    NOW,
    { start: '2026-07-27', end: '2026-08-26' },
  );
  const investigations = buildInvestigations(usage, foldConfigExposure(gpt4Config()), NOW);
  const meta: AuditMeta = {
    from: '2026-07-27', to: '2026-08-26', usageStatus: 'ok', providers: ['openai'],
    totalRequests: 48210, totalCostUsd: 1284, filesScanned: 2,
  };
  const out = renderAuditReport(investigations, meta).join('\n');

  it('prints the per-model investigation fields', () => {
    expect(out).toContain('Model: gpt-4  (openai)');
    expect(out).toContain('Runtime usage: 48,210 requests, $1,284.00 observed cost');
    expect(out).toContain('app.yaml:1 — runtime selector candidate');
    expect(out).toContain('pricing.yaml:1 — catalog definition');
    expect(out).toContain('Decision: REVIEW REQUIRED');
  });

  it('shows the replacement as registry evidence, never as an instruction to change code', () => {
    expect(out).toContain('Registry replacement: gpt-4o [registry: verified]');
    expect(out).not.toMatch(/change .*gpt-4.* to gpt-4o/i);
  });

  it('states the human-review boundary in the footer', () => {
    expect(out).toContain('does not prove that a configuration');
    expect(out).toContain('every change stays under human');
  });
});
