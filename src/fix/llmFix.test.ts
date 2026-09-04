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

describe('applyLlmFixesToProject', () => {
  it('swaps the model id AND then removes temperature the new model rejects', () => {
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

    expect(result.modelIdSites).toBe(1);
    expect(result.paramsRemoved).toBe(1);
    expect(result.paramsRenamed).toBe(0);

    const text = project.getSourceFileOrThrow('src/app.ts').getFullText();
    // Retired call: model swapped AND temperature (now illegal) removed.
    expect(text).toContain('{ model: "claude-opus-5", messages }');
    // Control call on an accepting, non-retired model: fully untouched.
    expect(text).toContain(
      '{ model: "claude-3-haiku-20240307", temperature: 0, messages }',
    );
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
