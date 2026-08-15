import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { findParamSites, applyParamFixes, applyParamFixesToProject } from './paramFix.js';

// Hermetic tests for the MODEL-COUPLED param codemod. The Project is built
// in-memory from source strings and the registry is an inline literal, so there
// is no dependency on installed SDK types or the on-disk registry JSON.
//
// The single property under test is the whole point of the feature: a param is
// only transformed when the model RESOLVED AT ITS CALL SITE is in `on_models`.
// The precision showcase proves an accepting model KEEPS its temperature.

/** Anthropic removals (Opus 4.7+) + OpenAI reasoning-model rename. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'temperature',
    on_models: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'],
    note: 'temperature rejected on Opus 4.7+',
  },
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'top_p',
    on_models: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'],
    note: 'top_p rejected on Opus 4.7+',
  },
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1', 'o3', 'o4', 'gpt-5'],
    note: 'reasoning models require max_completion_tokens',
  },
];

function inMemoryProject(fileName: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('param_removal (temperature)', () => {
  // Both calls live in the SAME file: one on a rejecting model, one on an
  // accepting model that is NOT in on_models (and not a model_id retirement).
  const SOURCE = `
export async function run(client: any, messages: any) {
  const rejecting = await client.messages.create({ model: "claude-opus-5", temperature: 0, max_tokens: 1024, messages });
  const accepting = await client.messages.create({ model: "claude-3-haiku-20240307", temperature: 0, max_tokens: 1024, messages });
  return { rejecting, accepting };
}
`.trimStart();

  it('removes temperature on a rejecting model, keeping the other props', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    const edits = applyParamFixes(project, REGISTRY);

    // Exactly one removal fired: the rejecting-model call.
    expect(edits).toEqual([
      { kind: 'param_removal', param: 'temperature', model: 'claude-opus-5' },
    ]);

    const text = project.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    // Rejecting call: temperature gone, siblings intact.
    expect(text).toContain('{ model: "claude-opus-5", max_tokens: 1024, messages }');
  });

  it('PRECISION SHOWCASE: an accepting model KEEPS its temperature', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    applyParamFixes(project, REGISTRY);

    const text = project.getSourceFileOrThrow('src/anthropic.ts').getFullText();
    // The accepting model is untouched — temperature stays exactly as written.
    expect(text).toContain(
      '{ model: "claude-3-haiku-20240307", temperature: 0, max_tokens: 1024, messages }',
    );
    // And there is still exactly ONE surviving `temperature:` in the file.
    expect(text.match(/temperature:/g)).toHaveLength(1);
  });

  it('locator only reports the rejecting-model site (coupling is in the locator)', () => {
    const project = inMemoryProject('src/anthropic.ts', SOURCE);
    const sites = findParamSites(project, REGISTRY);

    expect(sites).toHaveLength(1);
    expect(sites[0].model).toBe('claude-opus-5');
    expect(sites[0].deprecation.param).toBe('temperature');
  });
});

describe('param_rename (max_tokens -> max_completion_tokens)', () => {
  const SOURCE = `
export async function run(client: any) {
  const reasoning = await client.chat.completions.create({ model: "o1-mini", max_tokens: 100 });
  const classic = await client.chat.completions.create({ model: "gpt-4o", max_tokens: 100 });
  return { reasoning, classic };
}
`.trimStart();

  it('renames the key on a reasoning model and keeps it on an accepting model', () => {
    const project = inMemoryProject('src/openai.ts', SOURCE);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toEqual([
      {
        kind: 'param_rename',
        param: 'max_tokens',
        replacement: 'max_completion_tokens',
        model: 'o1-mini',
      },
    ]);

    const text = project.getSourceFileOrThrow('src/openai.ts').getFullText();
    // o1-mini (matches "o1" by prefix): renamed, value preserved.
    expect(text).toContain('{ model: "o1-mini", max_completion_tokens: 100 }');
    // gpt-4o accepts max_tokens: kept verbatim.
    expect(text).toContain('{ model: "gpt-4o", max_tokens: 100 }');
  });
});

describe('model resolution', () => {
  it('resolves the model through a same-file const (best effort)', () => {
    const source = `
export async function run(client: any, messages: any) {
  const m = "claude-opus-5";
  return client.messages.create({ model: m, temperature: 0, messages });
}
`.trimStart();
    const project = inMemoryProject('src/const-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    // Const-bound model resolved to claude-opus-5 -> temperature removed.
    expect(edits).toEqual([
      { kind: 'param_removal', param: 'temperature', model: 'claude-opus-5' },
    ]);
    const text = project.getSourceFileOrThrow('src/const-model.ts').getFullText();
    expect(text).toContain('{ model: m, messages }');
    expect(text).not.toContain('temperature');
  });

  it('SKIPS a site whose model cannot be resolved to a concrete string', () => {
    // Model comes from an env var: unresolvable -> never guessed, never edited.
    const source = `
export async function run(client: any, messages: any) {
  return client.messages.create({ model: process.env.MODEL as string, temperature: 0, messages });
}
`.trimStart();
    const project = inMemoryProject('src/env-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toHaveLength(0);
    const text = project.getSourceFileOrThrow('src/env-model.ts').getFullText();
    // Untouched: an unprovable model is left exactly as the developer wrote it.
    expect(text).toContain('temperature: 0');
  });

  it('SKIPS an object literal that has the param but no model property', () => {
    const source = `
export const opts = { temperature: 0, max_tokens: 100 };
`.trimStart();
    const project = inMemoryProject('src/no-model.ts', source);
    const edits = applyParamFixes(project, REGISTRY);

    expect(edits).toHaveLength(0);
    expect(project.getSourceFileOrThrow('src/no-model.ts').getFullText()).toContain(
      'temperature: 0',
    );
  });
});

describe('applyParamFixesToProject (diff)', () => {
  it('produces a unified diff with per-kind counts, touching only changed files', () => {
    const source = `
export async function run(client: any, messages: any) {
  await client.messages.create({ model: "claude-opus-5", temperature: 0, messages });
  await client.chat.completions.create({ model: "o1", max_tokens: 100 });
}
`.trimStart();
    const project = inMemoryProject('src/mixed.ts', source);
    // An unaffected file must NOT appear in the diff.
    project.createSourceFile('src/other.ts', 'export const greeting = "hello world";\n');

    const result = applyParamFixesToProject(project, REGISTRY);

    expect(result.removed).toBe(1);
    expect(result.renamed).toBe(1);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toContain('mixed.ts');
    expect(result.diff).toMatch(/^-.*temperature: 0/m);
    expect(result.diff).toMatch(/^\+.*max_completion_tokens: 100/m);
    expect(result.diff).not.toContain('other.ts');
  });

  it('is a no-op (empty diff) when no model-coupled param is present', () => {
    const project = inMemoryProject(
      'src/clean.ts',
      'export const cfg = { model: "gpt-4o", max_tokens: 100 };\n',
    );
    const result = applyParamFixesToProject(project, REGISTRY);

    expect(result.removed).toBe(0);
    expect(result.renamed).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.diff).toBe('');
  });
});
