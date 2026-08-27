import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { foldConfigExposure, scanConfigText } from '../config/scanConfig.js';
import { renderConfigReport } from './configReport.js';

const REGISTRY: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];
const NOW = new Date('2026-08-26T00:00:00Z');

// The positive path: gpt-4 appears three ways across the repo — as a direct
// runtime selector (change it), behind an Azure surface (ambiguous, do NOT offer
// a direct-provider swap), and as a model-definition catalog file (Tier C data).
// A single fold + render must keep those three honest categories apart.
describe('renderConfigReport — the three LOCATE categories render distinctly', () => {
  const matches = [
    ...scanConfigText('app.yaml', 'model: gpt-4\n', REGISTRY),
    ...scanConfigText('azure/config.yaml', 'model: gpt-4\n', REGISTRY),
    ...scanConfigText('models/openai/models/llm/gpt-4.yaml', 'model: gpt-4\nlabel: GPT-4\nmodel_type: llm\n', REGISTRY),
  ];
  const exposures = foldConfigExposure(matches);
  const out = renderConfigReport(exposures, 3, NOW).join('\n');

  it('folds the three occurrences into a single deprecated id', () => {
    expect(exposures).toHaveLength(1);
    expect(out).toContain('Config LOCATE scan — 3 config file(s)');
    expect(out).toContain('gpt-4  (openai, 58d left)');
  });

  it('tallies each category once in the summary', () => {
    expect(out).toContain('1 runtime selector(s) to change [verified]');
    expect(out).toContain('1 provider-ambiguous');
    expect(out).toContain('1 catalog definition(s)');
  });

  it('recommends changing ONLY the direct, verified runtime selector — with the tie-back caveat', () => {
    expect(out).toContain('Runtime selector located -> change to gpt-4o [registry: verified]:');
    expect(out).toContain('- app.yaml:1  model: gpt-4');
    expect(out).toContain('reader tie-back not proven');
  });

  it('marks the Azure surface as ambiguous — exposure only, no direct-provider swap', () => {
    expect(out).toContain('Provider surface ambiguous');
    expect(out).toContain('surface: azure_openai');
  });

  it('marks the model-definition file as a Tier C definition, not a selection', () => {
    expect(out).toContain('Catalog definition — defines the model, not a selection (Tier C): 1 location(s)');
  });

  it('closes with the legend that defines "to change"', () => {
    expect(out).toContain('Legend: "to change" = a runtime selector with a verified replacement on a direct provider.');
  });
});

describe('renderConfigReport — a clean repo says so', () => {
  it('reports no deprecated ids when the fold is empty', () => {
    const out = renderConfigReport([], 12, NOW).join('\n');
    expect(out).toContain('Config LOCATE scan — 12 config file(s)');
    expect(out).toContain('No deprecated model ids found in config.');
  });
});
