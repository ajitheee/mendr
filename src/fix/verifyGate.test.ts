import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { applyLlmFixesToProject } from './llmFix.js';
import { applyModelIdFixesToProject } from './modelId.js';
import { findBlockedModelArgMatches } from '../usage/scanLiterals.js';

// THE ENGINE GATE. The behavior change this increment exists to prove:
//   auto-apply (Tier A) fires ONLY for entries stamped verification.status ===
//   'verified'. A live model-argument literal whose entry is unverified,
//   unverifiable, or unstamped is NEVER swapped — it is surfaced Tier C.

/** One entry of each trust status, all referencing ids used in the source. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'retired -> current opus',
    verification: { status: 'verified' },
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'text-davinci-003',
    replacement: 'gpt-3.5-turbo-instruct',
    note: 'chained deprecation',
    verification: {
      status: 'unverified',
      reasons: ['replacement "gpt-3.5-turbo-instruct" is itself deprecated (chained)'],
    },
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'text-moderation-latest',
    replacement: 'omni-moderation-latest',
    note: 'moderation is out-of-class',
    verification: { status: 'unverifiable' },
  },
  {
    // No verification block at all => `unstamped` => must NOT auto-apply.
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'unstamped entry',
  },
];

/** Every deprecated id sits in a genuine `model:` argument OF A CALL. */
const SOURCE = `
export const a = create({ model: "claude-3-opus-20240229" });  // verified     -> SWAP
export const b = create({ model: "text-davinci-003" });         // unverified   -> BLOCK
export const c = create({ model: "text-moderation-latest" });   // unverifiable -> BLOCK
export const d = create({ model: "gemini-2.0-flash" });         // unstamped    -> BLOCK
`.trimStart();

function inMemoryProject(fileName: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('engine gate: auto-apply only verified entries', () => {
  it('swaps the verified entry and leaves every non-verified one byte-identical', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyLlmFixesToProject(project, REGISTRY);
    const text = project.getSourceFileOrThrow('src/gate.ts').getFullText();

    // VERIFIED -> swapped.
    expect(text).toContain('{ model: "claude-opus-4-8" }');
    // UNVERIFIED (chained) -> untouched.
    expect(text).toContain('{ model: "text-davinci-003" }');
    // UNVERIFIABLE (moderation) -> untouched.
    expect(text).toContain('{ model: "text-moderation-latest" }');
    // UNSTAMPED -> untouched (a missing stamp is NOT a licence to swap).
    expect(text).toContain('{ model: "gemini-2.0-flash" }');

    // Exactly one swap fired.
    expect(result.modelIdSites).toBe(1);
    // None of the blocked replacements leaked into the source.
    expect(text).not.toContain('gpt-3.5-turbo-instruct');
    expect(text).not.toContain('omni-moderation-latest');
    expect(text).not.toContain('gemini-flash-latest');
  });

  it('surfaces the three blocked model-arg matches as Tier C, with their status', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyLlmFixesToProject(project, REGISTRY);

    expect(result.blockedMatches).toHaveLength(3);
    const byValue = Object.fromEntries(result.blockedMatches.map((b) => [b.value, b.status]));
    expect(byValue).toEqual({
      'text-davinci-003': 'unverified',
      'text-moderation-latest': 'unverifiable',
      'gemini-2.0-flash': 'unstamped',
    });
    // The stamped reasons ride along for the CLI's Tier C explanation.
    const chained = result.blockedMatches.find((b) => b.value === 'text-davinci-003');
    expect(chained?.reasons?.join(' ')).toMatch(/chained/);
  });

  it('the model-id-only path reports the same blocked matches', () => {
    const project = inMemoryProject('src/gate.ts', SOURCE);
    const result = applyModelIdFixesToProject(project, REGISTRY);
    expect(result.siteCount).toBe(1);
    expect(result.blockedMatches).toHaveLength(3);
  });

  it('a blocked id in a DATA position is NOT reported as a blocked model-arg', () => {
    // Same unverified id, but as an object KEY (data) — belongs to the data
    // surface, not the blocked-model-arg surface.
    const src = `
export const use = create({ model: "text-davinci-003" });  // model_arg + unverified -> blocked
export const PRICES = { "text-davinci-003": 1 };    // data key -> NOT a blocked model-arg
`.trimStart();
    const project = inMemoryProject('src/mixed.ts', src);
    const blocked = findBlockedModelArgMatches(project, REGISTRY);

    expect(blocked).toHaveLength(1);
    expect(blocked[0].value).toBe('text-davinci-003');
    expect(blocked[0].location.line).toBe(1);
  });
});
