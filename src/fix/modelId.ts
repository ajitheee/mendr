import { relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { NoSubstitutionTemplateLiteral, Project, StringLiteral } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';

// LLM mode — fix (model-id swap).
//
// This is the string-literal analogue of the Stripe rename codemod
// (fix/rename.ts): it re-uses the SAME safety discipline and the SAME in-memory
// + `createTwoFilesPatch` diff flow as fix/apply.ts, but edits a StringLiteral /
// NoSubstitutionTemplateLiteral node instead of a property-name token.
//
// SAFETY (identical guarantees to apply.ts):
//   1. We locate via findModelIdLiterals — the exact same value-driven scan the
//      locator uses — so a fix targets EXACTLY the literals it found, no looser
//      second pass that could drift.
//   2. We re-scan after each edit (as rename.ts does). Replacing a deprecated
//      value with its replacement changes the literal's value so it can never
//      re-match, which both terminates the loop and sidesteps stale ts-morph
//      node references after positions shift. (Registry entries are assumed
//      acyclic — a replacement is never itself a deprecated model id.)
//   3. All edits are made in-memory on the passed Project; NOTHING is ever
//      saved. Diffing is against a captured pre-edit snapshot.
//
// TODO(param_rename): the registry also carries `kind: "param_rename"` entries
// (e.g. `max_tokens` -> `max_completion_tokens`, o1/o3 only). That fix is NOT
// wired here: renaming every `max_tokens` object key blindly is unsafe because
// the rename is conditional on the provider AND the target model, and we have
// no reliable type/call-site anchor for a bare object literal. Locating it
// safely needs call-graph/model awareness; left as a follow-up. model_id is the
// priority and is fully handled.

/** Re-quote `newValue` using the ORIGINAL literal's quote style, escaped. */
function requote(originalText: string, newValue: string): string {
  const quote = originalText[0]; // one of ' " `
  const escaped = newValue
    .replace(/\\/g, '\\\\')
    .split(quote)
    .join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/**
 * Replace every matching deprecated model-id literal in `project` with its
 * replacement. Returns the edited literal nodes (useful for a site count). The
 * project is mutated in place but NEVER saved.
 */
export function applyModelIdFixes(
  project: Project,
  registry: LlmRegistry,
): (StringLiteral | NoSubstitutionTemplateLiteral)[] {
  const edited: (StringLiteral | NoSubstitutionTemplateLiteral)[] = [];

  // Re-scan after each edit: the just-edited literal now holds the replacement
  // value, which is not a deprecated token, so it drops out of the next scan.
  for (;;) {
    const next = findModelIdLiterals(project, registry).find(
      (m) => m.value !== m.deprecation.replacement,
    );
    if (!next) break;

    const newText = requote(next.node.getText(), next.deprecation.replacement);
    next.node.replaceWithText(newText);
    edited.push(next.node);
  }

  return edited;
}

/** Result of the model-id codemod: combined diff + changed files + site count. */
export interface ModelIdFixResult {
  /** Combined unified diff across all changed files (empty string if none). */
  diff: string;
  /** Absolute paths of the source files that changed. */
  changedFiles: string[];
  /** Number of individual literal sites edited across all files. */
  siteCount: number;
}

/**
 * Apply the model-id codemod to an already-loaded, in-memory `project` and
 * return the resulting unified diff. Mirrors apply.ts#applyRenamesToProject:
 * snapshot originals -> edit in memory -> `createTwoFilesPatch` per changed
 * file. The project is mutated in place but never saved.
 *
 * `rootDir`, when given, only prettifies the relative paths in diff headers.
 */
export function applyModelIdFixesToProject(
  project: Project,
  registry: LlmRegistry,
  rootDir?: string,
): ModelIdFixResult {
  // Snapshot the ORIGINAL text of every source file before any edit.
  const originals = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes('/node_modules/')) continue;
    originals.set(sf.getFilePath(), sf.getFullText());
  }

  const siteCount = applyModelIdFixes(project, registry).length;

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
 * Project, apply the model-id codemod, and return the diff. Never writes disk.
 */
export function applyModelIdFixesToRepo(repoPath: string, registry: LlmRegistry): ModelIdFixResult {
  const project = loadProject(repoPath);
  return applyModelIdFixesToProject(project, registry, repoPath);
}
