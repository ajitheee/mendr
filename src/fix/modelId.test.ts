import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { applyModelIdFixes, applyModelIdFixesToProject } from './modelId.js';

// Hermetic LLM-mode tests. The ts-morph Project is built entirely in-memory
// from source strings and the registry is an inline literal, so there is no
// dependency on any installed SDK types or on the on-disk registry JSON.

/** A minimal registry covering the two model-id swaps exercised below. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-4',
    note: 'dated snapshot retired',
  },
  // A param_rename entry must be IGNORED by the model-id locator/codemod.
  {
    provider: 'openai',
    kind: 'param_rename',
    deprecated: 'max_tokens',
    replacement: 'max_completion_tokens',
    note: 'o1/o3 models',
  },
];

/**
 * Source exercising:
 *  - a TARGET model-id literal (`"gemini-2.0-flash"`),
 *  - a second target in a template literal (`` `gpt-4-0314` ``),
 *  - a DECOY longer literal (`"gemini-2.0-flash-notes"`) — must NOT match,
 *  - the SAME text inside a `// comment` — must NOT match,
 *  - a `max_tokens` key — param_rename, must NOT be touched by model-id mode.
 */
const SOURCE = `
export function makeConfig() {
  const m = "gemini-2.0-flash";               // TARGET: exact model id
  const snapshot = \`gpt-4-0314\`;               // TARGET: template literal
  const notes = "gemini-2.0-flash-notes";     // DECOY: longer value, no match
  // gemini-2.0-flash appears here as a comment and MUST stay untouched
  return { model: m, snapshot, notes, max_tokens: 256 };
}
`.trimStart();

function inMemoryProject(fileName = 'src/config.ts', source = SOURCE): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('applyModelIdFixes', () => {
  it('replaces the deprecated model id in a string literal', () => {
    const project = inMemoryProject();
    const edited = applyModelIdFixes(project, REGISTRY);

    // Two targets: the string literal AND the template literal.
    expect(edited).toHaveLength(2);

    const text = project.getSourceFileOrThrow('src/config.ts').getFullText();
    expect(text).toContain('const m = "gemini-flash-latest";');
    // Quote style is preserved per node: template literal stays backticked.
    expect(text).toContain('const snapshot = `gpt-4`;');
    // No original deprecated value survives as a code literal.
    expect(text).not.toContain('"gemini-2.0-flash"');
    expect(text).not.toContain('`gpt-4-0314`');
  });

  it('PRECISION: leaves a longer decoy literal and a same-text comment untouched', () => {
    const project = inMemoryProject();
    applyModelIdFixes(project, REGISTRY);

    const text = project.getSourceFileOrThrow('src/config.ts').getFullText();
    // Decoy: exact-value guard means "gemini-2.0-flash-notes" is NOT rewritten.
    expect(text).toContain('const notes = "gemini-2.0-flash-notes";');
    // The comment line containing the same text is trivia, never a literal.
    expect(text).toContain('// gemini-2.0-flash appears here as a comment');
    // param_rename is out of scope for model-id mode: the key is untouched.
    expect(text).toContain('max_tokens: 256');
  });

  it('finds exactly the two model-id literals (locator precision)', () => {
    const project = inMemoryProject();
    const matches = findModelIdLiterals(project, REGISTRY);

    expect(matches.map((m) => m.value).sort()).toEqual(['gemini-2.0-flash', 'gpt-4-0314']);
  });
});

describe('applyModelIdFixesToProject (diff)', () => {
  it('produces a unified diff with the swap lines, touching only changed files', () => {
    const project = inMemoryProject();
    // A second, unaffected file must NOT appear in the diff.
    project.createSourceFile('src/other.ts', 'export const greeting = "hello world";\n');

    const result = applyModelIdFixesToProject(project, REGISTRY);

    expect(result.siteCount).toBe(2);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toContain('config.ts');

    // Removed lines carry the old model id, added lines carry the replacement.
    expect(result.diff).toMatch(/^-.*gemini-2\.0-flash"/m);
    expect(result.diff).toMatch(/^\+.*gemini-flash-latest"/m);
    // The untouched file is absent from the diff.
    expect(result.diff).not.toContain('other.ts');
  });

  it('is a no-op (empty diff) when no deprecated model id is present', () => {
    const project = inMemoryProject('src/clean.ts', 'export const m = "gemini-flash-latest";\n');
    const result = applyModelIdFixesToProject(project, REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.diff).toBe('');
  });
});
