import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    return new Project({ tsConfigFilePath });
  }

  // Fallback: no tsconfig. Add TS/TSX files by glob under sane defaults. We
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

/** Convenience: load a repo and build its Stripe usage map in one call. */
export function scanRepo(repoPath: string): UsageMap {
  return buildUsageMap(loadProject(repoPath));
}
