import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { applyModelIdFixes, applyModelIdFixesToProject } from './modelId.js';

// Hermetic LLM-mode tests. The ts-morph Project is built entirely in-memory
// from source strings and the registry is an inline literal, so there is no
// dependency on any installed SDK types or on the on-disk registry JSON.

/** A minimal registry covering the two model-id swaps exercised below.
 * Both swap targets are stamped `verified` — the engine gate only auto-applies
 * entries with `verification.status === 'verified'`. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-4',
    note: 'dated snapshot retired',
    verification: { status: 'verified' },
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
 *  - a TARGET model-id literal in a model-named const (`"gemini-2.0-flash"`),
 *  - a second target in a model-named const template literal (`` `gpt-4-0314` ``),
 *  - a DECOY longer literal (`"gemini-2.0-flash-notes"`) — must NOT match,
 *  - the SAME text inside a `// comment` — must NOT match,
 *  - a `max_tokens` key — param_rename, must NOT be touched by model-id mode.
 *
 * NOTE: the two TARGET consts are deliberately named model-like (`model`,
 * `modelSnapshot`) so they sit in a genuine model-argument position — the
 * call-site-aware swap only rewrites `model_arg` positions, never bare data.
 */
const SOURCE = `
export function makeConfig() {
  const model = "gemini-2.0-flash";           // TARGET: model-named const
  const modelSnapshot = \`gpt-4-0314\`;          // TARGET: model-named const, template literal
  const notes = "gemini-2.0-flash-notes";     // DECOY: longer value, no match
  // gemini-2.0-flash appears here as a comment and MUST stay untouched
  return { model, modelSnapshot, notes, max_tokens: 256 };
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
    expect(text).toContain('const model = "gemini-flash-latest";');
    // Quote style is preserved per node: template literal stays backticked.
    expect(text).toContain('const modelSnapshot = `gpt-4`;');
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

// --- CALL-SITE AWARENESS (regression suite for the data-vs-argument fix) ----
//
// Built from the REAL 30-repo failure modes: the same deprecated string is a
// LIVE model argument in some positions (must swap) and pure DATA in others — a
// pricing-table key, a model-picker array element, a normalization-map value
// (must be left byte-identical, surfaced Tier C). All cases live in ONE
// in-memory project so a single codemod run must get every position right.

/** Covers exactly the ids referenced by the call-site source below. All are
 * stamped `verified` so the call-site test isolates the DATA-vs-argument
 * behavior from the verification gate (the gate itself is tested separately). */
const CALL_SITE_REGISTRY: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-vision-preview',
    replacement: 'gpt-4o',
    note: 'vision-preview folded into gpt-4o',
    verification: { status: 'verified' },
  },
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'Claude 3 Opus retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-5-sonnet-20241022',
    replacement: 'claude-sonnet-4-5',
    note: 'Claude 3.5 Sonnet v2 retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1-mini',
    replacement: 'o4-mini',
    note: 'o1-mini deprecated',
    verification: { status: 'verified' },
  },
];

const CALL_SITE_SOURCE = `
import { google } from "@ai-sdk/google";

// MUST SWAP (a): value of a model-like property key.
export async function vision(client: any) {
  return client.chat.completions.create({ model: "gpt-4-vision-preview" });
}

// MUST SWAP (b): initializer of a model-named const.
export const MODEL_NAME = "gemini-2.0-flash";

// MUST SWAP (c): direct string argument to a model factory.
export const gModel = google("gemini-2.0-flash");

// MUST SWAP (a + fallback): literal inside a || fallback of a model: value.
export function pickModel(opts: { model?: string }) {
  return { model: opts.model || "claude-3-opus-20240229" };
}

// MUST NOT SWAP: object KEY of a pricing table (duplicate-key corruption risk).
export const PRICES = {
  "claude-3-5-sonnet-20241022": { price: 3 },
};

// MUST NOT SWAP: array element of a model-picker list.
export const CHOICES = ["o1-mini", "o4-mini"];

// MUST NOT SWAP: value keyed by a NON-model key (normalization map).
export const NORMALIZE = { premium: "claude-3-5-sonnet-20241022" };
`.trimStart();

describe('call-site awareness: swap live model arguments, skip data', () => {
  it('SWAPS all four genuine model-argument positions', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/callsites.ts').getFullText();

    // (a) model: property value.
    expect(text).toContain('{ model: "gpt-4o" }');
    // (b) model-named const.
    expect(text).toContain('export const MODEL_NAME = "gemini-flash-latest";');
    // (c) model-factory argument.
    expect(text).toContain('google("gemini-flash-latest")');
    // (a + ||) fallback inside a model: value.
    expect(text).toContain('model: opts.model || "claude-opus-4-8"');

    // Exactly the four live positions were edited (the 3 data ids were skipped).
    expect(result.siteCount).toBe(4);
  });

  it('LEAVES every data position byte-identical (no key/array/map edits)', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/callsites.ts').getFullText();

    // Pricing-table KEY: untouched (swapping it would collide / corrupt).
    expect(text).toContain('"claude-3-5-sonnet-20241022": { price: 3 }');
    // Model-picker ARRAY element: untouched.
    expect(text).toContain('export const CHOICES = ["o1-mini", "o4-mini"];');
    // Normalization-map VALUE under a non-model key: untouched.
    expect(text).toContain('export const NORMALIZE = { premium: "claude-3-5-sonnet-20241022" };');
    // The data ids' replacement never appears — proof no accidental swap fired.
    // (`claude-3-5-sonnet-20241022` would map to `claude-sonnet-4-5`.)
    expect(text).not.toContain('claude-sonnet-4-5');
  });

  it('SURFACES the rejected-but-matched ids as Tier C locate-only', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);

    // Three data-position matches: the pricing key, the array element, the map
    // value — reported for manual review, not swapped.
    expect(result.dataMatches).toHaveLength(3);
    const values = result.dataMatches.map((d) => d.value).sort();
    expect(values).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20241022',
      'o1-mini',
    ]);
    // Each carries the replacement it WOULD map to (context only) + a location.
    for (const d of result.dataMatches) {
      expect(d.replacement).toBeTruthy();
      expect(d.location.line).toBeGreaterThan(0);
    }
  });

  it('locator tags each match with its classified position', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    const matches = findModelIdLiterals(project, CALL_SITE_REGISTRY);

    const swaps = matches.filter((m) => m.position === 'model_arg');
    const data = matches.filter((m) => m.position === 'data');
    expect(swaps).toHaveLength(4);
    expect(data).toHaveLength(3);
  });
});
