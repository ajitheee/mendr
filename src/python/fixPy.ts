import { gitUnifiedPatch } from '../report/diff.js';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { isVerified } from '../usage/llmRegistry.js';
import type {
  AzureDeploymentLocate,
  BlockedModelLocate,
  ModelIdDataLocate,
} from '../usage/scanLiterals.js';
import {
  countSyntaxErrors,
  displayPath,
  findPyModelIdLiterals,
  parsePython,
  readPythonSources,
  toPyAzureDeploymentMatches,
  toPyBlockedModelArgMatches,
  toPyModelIdDataMatches,
  type PyLiteralMatch,
  type PySource,
} from './scanPy.js';

// LLM mode — fix (PYTHON model-id swap).
//
// The Python analogue of fix/modelId.ts, with the same safety discipline:
//
//   1. Fixes target EXACTLY the literals the scanner found (one scan feeds
//      both the Tier C views and the swap pass — no looser second pass). Only
//      `model_arg` positions with a `verified` registry entry are swapped;
//      `data` and blocked positions are left byte-identical.
//   2. Per-file edits are applied in DESCENDING offset order, so every splice
//      lands BEFORE the previous one and no pending offset ever shifts.
//   3. Edits replace ONLY the content BETWEEN the quotes (the scanner recorded
//      the content span), so quote style — single, double, triple — is
//      preserved by construction, not by re-quoting. f-strings never get here:
//      the scanner refuses to match them at all.
//   4. Everything is in-memory {before, after} text; nothing is written to
//      disk. The caller decides what to do with the diff.
//
// GATE HONESTY — Python has NO type-check gate. TypeScript patches earn Tier A
// through the compiler; Python has no compiler to consult, so the strongest
// in-process check available is a SYNTAX gate: re-parse every patched file and
// require it introduces zero NEW parse errors relative to its own baseline
// (baseline-relative, like the TS type gate, so a file that was already broken
// is judged against itself). That is a strictly WEAKER guarantee than the TS
// type gate, and the CLI says so verbatim in its gate summary — Python results
// are also reported under their own "(python)" tier heading so the weaker
// verification is never conflated with the TS one.

/** Result of the Python model-id codemod. */
export interface PyModelIdFixResult {
  /** Combined unified diff across all changed .py files (empty string if none). */
  diff: string;
  /** Paths (as given) of the source files that changed. */
  changedFiles: string[];
  /** Number of individual literal sites edited across all files. */
  siteCount: number;
  /** Matched-but-rejected literals (deprecated id used as data) — Tier C. */
  dataMatches: ModelIdDataLocate[];
  /** Live model-arg matches blocked because their entry is not verified — Tier C. */
  blockedMatches: BlockedModelLocate[];
  /** Values under Azure deployment keys — locate-only, never swap-eligible. */
  azureMatches: AzureDeploymentLocate[];
  /**
   * The syntax gate verdict: `passed` iff NO patched file parses with more
   * ERROR/MISSING nodes than its unpatched baseline. `failures` carries one
   * human line per offending file. A failing gate means the diff above is
   * shown for review only — the CLI downgrades to Tier C and refuses --write.
   */
  syntaxGate: { passed: boolean; failures: string[] };
  /** Patched file contents, for --write and for the best-effort test gate. */
  patchedFiles: { absPath: string; newText: string }[];
  /** The registry entries actually applied, unique by deprecated id (labels). */
  swapDeprecations: LlmModelIdDeprecation[];
  /** Every individual applied swap site (per-file detail for the JSON report). */
  swapMatches: PyLiteralMatch[];
}

/**
 * Apply the swap-eligible matches to their sources' text. Returns the edited
 * text per changed file. Exported separately so the deliberate-breakage gate
 * test can drive it with a poisoned registry.
 */
export function applyPySwapsToText(
  sources: PySource[],
  swaps: PyLiteralMatch[],
): Map<string, string> {
  const byFile = new Map<string, PyLiteralMatch[]>();
  for (const m of swaps) {
    const list = byFile.get(m.file);
    if (list) list.push(m);
    else byFile.set(m.file, [m]);
  }

  const textByPath = new Map(sources.map((s) => [s.path, s.text]));
  const changed = new Map<string, string>();
  for (const [file, matches] of byFile) {
    let text = textByPath.get(file);
    if (text === undefined) continue;
    // DESCENDING content-start order: each splice lands before the previous
    // one, so earlier offsets never shift out from under a pending edit.
    matches.sort((a, b) => b.contentStart - a.contentStart);
    for (const m of matches) {
      text = text.slice(0, m.contentStart) + m.deprecation.replacement + text.slice(m.contentEnd);
    }
    changed.set(file, text);
  }
  return changed;
}

/**
 * Run the full Python model-id codemod over pre-read sources: scan, swap the
 * verified `model_arg` matches, diff, and run the baseline-relative syntax
 * gate. Pure in-memory; never touches disk. `rootDir` only prettifies the
 * relative paths in diff headers.
 */
export async function applyPyModelIdFixesToSources(
  sources: PySource[],
  registry: LlmRegistry,
  rootDir?: string,
): Promise<PyModelIdFixResult> {
  // ONE scan feeds everything: the Tier C data/blocked views AND the swap set.
  const matches = await findPyModelIdLiterals(sources, registry);
  const dataMatches = toPyModelIdDataMatches(matches);
  const blockedMatches = toPyBlockedModelArgMatches(matches);
  const azureMatches = toPyAzureDeploymentMatches(matches);

  // THE ENGINE GATE: `isVerified` is the load-bearing clause — an entry the
  // registry has not stamped `verification.status === 'verified'` is NEVER
  // auto-swapped, no matter how confident the value match is. Same predicate,
  // same posture as the TS fixer.
  const swaps = matches.filter(
    (m) =>
      m.position === 'model_arg' &&
      isVerified(m.deprecation) &&
      m.value !== m.deprecation.replacement,
  );

  const changed = applyPySwapsToText(sources, swaps);

  // Baseline-relative syntax gate: a patched file must not parse WORSE than
  // its own unpatched text. Content-only splices make new errors nearly
  // impossible, but "nearly" is asserted, not verified — so verify.
  const textByPath = new Map(sources.map((s) => [s.path, s.text]));
  const failures: string[] = [];
  for (const [file, after] of changed) {
    const before = textByPath.get(file)!;
    const baselineTree = await parsePython(before);
    const patchedTree = await parsePython(after);
    try {
      const baselineErrors = countSyntaxErrors(baselineTree);
      const patchedErrors = countSyntaxErrors(patchedTree);
      if (patchedErrors > baselineErrors) {
        failures.push(
          `${displayPath(rootDir, file)}: patched file has ${patchedErrors} syntax ` +
            `error${patchedErrors === 1 ? '' : 's'} (baseline had ${baselineErrors})`,
        );
      }
    } finally {
      baselineTree.delete();
      patchedTree.delete();
    }
  }

  // Diff each changed file against its original.
  const changedFiles: string[] = [];
  const patches: string[] = [];
  const patchedFiles: { absPath: string; newText: string }[] = [];
  for (const [file, after] of changed) {
    const before = textByPath.get(file)!;
    if (after === before) continue;
    changedFiles.push(file);
    patchedFiles.push({ absPath: file, newText: after });
    patches.push(gitUnifiedPatch(displayPath(rootDir, file), before, after));
  }

  // Unique applied swaps, for the CLI's human "from" -> "to" labels.
  const uniqueSwaps = new Map<string, LlmModelIdDeprecation>();
  for (const m of swaps) uniqueSwaps.set(m.deprecation.deprecated, m.deprecation);

  return {
    diff: patches.join('\n'),
    changedFiles,
    siteCount: swaps.length,
    dataMatches,
    blockedMatches,
    azureMatches,
    syntaxGate: { passed: failures.length === 0, failures },
    patchedFiles,
    swapDeprecations: [...uniqueSwaps.values()],
    swapMatches: swaps,
  };
}

/**
 * Convenience wrapper: read the given .py files from disk and run the codemod.
 * The caller supplies the file list (from `collectPythonFiles`) so the CLI's
 * "Scanned N files" count and this pass always agree on coverage.
 */
export async function applyPyModelIdFixes(
  files: string[],
  registry: LlmRegistry,
  rootDir?: string,
): Promise<PyModelIdFixResult> {
  return applyPyModelIdFixesToSources(readPythonSources(files), registry, rootDir);
}
