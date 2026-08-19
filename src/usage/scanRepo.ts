import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  Project,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  ts,
} from 'ts-morph';
import type { UsageMap } from '../types.js';
import { buildUsageMap } from './usageMap.js';

// Phase 2: load a target TypeScript repo with ts-morph so its own installed
// types (its `stripe` package, local interfaces, etc.) resolve, then hand the
// loaded Project off to the usage-map builder.

/**
 * Load a ts-morph `Project` for the target repo.
 *
 * Preferred path: use the repo's own `tsconfig.json` so module resolution and
 * the repo's installed dependency types (its `stripe`) are exactly what the repo
 * itself sees. If no tsconfig is present we degrade gracefully to a glob load
 * with sensible NodeNext compiler options.
 */
export function loadProject(repoPath: string): Project {
  const abs = resolve(repoPath);
  const tsConfigFilePath = join(abs, 'tsconfig.json');

  if (existsSync(tsConfigFilePath)) {
    // ts-morph adds every source file referenced by the tsconfig `include`.
    const fromConfig = new Project({ tsConfigFilePath });
    // A solution-style tsconfig (only "references", no "include") loads ZERO
    // source files. Returning that empty project would read as "nothing to
    // scan", so fall through to the glob loader instead.
    if (countAnalyzableSourceFiles(fromConfig) > 0) {
      return fromConfig;
    }
  }

  // Fallback: no (usable) tsconfig. Add TS/TSX files by glob under sane defaults. We
  // include .tsx/.mts/.cts (not just .ts) because the LLM beachhead is full of
  // React/Next (.tsx) apps — scanning `.ts` only silently missed them. `jsx` is
  // set so .tsx parses without a spurious "Cannot use JSX" diagnostic.
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
  });
  project.addSourceFilesAtPaths([
    join(abs, '**/*.{ts,tsx,mts,cts}'),
    `!${join(abs, '**/node_modules/**')}`,
    `!${join(abs, '**/*.d.ts')}`,
  ]);
  return project;
}

/**
 * Count the source files Mendr can actually analyze in a loaded project — real
 * source, not declaration files or anything under node_modules. Used to tell a
 * genuinely-clean repo apart from "we scanned nothing" (wrong path, JS-only
 * repo, a tsconfig whose `include` matched zero files).
 */
export function countAnalyzableSourceFiles(project: Project): number {
  return project
    .getSourceFiles()
    .filter(
      (sf) => !sf.isDeclarationFile() && !sf.getFilePath().includes('/node_modules/'),
    ).length;
}

/**
 * The {ts,tsx,mts,cts} files under `repoPath` that the loaded `project` does
 * NOT contain — real TypeScript source sitting outside the tsconfig `include`,
 * which a tsconfig-driven load silently skips. Returned repo-relative so the
 * CLI can print an honest coverage warning. `node_modules`, `.git`, and
 * declaration files are ignored, mirroring the glob loader's exclusions.
 */
export function findUncoveredSourceFiles(project: Project, repoPath: string): string[] {
  const abs = resolve(repoPath);
  // Compare with forward slashes, case-insensitively: ts-morph standardizes its
  // paths, and Windows paths can differ in slash direction / drive-letter case.
  const canonical = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const covered = new Set(project.getSourceFiles().map((sf) => canonical(sf.getFilePath())));

  const uncovered: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it rather than fail the whole scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (
        entry.isFile() &&
        /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !covered.has(canonical(full))
      ) {
        uncovered.push(relative(abs, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(abs);
  return uncovered;
}

/** Convenience: load a repo and build its Stripe usage map in one call. */
export function scanRepo(repoPath: string): UsageMap {
  return buildUsageMap(loadProject(repoPath));
}
