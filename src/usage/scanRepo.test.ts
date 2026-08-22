import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import {
  buildRegistryPrefilter,
  countAnalyzableSourceFiles,
  loadPrefilteredProject,
  loadProject,
} from './scanRepo.js';

// Regression tests for two real bugs found on real repos:
//   1. the no-tsconfig fallback glob only matched **/*.ts, so React/Next (.tsx)
//      apps silently scanned to zero and reported "Nothing to fix";
//   2. a JS-only repo loaded 0 analyzable files, which the CLI then reported as
//      a clean pass instead of failing honestly.

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

  it('reports zero analyzable files for a JS-only repo (so the CLI fails honestly)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-js-'));
    try {
      writeFileSync(join(dir, 'index.js'), 'const x = 1;\n');
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
