import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import {
  buildRegistryPrefilter,
  countAnalyzableSourceFiles,
  ensureFilesLoaded,
  loadPrefilteredProject,
  loadProject,
} from './scanRepo.js';

// Regression tests for real bugs found on real repos:
//   1. the no-tsconfig fallback glob only matched **/*.ts, so React/Next (.tsx)
//      apps silently scanned to zero and reported "Nothing to fix";
//   2. a JS-only repo used to load 0 analyzable files — now that JavaScript is
//      supported, the fallback loader includes it (step 7).

describe('loadProject fallback glob (no tsconfig)', () => {
  it('scans .tsx as well as .ts (the React/Next blind spot)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-scan-'));
    try {
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(
        join(dir, 'app', 'page.tsx'),
        'export const C = () => <div>{"hi"}</div>;\n',
      );
      writeFileSync(join(dir, 'app', 'util.ts'), 'export const x = 1;\n');
      const project = loadProject(dir);
      expect(countAnalyzableSourceFiles(project)).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a JS-only repo now that JavaScript is analyzed (.js/.jsx/.mjs/.cjs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-js-'));
    try {
      writeFileSync(join(dir, 'index.js'), 'const x = 1;\n');
      writeFileSync(join(dir, 'worker.mjs'), 'export const y = 2;\n');
      writeFileSync(join(dir, 'ui.jsx'), 'export const C = () => null;\n');
      const project = loadProject(dir);
      expect(countAnalyzableSourceFiles(project)).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still excludes .d.ts and .min.js bundles from the fallback load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-js-excl-'));
    try {
      writeFileSync(join(dir, 'types.d.ts'), 'export type X = string;\n');
      writeFileSync(join(dir, 'vendor.min.js'), 'const a=1;\n');
      const project = loadProject(dir);
      expect(countAnalyzableSourceFiles(project)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- fix-llm registry pre-filter --------------------------------------------
//
// The perf fix for the 900-file/2-hit LibreChat shape: text-test every walked
// file against one compiled regex of registry tokens and parse only the hits.
// These tests pin the two properties that make it safe: the regex covers both
// token kinds (deprecated ids AND `on_models` prefixes), and the walked total
// stays honest while excluded dirs/tests never leak into it.

const PREFILTER_REGISTRY: LlmRegistry = [
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'param_rename',
    param: 'max_tokens',
    replacement: 'max_completion_tokens',
    on_models: ['o1'],
  },
];

describe('buildRegistryPrefilter', () => {
  it('matches deprecated ids and on_models prefixes; escapes regex chars', () => {
    const re = buildRegistryPrefilter(PREFILTER_REGISTRY)!;
    expect(re.test('const m = "gemini-2.0-flash";')).toBe(true);
    // Param sites anchor on a same-file model literal starting with "o1".
    expect(re.test('create({ model: "o1-mini", max_tokens: 5 })')).toBe(true);
    // The "." in the id is a literal dot, not a wildcard.
    expect(re.test('const m = "gemini-2x0-flash";')).toBe(false);
  });

  it('returns undefined for a registry with no tokens', () => {
    expect(buildRegistryPrefilter([])).toBeUndefined();
  });
});

describe('loadPrefilteredProject', () => {
  it('parses ONLY matching files while counting every walked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-prefilter-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hit.ts'), 'export const m = "gemini-2.0-flash";\n');
      writeFileSync(join(dir, 'src', 'clean.ts'), 'export const x = 1;\n');
      // Build output and test files are outside the walk entirely.
      writeFileSync(join(dir, 'dist', 'built.ts'), 'export const m = "gemini-2.0-flash";\n');
      writeFileSync(join(dir, 'src', 'hit.test.ts'), 'export const m = "gemini-2.0-flash";\n');

      const prefilter = buildRegistryPrefilter(PREFILTER_REGISTRY);
      const scan = loadPrefilteredProject(dir, prefilter);

      // Walked: hit.ts + clean.ts (dist/ dir and the test file are excluded).
      expect(scan.totalFiles).toBe(2);
      // Parsed: only the file whose text contains a registry token.
      expect(scan.matchedFiles).toBe(1);
      const loaded = scan.project.getSourceFiles().map((sf) => sf.getBaseName());
      expect(loaded).toEqual(['hit.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A tsconfig-driven load is not the last word on which files exist. maxun's
// root config declares `include: ["src"]` and its retiring model id lives in
// `server/` — so the gated pass held no such file, the codemod changed
// nothing, and the summary reported a gate failure for a gate that never ran.
describe('ensureFilesLoaded (files the tsconfig did not include)', () => {
  it('adds a real file the project is missing, and reports nothing missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-ensure-'));
    try {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
      );
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'in.ts'), 'export const IN = 1;\n');
      mkdirSync(join(dir, 'server', 'src'), { recursive: true });
      const outside = join(dir, 'server', 'src', 'out.ts');
      writeFileSync(outside, 'export const OUT = 2;\n');

      const project = loadProject(dir);
      expect(project.getSourceFile(outside)).toBeUndefined();

      const missing = ensureFilesLoaded(project, [outside]);
      expect(missing).toEqual([]);
      expect(project.getSourceFile(outside)).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the paths it could not load rather than silently dropping them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-ensure-missing-'));
    try {
      writeFileSync(join(dir, 'only.ts'), 'export const ONLY = 1;\n');
      const project = loadProject(dir);
      const gone = join(dir, 'vanished.ts');

      // A file the scan saw and that is no longer readable is a fact the
      // report has to be able to state: the alternative is an unexplained
      // residual, which is how the gate-failure claim got invented.
      expect(ensureFilesLoaded(project, [gone])).toEqual([gone]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op for a file the project already has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-ensure-noop-'));
    try {
      const file = join(dir, 'here.ts');
      writeFileSync(file, 'export const HERE = 1;\n');
      const project = loadProject(dir);
      const before = project.getSourceFiles().length;

      expect(ensureFilesLoaded(project, [file])).toEqual([]);
      expect(project.getSourceFiles().length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
