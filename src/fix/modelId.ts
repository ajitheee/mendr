import { relative } from 'node:path';
import { gitUnifiedPatch } from '../report/diff.js';
import type { NoSubstitutionTemplateLiteral, Project, StringLiteral } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { isVerified } from '../usage/llmRegistry.js';
import {
  findModelIdLiterals,
  toAzureDeploymentMatches,
  toBlockedModelArgMatches,
  toModelIdDataMatches,
  type AzureDeploymentLocate,
  type BlockedModelLocate,
  type LiteralMatch,
  type ModelIdDataLocate,
} from '../usage/scanLiterals.js';

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
//      second pass that could drift. Of those, only literals CLASSIFIED as
//      `model_arg` (a live model-argument position) are swapped; literals used as
//      DATA (a pricing-table key, an encoding-list entry, a model-picker array
//      element) are left byte-identical and surfaced Tier C locate-only.
//   2. ONE scan, then per-file edits applied in DESCENDING position order: every
//      edit lands at an offset BEFORE the previous one, so no applied edit can
//      shift (and thereby invalidate) a node still waiting its turn. This
//      replaced the old rescan-after-each-edit loop, which re-walked the whole
//      project once per site. (Registry entries are assumed acyclic — a
//      replacement is never itself a deprecated model id.)
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
 *
 * `precomputed`, when given, is a `findModelIdLiterals` result from an earlier
 * scan of this same (not-yet-edited) project — the caller's single scan is
 * reused instead of scanning the whole project again.
 */
export function applyModelIdFixes(
  project: Project,
  registry: LlmRegistry,
  precomputed?: LiteralMatch[],
): (StringLiteral | NoSubstitutionTemplateLiteral)[] {
  const edited: (StringLiteral | NoSubstitutionTemplateLiteral)[] = [];

  // ONE scan, filtered down to the swap-safe sites. Only `model_arg` (live
  // model-argument) positions AND `verified` entries are swapped; `data`
  // positions and non-`verified` entries are dropped here and persist unedited.
  //
  // THE ENGINE GATE: `isVerified(...)` is the load-bearing clause — an entry the
  // registry has not stamped `verification.status === 'verified'` is NEVER
  // auto-swapped here, no matter how confident the value match is.
  const swaps = (precomputed ?? findModelIdLiterals(project, registry)).filter(
    (m) =>
      m.position === 'model_arg' &&
      isVerified(m.deprecation) &&
      m.value !== m.deprecation.replacement,
  );

  // Group per file, then edit each file's sites in DESCENDING start order: every
  // edit lands at an offset BEFORE the previous one, so earlier offsets never
  // shift and no pending ts-morph node reference goes stale.
  const byFile = new Map<string, LiteralMatch[]>();
  for (const m of swaps) {
    const list = byFile.get(m.location.file);
    if (list) list.push(m);
    else byFile.set(m.location.file, [m]);
  }
  for (const matches of byFile.values()) {
    matches.sort((a, b) => b.node.getStart() - a.node.getStart());
    for (const m of matches) {
      const newText = requote(m.node.getText(), m.deprecation.replacement);
      m.node.replaceWithText(newText);
      edited.push(m.node);
    }
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
  /** Matched-but-rejected literals (deprecated id used as data) — Tier C. */
  dataMatches: ModelIdDataLocate[];
  /** Live model-arg matches blocked because their entry is not verified — Tier C. */
  blockedMatches: BlockedModelLocate[];
  /** Values under Azure deployment keys — locate-only, never swap-eligible. */
  azureMatches: AzureDeploymentLocate[];
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

  // ONE scan BEFORE editing, projected into the data / blocked / azure views so
  // their line/column anchor the original source (the codemod never touches any
  // of those positions anyway), then reused by the fix pass itself.
  const scan = findModelIdLiterals(project, registry);
  const dataMatches = toModelIdDataMatches(scan);
  const blockedMatches = toBlockedModelArgMatches(scan);
  const azureMatches = toAzureDeploymentMatches(scan);

  const siteCount = applyModelIdFixes(project, registry, scan).length;

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
    patches.push(gitUnifiedPatch(display, before, after));
  }

  return { diff: patches.join('\n'), changedFiles, siteCount, dataMatches, blockedMatches, azureMatches };
}

/**
 * Convenience wrapper: load the target repo as a fresh in-memory ts-morph
 * Project, apply the model-id codemod, and return the diff. Never writes disk.
 */
export function applyModelIdFixesToRepo(repoPath: string, registry: LlmRegistry): ModelIdFixResult {
  const project = loadProject(repoPath);
  return applyModelIdFixesToProject(project, registry, repoPath);
}
