import { ts } from 'ts-morph';
import type { Diagnostic, Project } from 'ts-morph';
import type { CheckStatus } from './status.js';

// Phase 5: the type-check gate.
//
// A rename patch only EARNS its Tier A label if it does not make the repo's
// type-checking any worse than it already was. Crucially this gate is
// BASELINE-RELATIVE, not absolute:
//
//   - t0: `charge.card.name` compiles fine against the installed SDK types.
//   - t1: the dev upgrades the SDK; the types now expose `cardholder_name`,
//         NOT `name`, so the un-migrated `.name` code NO LONGER COMPILES. The
//         repo already has type errors before Mendr touches anything.
//   - t2: Mendr patches `.name` -> `.cardholder_name`; it compiles again.
//
// Requiring ZERO absolute errors would wrongly reject the very repos Mendr
// exists to fix (they are broken at t1 by definition). Instead we compare the
// patched project against the pre-patch baseline and pass iff the patch
// introduces NO NEW diagnostic. Removing pre-existing errors (the happy path)
// obviously still passes.
//
// This runs fully in-memory on two ts-morph Projects; no temp dir, no `tsc`
// subprocess.

/** A single type diagnostic, reduced to a line-independent, comparable shape. */
export interface DiagnosticInfo {
  /** Absolute file path the diagnostic is attached to ('' for global). */
  file: string;
  /** The TypeScript error code (e.g. 2339). */
  code: number;
  /** The flattened diagnostic message text. */
  message: string;
}

/** Result of the baseline-relative type-check gate. */
export interface TypeCheckResult {
  /** True iff the patched project introduces no diagnostic absent from baseline. */
  passed: boolean;
  /** The diagnostics present after the patch that were NOT in the baseline. */
  newDiagnostics: DiagnosticInfo[];
  /** How many diagnostics the BASELINE (pre-patch) project already had — lets
   * the CLI say honestly that "pass" means "no NEW errors", not "zero errors". */
  baselineCount: number;
  /**
   * Third-party packages the baseline could not resolve at all, deduplicated
   * and sorted — the checkout has no `node_modules` for them.
   *
   * This is a SCOPE statement, not a failure. A model-id swap is caught by
   * this gate when the SDK types declare the argument as a union of literal
   * ids; with the package unresolved that argument is `any` and no such error
   * is possible. `fix-llm <url>` shallow-clones without installing, so the
   * gate there is systematically blinder than the same gate run locally — and
   * it said "passed" either way, which reads as "the SDK accepts this id".
   * Naming the packages keeps the claim the size of the evidence.
   */
  unresolvedModules: string[];
}

/** TS2307 — "Cannot find module 'x' or its corresponding type declarations." */
const CANNOT_FIND_MODULE = 2307;

/**
 * The module specifier out of a TS2307 message, when it names a PACKAGE.
 *
 * A relative specifier that cannot be found is the repository's own broken
 * import and has nothing to do with whether dependencies are installed, so it
 * is not reported as an unresolved package.
 */
function unresolvedPackageOf(info: DiagnosticInfo): string | undefined {
  if (info.code !== CANNOT_FIND_MODULE) return undefined;
  const specifier = /^Cannot find module '([^']+)'/.exec(info.message)?.[1];
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  // Report the package, not the deep path: 'openai/resources/chat' is still
  // the `openai` package missing, and a list of subpaths reads as many faults.
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Reduce a ts-morph diagnostic to a stable, line-INDEPENDENT descriptor.
 *
 * We deliberately drop line/column: a rename shifts nothing here, but other
 * patches could, and an error that merely moved down a line is NOT a new error.
 * Identity is therefore (file, TS code, flattened message text) — which is
 * specific enough that a genuinely new error (a different message, or the same
 * message in a different file) is never mistaken for a pre-existing one.
 */
function toInfo(diag: Diagnostic): DiagnosticInfo {
  const file = diag.getSourceFile()?.getFilePath() ?? '';
  const code = diag.getCode();
  const message = ts.flattenDiagnosticMessageText(diag.compilerObject.messageText, '\n');
  return { file: String(file), code, message };
}

/** The comparison key for a diagnostic (see `toInfo` for why line is excluded). */
function keyOf(info: DiagnosticInfo): string {
  return `${info.file}\0${info.code}\0${info.message}`;
}

/**
 * Baseline-relative type-check gate.
 *
 * @param baselineProject the repo loaded in-memory BEFORE the patch.
 * @param patchedProject  the same repo loaded in-memory AFTER the rename patch.
 * @returns `passed` = the patch introduced no diagnostic whose key is absent
 *          from the baseline, plus the list of those new diagnostics (empty
 *          when `passed`).
 */
export function checkTypes(baselineProject: Project, patchedProject: Project): TypeCheckResult {
  const baselineDiagnostics = baselineProject.getPreEmitDiagnostics();
  const baselineInfos = baselineDiagnostics.map(toInfo);
  const baselineKeys = new Set(baselineInfos.map(keyOf));
  // Which packages were missing while this gate ran. Read from the BASELINE:
  // the patch cannot install or remove a dependency, so this describes the
  // checkout, not the change.
  const unresolvedModules = [
    ...new Set(baselineInfos.map(unresolvedPackageOf).filter((m): m is string => Boolean(m))),
  ].sort();

  const newDiagnostics: DiagnosticInfo[] = [];
  const seen = new Set<string>();
  for (const diag of patchedProject.getPreEmitDiagnostics()) {
    const info = toInfo(diag);
    const key = keyOf(info);
    if (baselineKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    newDiagnostics.push(info);
  }

  return {
    passed: newDiagnostics.length === 0,
    newDiagnostics,
    baselineCount: baselineDiagnostics.length,
    unresolvedModules,
  };
}

/**
 * One clause naming the packages this gate could not see, or `undefined` when
 * it saw everything. Shared by every surface that reports the gate, so the
 * terminal, the JSON and the pull-request body scope the claim identically.
 */
export function unresolvedScopeNote(result: TypeCheckResult): string | undefined {
  const modules = result.unresolvedModules;
  if (modules.length === 0) return undefined;
  const shown = modules.slice(0, 3).join(', ');
  const more = modules.length > 3 ? `, +${modules.length - 3} more` : '';
  return (
    `${modules.length} package${modules.length === 1 ? '' : 's'} not installed in this ` +
    `checkout (${shown}${more}) -- their types were not checked`
  );
}

/** One-line human summary of a diagnostic, e.g. for a downgrade reason. */
export function formatDiagnostic(info: DiagnosticInfo): string {
  return `TS${info.code}: ${info.message}`;
}

/**
 * THE OUTCOME FOR CODE THIS GATE CANNOT JUDGE, in one place.
 *
 * mendr's only type checker is the in-memory ts-morph gate above. It reads
 * TypeScript and JavaScript and nothing else — there is no mypy, no pyright, no
 * subprocess. A patch that touches no .ts/.js file therefore has no type-check
 * to run, and every surface must say so in the SAME words.
 *
 * WHY THIS IS A CONSTANT AND NOT A COMMENT. `fix-llm` got it right by accident
 * of structure: its whole gate block sits behind `tsSwapCandidates > 0`, and
 * its Python section printed this row as an object literal. `migrate` called
 * checkTypes unconditionally, and on a Python-only repository the baseline and
 * the patched project are the same — often EMPTY — project, so the gate
 * returned `passed` with zero new diagnostics and the pull-request body
 * published "type-check: **passed**" for a repo containing no TypeScript at
 * all. Two surfaces, two answers, one repository: the exact thing the single
 * vocabulary exists to prevent.
 *
 * `skipped`, not `not_run`: mendr made a decision here — it does not type-check
 * this language — rather than looking for something and finding nothing.
 */
export const NO_TYPE_CHECK: { readonly status: CheckStatus; readonly detail: string } = {
  status: 'skipped',
  detail: 'mendr runs no type checker for python',
};
