import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { applyLlmFixesToProject } from './llmFix.js';

// The combined `fix-llm` orchestration: model-id swap FIRST, then the
// model-coupled param pass over the already-swapped models — folded into ONE
// diff with a per-transform breakdown.

/** A retired Opus id whose CURRENT replacement is itself a temperature-rejecting model. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-5',
    note: 'retired -> current opus',
    verification: autoApplyVerification(),
  },
  {
    provider: 'anthropic',
    kind: 'param_removal',
    param: 'temperature',
    on_models: ['claude-opus-5'],
    note: 'temperature rejected on opus 5',
  },
];

function inMemoryProject(fileName: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

/**
 * A reasoning model moving to another reasoning model: the rename means the same thing on both,
 * so the swap stays automatic and the param pass runs over the swapped call.
 */
const REASONING_REGISTRY: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1',
    replacement: 'gpt-5.6-sol',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1', 'gpt-5.6'],
  },
];

describe('applyLlmFixesToProject', () => {
  it('swaps the model id FIRST, then runs the param pass over the swapped call', () => {
    const source = `
import OpenAI from "openai";
const client = new OpenAI();
export const run = (messages: any) => client.chat.completions.create({ model: "o1", max_tokens: 500, messages });
`.trimStart();
    const project = inMemoryProject('src/r.ts', source);
    const result = applyLlmFixesToProject(project, REASONING_REGISTRY);

    expect(result.modelIdSites).toBe(1);
    expect(result.paramsRenamed).toBe(1);
    expect(project.getSourceFileOrThrow('src/r.ts').getFullText()).toContain(
      '{ model: "gpt-5.6-sol", max_completion_tokens: 500, messages }',
    );
  });

  it('does NOT apply a swap that would drop a temperature the old model honoured: a person decides', () => {
    // CHANGED 2026-10-05. This test used to expect the swap AND the removal, unattended.
    // `temperature: 0` asks for the most deterministic output; claude-opus-5 rejects any
    // non-default value, so the migration has to drop it, and the answers change character.
    // The rule starts applying only at the replacement (paramRulesStartingAt), so the swap is
    // review, not an automatic patch, and fix-llm leaves the call as it is.
    const source = `
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
export async function run(messages: any) {
  const migrated = await client.messages.create({ model: "claude-3-opus-20240229", temperature: 0, messages });
  const untouched = await client.messages.create({ model: "claude-3-haiku-20240307", temperature: 0, messages });
  return { migrated, untouched };
}
`.trimStart();
    const project = inMemoryProject('src/app.ts', source);
    const result = applyLlmFixesToProject(project, REGISTRY);

    expect(result.modelIdSites).toBe(0);
    expect(result.paramsRemoved).toBe(0);
    expect(result.paramsRenamed).toBe(0);

    const text = project.getSourceFileOrThrow('src/app.ts').getFullText();
    // The retired call is left for review, unchanged.
    expect(text).toContain('{ model: "claude-3-opus-20240229", temperature: 0, messages }');
    // Control call on an accepting, non-retired model: fully untouched.
    expect(text).toContain(
      '{ model: "claude-3-haiku-20240307", temperature: 0, messages }',
    );
  });

  it('never runs the param pass over a call the scan held for review', () => {
    // ADDED 2026-10-07. A call under examples/ is held at review (a sample is never patched),
    // so pass 1 leaves its model id alone. Pass 2 used to rename its max_tokens anyway: the
    // model id was "no patch generated" while the same call's request sat in the diff.
    const source = `
import OpenAI from "openai";
const client = new OpenAI();
export const demo = (messages: any) => client.chat.completions.create({ model: "o1", max_tokens: 500, messages });
`.trimStart();
    const project = inMemoryProject('examples/demo.ts', source);
    const result = applyLlmFixesToProject(project, REASONING_REGISTRY);

    expect(result.modelIdSites).toBe(0);
    expect(result.paramsRenamed).toBe(0);
    expect(result.diff).toBe('');
    expect(project.getSourceFileOrThrow('examples/demo.ts').getFullText()).toBe(source);
  });

  it('with paramsOnSwappedCallsOnly, applies parameter rules only where pass 1 swapped', () => {
    // migrate --only: the person approved o1, so the o1 call is swapped and its max_tokens
    // follows the new model. o1-pro has no record here (nobody approved it), and the rule names
    // o1, so without the option pass 2 renamed its max_tokens too.
    const source = `
import OpenAI from "openai";
const client = new OpenAI();
export const approved = (messages: any) => client.chat.completions.create({ model: "o1", max_tokens: 1, messages });
export const other = (messages: any) => client.chat.completions.create({ model: "o1-pro", max_tokens: 2, messages });
`.trimStart();
    const restricted = inMemoryProject('src/r.ts', source);
    const onlySwapped = applyLlmFixesToProject(restricted, REASONING_REGISTRY, undefined, {
      paramsOnSwappedCallsOnly: true,
    });
    expect(onlySwapped.modelIdSites).toBe(1);
    expect(onlySwapped.paramsRenamed).toBe(1);
    const text = restricted.getSourceFileOrThrow('src/r.ts').getFullText();
    expect(text).toContain('{ model: "gpt-5.6-sol", max_completion_tokens: 1, messages }');
    expect(text).toContain('{ model: "o1-pro", max_tokens: 2, messages }');

    // The default is unchanged: a call whose current model a rule names gets the rule.
    const full = inMemoryProject('src/r.ts', source);
    expect(applyLlmFixesToProject(full, REASONING_REGISTRY).paramsRenamed).toBe(2);
  });

  it('is a no-op with an empty diff when nothing matches', () => {
    const project = inMemoryProject(
      'src/clean.ts',
      'export const cfg = { model: "claude-3-haiku-20240307", temperature: 0 };\n',
    );
    const result = applyLlmFixesToProject(project, REGISTRY);

    expect(result.modelIdSites).toBe(0);
    expect(result.paramsRemoved).toBe(0);
    expect(result.diff).toBe('');
  });
});
