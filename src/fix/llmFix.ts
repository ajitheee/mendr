import { relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { applyModelIdFixes } from './modelId.js';
import { applyParamFixes } from './paramFix.js';

// LLM mode — combined fix. `fix-llm` runs TWO independent codemod passes over
// the same repo and folds them into ONE diff and ONE Tier A/C gate decision:
//
//   1. model-id swap  (value-driven literal replacement; see modelId.ts)
//   2. param transform (model-coupled rename/removal;   see paramFix.ts)
//
// Order matters and is intentional: model-id runs FIRST. Swapping a retired
// model id (e.g. `claude-3-opus-20240229` -> a current Opus) can change the
// concrete model at a call site, and the param pass then evaluates `on_models`
// against that NEW value — so a retired-Opus call that also carries an illegal
// `temperature` gets BOTH fixed in one migration, which is the correct result.
//
// SAFETY is inherited unchanged from both passes: all edits are in-memory on the
// passed Project; nothing is ever saved. We snapshot every file's original text
// BEFORE either pass, then diff the fully-patched result against that snapshot,
// so the single combined diff reflects both transforms per file.

/** Result of the combined LLM codemod: one diff + a per-transform breakdown. */
export interface LlmFixResult {
  /** Combined unified diff across all changed files (empty string if none). */
  diff: string;
  /** Absolute paths of the source files that changed (across both passes). */
  changedFiles: string[];
  /** Number of model-id literal sites swapped. */
  modelIdSites: number;
  /** Number of param keys removed (param_removal). */
  paramsRemoved: number;
  /** Number of param keys renamed (param_rename). */
  paramsRenamed: number;
}

/**
 * Apply BOTH LLM codemod passes to an already-loaded, in-memory `project` and
 * return a single combined diff plus a per-transform breakdown. The project is
 * mutated in place but never saved. `rootDir` only prettifies diff-header paths.
 */
export function applyLlmFixesToProject(
  project: Project,
  registry: LlmRegistry,
  rootDir?: string,
): LlmFixResult {
  // Snapshot ORIGINAL text of every source file BEFORE either pass runs.
  const originals = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes('/node_modules/')) continue;
    originals.set(sf.getFilePath(), sf.getFullText());
  }

  // Pass 1: model-id swaps. Pass 2: model-coupled param transforms (which see
  // any model ids pass 1 just updated).
  const modelIdSites = applyModelIdFixes(project, registry).length;
  const paramEdits = applyParamFixes(project, registry);
  const paramsRemoved = paramEdits.filter((e) => e.kind === 'param_removal').length;
  const paramsRenamed = paramEdits.filter((e) => e.kind === 'param_rename').length;

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

  return { diff: patches.join('\n'), changedFiles, modelIdSites, paramsRemoved, paramsRenamed };
}

/**
 * Convenience wrapper: load the target repo as a fresh in-memory ts-morph
 * Project, apply both LLM codemod passes, and return the combined diff. Never
 * writes to disk.
 */
export function applyLlmFixesToRepo(repoPath: string, registry: LlmRegistry): LlmFixResult {
  const project = loadProject(repoPath);
  return applyLlmFixesToProject(project, registry, repoPath);
}
