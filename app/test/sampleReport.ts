import type { AuditReport } from '../src/ingest/validate.js';

/** A small mendr-audit/v3 document with one of each decision, plus two planted secrets. */
export function sampleReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    schema: 'mendr-audit/v3',
    repo: 'api',
    generatedAt: '2026-09-04T12:00:00.000Z',
    sha: null,
    conclusion: 'exposure_detected',
    investigations: [
      {
        provider: 'openai',
        model: 'gpt-4',
        decision: 'patch',
        reason: 'Tier-A call site',
        nextAction: 'run mendr fix-llm <path> and review the diff for src/client.ts:4',
        retirementEvidence: { status: 'deprecated', shutdownDate: '2026-10-23', daysUntil: 49, replacement: 'gpt-4.1' },
        locations: {
          selectors: [
            {
              file: './src/client.ts',
              line: 4,
              column: 40,
              key: 'model',
              value: 'gpt-4',
              role: 'code_call_site',
              surface: 'code',
              tier: 'A',
              disposition: 'patch',
              patchEligible: true,
              reason: 'first-party client resolved in this file',
              snippet: {
                startLine: 1,
                lines: [
                  'import OpenAI from "openai";',
                  'const client = new OpenAI();',
                  'export async function ask() {',
                  '  return client.chat.completions.create({ model: "gpt-4" });',
                  '}',
                  'const leaked = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
                  'process.env.OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123";',
                ],
              },
              lineHash: '0123456789abcdef',
            },
          ],
          catalog: [],
        },
      },
      {
        provider: 'google',
        model: 'gemini-1.5-pro',
        decision: 'review',
        reason: 'default in a config file',
        nextAction: 'verify where config/app.yaml:3 is loaded',
        retirementEvidence: { status: 'retired', shutdownDate: '2025-09-24', daysUntil: -345, replacement: 'gemini-2.5-pro' },
        locations: { selectors: [{ file: 'config/app.yaml', line: 3, disposition: 'review', tier: 'B', reason: 'config default', snippet: null }], catalog: [] },
      },
      {
        provider: 'openai',
        model: 'gpt-3.5-turbo',
        decision: 'monitor',
        reason: 'catalog entry',
        nextAction: 'No migration action required from this reference. Monitor provider status.',
        locations: { selectors: [], catalog: [{ file: 'docs/models.md', line: 12, disposition: 'informational', tier: 'C' }] },
      },
    ],
    ...overrides,
  };
}
