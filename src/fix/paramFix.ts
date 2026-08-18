import { relative } from 'node:path';
import { gitUnifiedPatch } from '../report/diff.js';
import { Node, SyntaxKind } from 'ts-morph';
import type {
  Expression,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
} from 'ts-morph';
import type { LlmParamDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { modelMatches, paramEntries } from '../usage/llmRegistry.js';

// LLM mode — fix (MODEL-COUPLED param transform). This is the flagship
// "AST beats regex" case, and the ONE correctness property that matters is:
//
//   A `temperature` / `max_tokens` key is only wrong on SPECIFIC models. The
//   transform therefore resolves the `model` value AT EACH CALL SITE and only
//   fires when that concrete model is in the entry's `on_models` set. A naive
//   global find-replace that strips `temperature` from EVERY request — including
//   calls still on an older model that accepts it — would break working code.
//   The whole point is that we DON'T do that.
//
// Two transforms, both conditional on the resolved model:
//   - param_removal: delete the `param` key from the options object (e.g.
//     Anthropic Opus 4.7+ returns HTTP 400 for `temperature`/`top_p`/`top_k`).
//   - param_rename:  rename the `param` key to `replacement`, keeping the value
//     (e.g. OpenAI reasoning models: `max_tokens` -> `max_completion_tokens`).
//
// PRECISION (accuracy over recall, mirroring modelId.ts / rename.ts):
//   1. A candidate object literal must carry BOTH a `model` property AND the
//      target `param` property. Any other object is invisible.
//   2. The model value must resolve to a CONCRETE compile-time string — either a
//      string/template literal inline, or a `const`/`let` bound to one (best
//      effort). If we cannot see the model verbatim, we SKIP the site rather
//      than guess. We never touch a call whose model we cannot prove.
//   3. Only sites whose resolved model matches `on_models` are edited; a
//      matching object on a non-listed model is left exactly as-is.
//   4. All edits are in-memory on the passed Project; NOTHING is ever saved.
//
// KNOWN LIMITATIONS (same accuracy-over-recall trade as the model-id locator):
//   - Model resolution is one hop: an inline literal or a same-file const/let
//     with a literal initializer. A model read from an env var, built by string
//     concatenation/template interpolation, imported from another module, or
//     reassigned is treated as unresolvable and SKIPPED.
//   - A `param`/`model` supplied via a spread (`{ ...opts, temperature }`) is
//     not seen unless the key is a direct own property of the object literal.

/** A resolved, actionable param-transform site (model known + in `on_models`). */
export interface ParamMatch {
  /** The request-options object literal carrying `model` + the target param. */
  object: ObjectLiteralExpression;
  /** The property to remove (param_removal) or rename (param_rename). */
  paramProp: PropertyAssignment;
  /** The registry entry that fired here. */
  deprecation: LlmParamDeprecation;
  /** The concrete model string resolved at this call site. */
  model: string;
  /** Where the param property sits in source. */
  location: SourceLocation;
}

/** A single applied param edit, for reporting a per-transform breakdown. */
export interface ParamEdit {
  kind: 'param_rename' | 'param_removal';
  /** The request-options key that was removed or renamed. */
  param: string;
  /** The new key name (param_rename only). */
  replacement?: string;
  /** The resolved model that coupled the edit to this site. */
  model: string;
}

/** The literal string value of a string/template-literal expression, else undefined. */
function literalStringValue(expr: Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }
  return undefined;
}

/**
 * Resolve a `model` property's value to a concrete compile-time string, or
 * `undefined` if it cannot be proven. Handles:
 *   - `{ model: "claude-opus-5" }`         (inline string / template literal)
 *   - `{ model: m }` with `const m = "…"`   (one-hop const/let, literal init)
 *   - `{ model }`     shorthand, same rule
 * Anything else (env var, concatenation, interpolation, import) is unresolvable.
 */
function resolveModel(modelProp: Node): string | undefined {
  let expr: Expression | undefined;
  if (Node.isPropertyAssignment(modelProp)) {
    expr = modelProp.getInitializer();
  } else if (Node.isShorthandPropertyAssignment(modelProp)) {
    // `{ model }` — the value is whatever the identifier `model` is bound to.
    expr = modelProp.getNameNode();
  }
  if (!expr) return undefined;

  const direct = literalStringValue(expr);
  if (direct !== undefined) return direct;

  // One-hop identifier resolution: a local const/let with a literal initializer.
  if (Node.isIdentifier(expr)) {
    const decl = expr.getSymbol()?.getValueDeclaration();
    if (decl && Node.isVariableDeclaration(decl)) {
      return literalStringValue(decl.getInitializer());
    }
  }
  return undefined;
}

/**
 * Find every ACTIONABLE param-transform site in `project`: object literals that
 * carry a `model` property AND a target `param` property, whose model resolves
 * to a concrete string that MATCHES the entry's `on_models`. Non-matching or
 * unresolvable sites are omitted (never returned as a false actionable).
 *
 * Declaration files and `node_modules` are skipped, mirroring the model-id
 * locator.
 */
export function findParamSites(project: Project, registry: LlmRegistry): ParamMatch[] {
  const entries = paramEntries(registry);
  if (entries.length === 0) return [];

  const out: ParamMatch[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const file = sf.getFilePath();
    if (file.includes('/node_modules/')) continue;

    for (const object of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const modelProp = object.getProperty('model');
      if (!modelProp) continue; // not a request-options object

      // Resolve the model ONCE per object; skip the whole object if we can't.
      const model = resolveModel(modelProp);
      if (model === undefined) continue;

      for (const entry of entries) {
        const paramProp = object.getProperty(entry.param);
        // We only transform a plain `key: value` property. A shorthand/spread/
        // method sharing the name is left untouched (we can't safely rewrite it).
        if (!paramProp || !Node.isPropertyAssignment(paramProp)) continue;
        if (!modelMatches(model, entry.on_models)) continue;

        const { line, column } = sf.getLineAndColumnAtPos(paramProp.getStart());
        out.push({
          object,
          paramProp,
          deprecation: entry,
          model,
          location: { file, line, column },
        });
      }
    }
  }

  return out;
}

/** Rename a property key to `replacement`, preserving a quoted-key's quote style. */
function renameKey(paramProp: PropertyAssignment, replacement: string): void {
  const nameNode = paramProp.getNameNode();
  if (Node.isStringLiteral(nameNode)) {
    const quote = nameNode.getText()[0];
    nameNode.replaceWithText(`${quote}${replacement}${quote}`);
  } else {
    nameNode.replaceWithText(replacement);
  }
}

/**
 * Apply every model-coupled param transform in `project`. Returns one
 * {@link ParamEdit} per site edited. The project is mutated in place but NEVER
 * saved.
 *
 * We re-scan after each edit (as modelId.ts / rename.ts do): a removal deletes
 * the `param` key and a rename changes it, so the just-edited site can never
 * re-match. That both terminates the loop and sidesteps stale ts-morph node
 * references after positions shift.
 */
export function applyParamFixes(project: Project, registry: LlmRegistry): ParamEdit[] {
  const edits: ParamEdit[] = [];

  for (;;) {
    const next = findParamSites(project, registry)[0];
    if (!next) break;

    const { deprecation, paramProp, model } = next;
    if (deprecation.kind === 'param_removal') {
      paramProp.remove();
      edits.push({ kind: 'param_removal', param: deprecation.param, model });
    } else {
      renameKey(paramProp, deprecation.replacement);
      edits.push({
        kind: 'param_rename',
        param: deprecation.param,
        replacement: deprecation.replacement,
        model,
      });
    }
  }

  return edits;
}

/** Result of the param codemod: combined diff + changed files + per-kind counts. */
export interface ParamFixResult {
  /** Combined unified diff across all changed files (empty string if none). */
  diff: string;
  /** Absolute paths of the source files that changed. */
  changedFiles: string[];
  /** Number of `param_removal` sites applied. */
  removed: number;
  /** Number of `param_rename` sites applied. */
  renamed: number;
}

/**
 * Apply the param codemod to an already-loaded, in-memory `project` and return
 * the resulting unified diff. Mirrors modelId.ts#applyModelIdFixesToProject:
 * snapshot originals -> edit in memory -> `createTwoFilesPatch` per changed
 * file. The project is mutated in place but never saved.
 */
export function applyParamFixesToProject(
  project: Project,
  registry: LlmRegistry,
  rootDir?: string,
): ParamFixResult {
  const originals = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes('/node_modules/')) continue;
    originals.set(sf.getFilePath(), sf.getFullText());
  }

  const edits = applyParamFixes(project, registry);
  const removed = edits.filter((e) => e.kind === 'param_removal').length;
  const renamed = edits.filter((e) => e.kind === 'param_rename').length;

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

  return { diff: patches.join('\n'), changedFiles, removed, renamed };
}
