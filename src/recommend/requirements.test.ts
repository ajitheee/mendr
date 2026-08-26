import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { extractRequirementsTs, mergeRequirements } from './requirements.js';
import type { ExtractedRequirement, RequirementKey } from './types.js';

const registry: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o' },
];

function reqsFor(source: string): ExtractedRequirement[] {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('app.ts', source);
  const matches = findModelIdLiterals(project, registry).filter(
    (m) => m.position === 'model_arg' && m.value === 'gpt-4',
  );
  expect(matches.length).toBeGreaterThan(0);
  return extractRequirementsTs(matches[0].node, 'app.ts:1');
}

function state(reqs: ExtractedRequirement[], key: RequirementKey): string {
  return reqs.find((r) => r.key === key)!.state;
}

describe('extractRequirementsTs — criterion 3 (tri-state: required / not_observed / unknown)', () => {
  it('a call passing tools makes tools required', () => {
    const reqs = reqsFor(
      `const c: any = {}; c.chat.completions.create({ model: "gpt-4", tools: [] });`,
    );
    expect(state(reqs, 'tools')).toBe('required');
  });

  it('a fully-visible call without tools makes tools not_observed', () => {
    const reqs = reqsFor(
      `const c: any = {}; c.chat.completions.create({ model: "gpt-4", max_tokens: 500 });`,
    );
    expect(state(reqs, 'tools')).toBe('not_observed');
  });

  it('resolves minOutputTokens and endpoint from the call', () => {
    const reqs = reqsFor(
      `const c: any = {}; c.chat.completions.create({ model: "gpt-4", max_tokens: 800 });`,
    );
    const min = reqs.find((r) => r.key === 'minOutputTokens')!;
    expect(min.state).toBe('required');
    expect(min.min).toBe(800);
    const ep = reqs.find((r) => r.key === 'endpoint')!;
    expect(ep.state).toBe('required');
    expect(ep.endpointFamily).toBe('chat_completions');
  });

  it('a model id assigned to a variable (options not visible) makes EVERY requirement unknown', () => {
    const reqs = reqsFor(`const modelName = "gpt-4"; export { modelName };`);
    for (const r of reqs) expect(r.state).toBe('unknown');
  });

  it('a non-literal output cap becomes unknown, not required', () => {
    const reqs = reqsFor(
      `const c: any = {}; const n = 5; c.chat.completions.create({ model: "gpt-4", max_tokens: n });`,
    );
    expect(state(reqs, 'minOutputTokens')).toBe('unknown');
  });

  it('does NOT set vision required from image_url mentioned inside a prompt STRING', () => {
    const reqs = reqsFor(
      `const c: any = {}; c.chat.completions.create({ model: "gpt-4", messages: [{ role: "user", content: "Extract the image_url field." }] });`,
    );
    expect(state(reqs, 'vision')).toBe('not_observed');
  });

  it('sets vision required from a STRUCTURAL image_url content block', () => {
    const reqs = reqsFor(
      `const c: any = {}; c.chat.completions.create({ model: "gpt-4", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });`,
    );
    expect(state(reqs, 'vision')).toBe('required');
  });
});

describe('mergeRequirements — strongest state wins across occurrences', () => {
  it('required beats not_observed, and the max floor wins', () => {
    const a = reqsFor(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", tools: [], max_tokens: 500 });`);
    const b = reqsFor(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", max_tokens: 2000 });`);
    const merged = mergeRequirements([a, b]);
    expect(merged.find((r) => r.key === 'tools')!.state).toBe('required');
    expect(merged.find((r) => r.key === 'minOutputTokens')!.min).toBe(2000);
  });

  it('an unknown output cap at ANY site keeps the merged floor unknown (an unanalyzable site raises review)', () => {
    const a = reqsFor(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", max_tokens: 500 });`);
    const b = reqsFor(`const c: any = {}; const n = 5; c.chat.completions.create({ model: "gpt-4", max_tokens: n });`);
    expect(mergeRequirements([a, b]).find((r) => r.key === 'minOutputTokens')!.state).toBe('unknown');
  });

  it('an unresolvable endpoint at ANY site keeps the merged endpoint unknown', () => {
    const a = reqsFor(`const c: any = {}; c.chat.completions.create({ model: "gpt-4", max_tokens: 500 });`);
    const b = reqsFor(`const c: any = {}; c.mystery({ model: "gpt-4" });`);
    expect(mergeRequirements([a, b]).find((r) => r.key === 'endpoint')!.state).toBe('unknown');
  });
});
