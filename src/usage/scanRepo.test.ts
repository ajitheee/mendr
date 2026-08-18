import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, countAnalyzableSourceFiles } from './scanRepo.js';

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
