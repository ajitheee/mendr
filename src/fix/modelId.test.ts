import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import {
  fileAnnotation,
  findModelIdLiterals,
  scanProjectAnnotations,
} from '../usage/scanLiterals.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
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
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-0314',
    replacement: 'gpt-4',
    note: 'dated snapshot retired',
    verification: autoApplyVerification(),
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
import OpenAI from "openai";
const client = new OpenAI();
export function makeConfig() {
  const model = "gemini-2.0-flash";           // TARGET: model-named const
  const modelSnapshot = \`gpt-4-0314\`;          // TARGET: model-named const, template literal
  const notes = "gemini-2.0-flash-notes";     // DECOY: longer value, no match
  // gemini-2.0-flash appears here as a comment and MUST stay untouched
  // Both targets are CONSUMED by a resolved first-party request (the sink rule);
  // a model-named const nothing feeds to a request is a review candidate.
  void client.chat.completions.create({ model });
  void client.chat.completions.create({ model: modelSnapshot });
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
    verification: autoApplyVerification(),
  },
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'Claude 3 Opus retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-5-sonnet-20241022',
    replacement: 'claude-sonnet-4-5',
    note: 'Claude 3.5 Sonnet v2 retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1-mini',
    replacement: 'o4-mini',
    note: 'o1-mini deprecated',
    verification: autoApplyVerification(),
  },
];

const CALL_SITE_SOURCE = `
import { google } from "@ai-sdk/google";

// MUST SWAP (a): value of a model-like property key.
import OpenAI from "openai";
const client = new OpenAI();
export async function vision() {
  return client.chat.completions.create({ model: "gpt-4-vision-preview" });
}

// MUST SWAP (b): initializer of a model-named const — because it is CONSUMED by
// a resolved first-party factory inside a function (the sink rule). A model-named
// const that nothing feeds to a request is a review candidate, never a swap.
export const MODEL_NAME = "gemini-2.0-flash";
export function named() {
  return google(MODEL_NAME);
}

// MUST SWAP (c): direct string argument to a model factory, inside a function
// (module-level execution is capped at review).
export function gModel() {
  return google("gemini-2.0-flash");
}

// MUST NOT SWAP: a model id in a STANDALONE returned object (not passed to a
// call). Same shape as a catalog entry, so the conservative call-flow rule
// leaves it as data rather than risk a catalog-corrupting swap. Surfaced Tier C.
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
  it('SWAPS the three genuine call-flow positions', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/callsites.ts').getFullText();

    // (a) model: property value of an object PASSED TO A CALL.
    expect(text).toContain('{ model: "gpt-4o" }');
    // (b) model-named const.
    expect(text).toContain('export const MODEL_NAME = "gemini-flash-latest";');
    // (c) model-factory argument.
    expect(text).toContain('google("gemini-flash-latest")');

    // Exactly the three call-flow positions were edited; the standalone returned
    // config and the 3 data ids were skipped.
    expect(result.siteCount).toBe(3);
  });

  it('LEAVES every data position byte-identical (no key/array/map/catalog edits)', () => {
    const project = inMemoryProject('src/callsites.ts', CALL_SITE_SOURCE);
    applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/callsites.ts').getFullText();

    // Standalone returned config object (not a call argument): untouched.
    expect(text).toContain('model: opts.model || "claude-3-opus-20240229"');
    expect(text).not.toContain('claude-opus-4-8');
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

    // Four data-position matches: the standalone returned config, the pricing
    // key, the array element, the map value — reported for review, not swapped.
    expect(result.dataMatches).toHaveLength(4);
    const values = result.dataMatches.map((d) => d.value).sort();
    expect(values).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
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
    expect(swaps).toHaveLength(3);
    expect(data).toHaveLength(4);
  });

  it('tags each data match with a purpose (purpose-aware Tier C language)', () => {
    const src = `
export function pick(m: string) {
  if (m === "claude-3-opus-20240229") return m;      // comparison
  return { model: "claude-3-opus-20240229" };        // standalone object value
}
export const PRICES = { "o1-mini": 1 };              // lookup key
export const CHOICES = ["gemini-2.0-flash"];         // list entry
`.trimStart();
    const project = inMemoryProject('src/purposes.ts', src);
    const matches = findModelIdLiterals(project, CALL_SITE_REGISTRY);
    const byLine = new Map(matches.map((m) => [m.location.line, m.purpose]));

    expect(byLine.get(2)).toBe('comparison');
    expect(byLine.get(3)).toBe('catalog_entry');
    expect(byLine.get(5)).toBe('lookup_key');
    expect(byLine.get(6)).toBe('list_entry');
  });
});

// --- CATALOG + TEST-FILE HARDENING (real-repo regressions) ------------------
//
// From the 15-repo scan: chatbot-ui had `const GPT4_VISION = { modelId, modelName,
// hostedId }` catalog entries (swapping modelId alone corrupts the entry), and
// Continue had 29 ids to swap, every one in a `*.test.ts` or a mock class (must
// be skipped outright). Both had produced "sendable" diffs that were unsendable.

describe('catalog + test-file hardening (real-repo regressions)', () => {
  it('does NOT swap a model id in a standalone catalog object (chatbot-ui pattern)', () => {
    const src =
      'export const GPT4_VISION = {\n' +
      '  modelId: "gpt-4-vision-preview",\n' +
      '  modelName: "GPT-4 Vision",\n' +
      '  hostedId: "gpt-4-vision-preview",\n' +
      '};\n';
    const project = inMemoryProject('src/openai-llm-list.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/openai-llm-list.ts').getFullText();

    expect(text).toContain('modelId: "gpt-4-vision-preview"');
    expect(text).not.toContain('gpt-4o');
    expect(result.siteCount).toBe(0);
    // Both occurrences are surfaced Tier C for manual review, never edited.
    expect(result.dataMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('DOES swap the same id when the object is actually passed to a call', () => {
    const src =
      'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function run() {\n' +
      '  return client.chat.completions.create({ model: "gpt-4-vision-preview" });\n' +
      '}\n';
    const project = inMemoryProject('src/route.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/route.ts').getFullText();

    expect(text).toContain('{ model: "gpt-4o" }');
    expect(result.siteCount).toBe(1);
  });

  it('skips test files entirely (Continue pattern: ids in *.test.ts / mocks)', () => {
    const src =
      'class MockLLM { model = "gpt-4-vision-preview"; }\n' +
      'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function t() {\n' +
      '  return client.chat.completions.create({ model: "gemini-2.0-flash" });\n' +
      '}\n';
    const project = inMemoryProject('src/streamLazyApply.test.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/streamLazyApply.test.ts').getFullText();

    // Nothing in a test file is touched, not even the real call site.
    expect(text).toContain('model: "gemini-2.0-flash"');
    expect(text).not.toContain('gemini-flash-latest');
    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0); // file skipped outright
  });
});

// --- SAFETY GUARDS (chatbot-ui failure mirror) -------------------------------
//
// Two ways the old classifier said "live model argument" when a swap was in
// fact unsafe:
//   1. CAST BLINDNESS: `model: ("gpt-4-vision-preview" as LLMID)` — the repo
//      keeps its OWN model-id union, and a raw string swap writes an id that
//      union has never heard of, silently bypassing the repo's type registry.
//   2. AZURE DEPLOYMENT KEYS: `deployment: "gpt-4"` — an Azure deployment name
//      is a user-chosen ALIAS for a provisioned deployment, not a model id;
//      swapping it points the code at a deployment that does not exist.

describe('cast blindness: `as SomeUnion` demotes a would-be swap to data', () => {
  it('does NOT swap `model: ("x" as LLMID)` inside a call (chatbot-ui mirror)', () => {
    // NOTE: the union spells only LIVE ids — a deprecated id inside the type
    // itself would be a second (data) match and muddy the assertion.
    const src =
      'type LLMID = "gpt-4o" | "gpt-4o-mini";\n' +
      'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function run() {\n' +
      '  return client.chat.completions.create({ model: ("gpt-4-vision-preview" as LLMID) });\n' +
      '}\n';
    const project = inMemoryProject('src/cast.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/cast.ts').getFullText();

    expect(text).toContain('("gpt-4-vision-preview" as LLMID)');
    expect(result.siteCount).toBe(0);
    // Surfaced as data, carrying the cast-guard reason for the CLI to print.
    expect(result.dataMatches).toHaveLength(1);
    expect(result.dataMatches[0].reason).toMatch(/type-cast masks the model-id union/);
  });

  it('still swaps through `as string` and `as const` (nothing is masked)', () => {
    const src =
      'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function run() {\n' +
      '  return client.chat.completions.create({ model: ("gpt-4-vision-preview" as string) });\n' +
      '}\n' +
      'import { google } from "@ai-sdk/google";\n' +
      'export const MODEL_NAME = "gemini-2.0-flash" as const;\n' +
      'export function g() {\n' +
      '  return google(MODEL_NAME);\n' +
      '}\n';
    const project = inMemoryProject('src/stringcast.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/stringcast.ts').getFullText();

    expect(text).toContain('("gpt-4o" as string)');
    expect(text).toContain('"gemini-flash-latest" as const');
    expect(result.siteCount).toBe(2);
  });
});

// --- FILE ANNOTATIONS (mendr magic comments) ---------------------------------
//
// A repo can annotate its OWN files so Mendr stops reporting known content as
// debt: `// mendr: model-catalog` marks a deliberate migration catalog (one
// expected-content line, nothing swapped), `// mendr: ignore-file` skips the
// file outright. Mendr's own src/registry/oracles.ts carries the former.

describe('file annotations (mendr magic comments)', () => {
  const CATALOG_SRC =
    '// mendr: model-catalog\n' +
    'export const CATALOG = {\n' +
    '  "gemini-2.0-flash": "gemini-flash-latest",\n' +
    '};\n' +
    'export const MODEL_NAME = "gemini-2.0-flash";\n';

  it('detects both annotations in the first 5 lines only', () => {
    expect(fileAnnotation('// mendr: model-catalog\n')).toBe('model-catalog');
    expect(fileAnnotation('# mendr: ignore-file\n')).toBe('ignore-file');
    expect(fileAnnotation('//   mendr:   model-catalog  \n')).toBe('model-catalog');
    expect(fileAnnotation('// mendr: model-catalog is great\n')).toBeUndefined();
    expect(fileAnnotation('const x = 1;\n')).toBeUndefined();
    expect(fileAnnotation('\n\n\n\n\n// mendr: ignore-file\n')).toBeUndefined();
  });

  it('a `// mendr: model-catalog` file yields no matches or edits', () => {
    const project = inMemoryProject('src/catalog.ts', CATALOG_SRC);
    const result = applyModelIdFixesToProject(project, REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0);
    const text = project.getSourceFileOrThrow('src/catalog.ts').getFullText();
    expect(text).toBe(CATALOG_SRC);
  });

  it('a `// mendr: ignore-file` file is skipped outright', () => {
    const project = inMemoryProject(
      'src/skipme.ts',
      '// mendr: ignore-file\nexport const MODEL_NAME = "gemini-2.0-flash";\n',
    );
    const result = applyModelIdFixesToProject(project, REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0);
  });

  it('scanProjectAnnotations reports catalog ids + ignored files', () => {
    const project = inMemoryProject('src/catalog.ts', CATALOG_SRC);
    project.createSourceFile(
      'src/skipme.ts',
      '// mendr: ignore-file\nexport const MODEL_NAME = "gpt-4-0314";\n',
    );
    project.createSourceFile('src/plain.ts', 'export const MODEL_NAME = "gemini-2.0-flash";\n');

    const scan = scanProjectAnnotations(project, REGISTRY);
    expect(scan.catalogs).toHaveLength(1);
    expect(scan.catalogs[0].file).toContain('catalog.ts');
    expect(scan.catalogs[0].ids).toEqual(['gemini-2.0-flash']);
    expect(scan.ignoredFiles).toHaveLength(1);
    expect(scan.ignoredFiles[0]).toContain('skipme.ts');
  });
});

// --- MULTIMAP: two registry records for one value ---------------------------
//
// The registry may legitimately carry two `model_id` records for one deprecated
// value (two providers, or two retirement waves — distinct entryIds, which
// validateRegistry permits and entryId.ts is built for). The locator indexes by
// value as a MULTIMAP and emits one match per record, so every entryId reaches
// the consumers (the `mendr watch` exposure most of all); the fixer collapses
// those back to one edit per physical literal. Was finding #1 of the watch
// review — a first-wins index silently dropped the second record downstream.

describe('duplicate registry records for one value (multimap)', () => {
  /** Two records for one id that AGREE on the replacement (two retirement waves). */
  const DUP_AGREE: LlmRegistry = [
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0314',
      replacement: 'gpt-4o',
      shutdownDate: '2026-10-23',
      verification: autoApplyVerification(),
    },
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4-0314',
      replacement: 'gpt-4o',
      shutdownDate: '2027-01-01',
      verification: autoApplyVerification(),
    },
  ];

  it('emits one match PER RECORD for a duplicated value, at one physical literal', () => {
    const project = inMemoryProject('src/dup.ts', 'export const MODEL_NAME = "gpt-4-0314";\n');
    const matches = findModelIdLiterals(project, DUP_AGREE);

    // Two records -> two matches, but for the SAME literal (one value, one spot).
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.value))).toEqual(new Set(['gpt-4-0314']));
    expect(new Set(matches.map((m) => `${m.location.line}:${m.location.column}`)).size).toBe(1);
    expect(matches.map((m) => m.deprecation.shutdownDate).sort()).toEqual([
      '2026-10-23',
      '2027-01-01',
    ]);
  });

  it('collapses agreeing records to a SINGLE edit (no double-swap corruption)', () => {
    // The const is CONSUMED by a resolved first-party request (the sink rule);
    // a model-named const nothing feeds to a request is a review candidate.
    const header = 'import OpenAI from "openai";\nconst client = new OpenAI();\n';
    const use = 'export function ask() {\n  return client.chat.completions.create({ model: MODEL_NAME });\n}\n';
    const project = inMemoryProject('src/dup.ts', `${header}export const MODEL_NAME = "gpt-4-0314";\n${use}`);
    const edited = applyModelIdFixes(project, DUP_AGREE);

    expect(edited).toHaveLength(1);
    expect(project.getSourceFileOrThrow('src/dup.ts').getFullText()).toBe(
      `${header}export const MODEL_NAME = "gpt-4o";\n${use}`,
    );
  });

  it('leaves the literal UNEDITED when duplicate records disagree on the replacement', () => {
    // Distinct successors for one id at one call site is genuinely ambiguous:
    // the fixer refuses to guess (accuracy over recall) rather than pick one.
    const DUP_CONFLICT: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4-0314',
        replacement: 'gpt-4o',
        shutdownDate: '2026-10-23',
        verification: autoApplyVerification(),
      },
      {
        provider: 'azure',
        kind: 'model_id',
        deprecated: 'gpt-4-0314',
        replacement: 'gpt-4.1',
        shutdownDate: '2027-01-01',
        verification: autoApplyVerification(),
      },
    ];
    const project = inMemoryProject('src/dup.ts', 'export const MODEL_NAME = "gpt-4-0314";\n');
    const result = applyModelIdFixesToProject(project, DUP_CONFLICT);

    expect(result.siteCount).toBe(0);
    expect(project.getSourceFileOrThrow('src/dup.ts').getFullText()).toContain('"gpt-4-0314"');
  });
});

describe('azure deployment keys: a dedicated locate surface, never a swap', () => {
  it('does NOT swap `deployment: "gpt-4-vision-preview"` even in a call argument', () => {
    const src =
      'import OpenAI from "openai";\n' +
      'const client = new OpenAI();\n' +
      'export async function run() {\n' +
      '  return client.getChatCompletions({ deployment: "gpt-4-vision-preview" });\n' +
      '}\n' +
      'const opts = { deploymentName: "gemini-2.0-flash" };\n';
    const project = inMemoryProject('src/azure.ts', src);
    const result = applyModelIdFixesToProject(project, CALL_SITE_REGISTRY);
    const text = project.getSourceFileOrThrow('src/azure.ts').getFullText();

    // Both values stay byte-identical: a deployment name is not a model id.
    expect(text).toContain('deployment: "gpt-4-vision-preview"');
    expect(text).toContain('deploymentName: "gemini-2.0-flash"');
    expect(result.siteCount).toBe(0);

    // The alias IN A CALL lands on the azure surface — not data, not blocked.
    // The alias in a STANDALONE object is a catalog row (external validation:
    // lobe-chat reported 11 `config: { deploymentName }` catalog rows as exposure),
    // so it is Tier C data, still never swapped.
    expect(result.azureMatches).toHaveLength(1);
    expect(result.azureMatches.map((a) => a.value)).toEqual(['gpt-4-vision-preview']);
    expect(result.dataMatches).toHaveLength(1);
    expect(result.dataMatches[0].value).toBe('gemini-2.0-flash');
    expect(result.blockedMatches).toHaveLength(0);
  });
});
