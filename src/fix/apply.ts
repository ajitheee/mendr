import { relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Project } from 'ts-morph';
import type { AffectedSite } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { applyRename } from './rename.js';

// Phase 4a orchestration + diff.
//
// SAFETY: we operate on an in-memory ts-morph Project and NEVER call
// `project.save()` / `sourceFile.save()`. The working tree is never touched.
// We capture each source file's ORIGINAL text before editing, apply the rename
// codemods, then emit a unified diff of each file that actually changed against
// its captured original.

/** Result of applying the rename fixes: a combined diff plus the changed files. */
export interface FixResult {
  /** Combined unified diff across all changed files (empty string if none). */
  diff: string;
  /** Absolute paths of the source files that changed. */
  changedFiles: string[];
  /** Number of individual rename sites edited across all files. */
  siteCount: number;
}

/**
 * Apply every `field_rename` AffectedSite to an already-loaded, in-memory
 * `project` and return the resulting unified diff. Non-rename sites are ignored
 * here (they are locate-only / Tier C). The project is mutated in place but
 * never saved.
 *
 * `rootDir`, when given, is used only to render nicer relative paths in the diff
 * headers; matching/precision is unaffected.
 */
export function applyRenamesToProject(
  project: Project,
  sites: AffectedSite[],
  rootDir?: string,
): FixResult {
  // Snapshot the ORIGINAL text of every source file before any edit.
  const originals = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes('/node_modules/')) continue;
    originals.set(sf.getFilePath(), sf.getFullText());
  }

  // Apply the rename codemods in-memory (renames only; other kinds are Tier C).
  let siteCount = 0;
  for (const site of sites) {
    if (site.change.kind !== 'field_rename') continue;
    siteCount += applyRename(project, site).length;
  }

  // Diff each file that actually changed against its captured original.
  const changedFiles: string[] = [];
  const patches: string[] = [];
  for (const [file, before] of originals) {
    const sf = project.getSourceFile(file);
    if (!sf) continue;
    const after = sf.getFullText();
    if (after === before) continue;

    changedFiles.push(file);
    const display = rootDir ? relative(rootDir, file).replace(/\\/g, '/') : file;
    patches.push(createTwoFilesPatch(display, display, before, after, '', '', { context: 3 }));
  }

  return { diff: patches.join('\n'), changedFiles, siteCount };
}

/**
 * Convenience wrapper: load the target repo as a fresh in-memory ts-morph
 * Project, apply the rename fixes, and return the diff. Never writes to disk.
 */
export function applyRenames(repoPath: string, sites: AffectedSite[]): FixResult {
  const project = loadProject(repoPath);
  return applyRenamesToProject(project, sites, repoPath);
}
