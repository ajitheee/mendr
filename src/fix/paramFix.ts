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
import { fileAnnotation, isTestPath } from '../usage/scanLiterals.js';
import {
  classifyCallSurface,
  enclosingCallOfObject,
  enclosingNewOfObject,
  hasCatalogSiblings,
  TS_EXAMPLE_CALL_REASON,
  TS_PREFIXED_REASON,
} from '../usage/tsSurface.js';

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
    if (isTestPath(file)) continue;
    // A file the repo annotated `mendr: ignore-file` or `mendr: model-catalog` is never edited,
    // the same rule the model-id scan follows. The param pass used to skip that check, and
    // renamed `max_tokens` inside a catalog row the report listed as "no action".
    if (fileAnnotation(sf.getFullText()) !== undefined) continue;

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

/** The node a `model` property's value is written in: the literal, or the one-hop const's literal. */
function modelLiteralNode(modelProp: Node | undefined): Node | undefined {
  if (!modelProp) return undefined;
  let expr: Expression | undefined;
  if (Node.isPropertyAssignment(modelProp)) expr = modelProp.getInitializer();
  else if (Node.isShorthandPropertyAssignment(modelProp)) expr = modelProp.getNameNode();
  if (!expr) return undefined;
  if (literalStringValue(expr) !== undefined) return expr;
  if (Node.isIdentifier(expr)) {
    const decl = expr.getSymbol()?.getValueDeclaration();
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (literalStringValue(init) !== undefined) return init;
    }
  }
  return undefined;
}

/** A literal the model-id scan held for review: the node itself, and the scan's reason. */
export interface HeldLiteral {
  node: Node;
  reason?: string;
}

/**
 * Drop the param sites on calls the model-id scan HELD for review (position `surface_capped`):
 * an example tree, a proxy or partner client, a gateway-prefixed id, a coupled parameter. A held
 * call is reported as "review required, no patch generated", so no pass should edit its request
 * either; the param pass used to, which left the same call in Tier B and in the Tier A diff. This
 * skips the request objects it can tie to a held call. The README's "Held calls: what is and is
 * not protected" lists the shapes it cannot tie yet (shorthand `{ model }`, `this.model`, …).
 *
 * DECIDED PER CALL, NOT PER LITERAL. The first version keyed on the model literal's file, line
 * and value, and the 2026-10-07 review of it found two ways that held back calls nobody held:
 *   - a `const MODEL` shared by a held call and an ordinary one. The scan holds the DECLARATION
 *     when any consumer is held (judgeDeclarationSinks: "any capped consumer wins"), so keying
 *     on the declaration dropped the ordinary call's parameter fix as well;
 *   - two calls with the same model on one line, one held and one not.
 * So a site is held when its OWN model literal is a held node (node identity: a held literal is
 * never swapped, so its wrapper survives pass 1's edits elsewhere in the file), or, when the
 * model comes through a declaration the scan held, when the rule that held the declaration also
 * holds THIS call: the file is an example tree, or this call's own surface is capped.
 */
export function withoutHeldCalls(sites: ParamMatch[], held: ReadonlyArray<HeldLiteral>): ParamMatch[] {
  if (held.length === 0) return sites;
  const reasonsByNode = new Map<Node, (string | undefined)[]>();
  for (const h of held) {
    const list = reasonsByNode.get(h.node);
    if (list) list.push(h.reason);
    else reasonsByNode.set(h.node, [h.reason]);
  }
  return sites.filter((site) => !isHeldSite(site, reasonsByNode));
}

/**
 * A site is held when its request object is held, or when that object sits inside a held
 * request: `fallbacks: [{ model, max_tokens }]` or `override: { … }` within a held call's own
 * argument. The nested object's literal is data to the scan (it is not a call argument), so its
 * own verdict cannot say the call is held; the request it is part of can. (Review of PR #50,
 * round two: the nested `max_tokens` was still renamed inside a call listed as held.)
 */
function isHeldSite(site: ParamMatch, reasonsByNode: ReadonlyMap<Node, (string | undefined)[]>): boolean {
  return requestObjectsAround(site.object).some((obj) => isHeldObject(obj, reasonsByNode));
}

/**
 * `obj`, then every object literal it is nested in, climbing only through one argument's own
 * expression tree (objects, arrays, spreads, parentheses, casts). The climb stops at anything
 * else, so it never leaves the request: not through a call, a function body or a statement.
 */
function requestObjectsAround(obj: ObjectLiteralExpression): ObjectLiteralExpression[] {
  const out = [obj];
  let child: Node = obj;
  for (
    let parent: Node | undefined = obj.getParent();
    parent && selectsValueOf(parent, child);
    parent = parent.getParent()
  ) {
    if (Node.isObjectLiteralExpression(parent)) out.push(parent);
    child = parent;
  }
  return out;
}

/**
 * Does `parent` only carry or select `child`'s value, inside one expression? Objects, arrays,
 * spreads, parentheses and type wrappers carry it; `||`, `??`, `&&` and a ternary's branches
 * select it (review of PR #50, round three: `fallbacks: allow ? [{ … }] : undefined` inside a
 * held gateway call was still edited). A ternary's CONDITION, a call, a function and a
 * statement are none of these, so the climb never leaves the request.
 */
function selectsValueOf(parent: Node, child: Node): boolean {
  if (
    Node.isObjectLiteralExpression(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isArrayLiteralExpression(parent) ||
    Node.isSpreadAssignment(parent) ||
    Node.isSpreadElement(parent) ||
    Node.isParenthesizedExpression(parent) ||
    Node.isAsExpression(parent) ||
    Node.isSatisfiesExpression(parent) ||
    Node.isTypeAssertion(parent) ||
    Node.isNonNullExpression(parent)
  ) {
    return true;
  }
  if (Node.isConditionalExpression(parent)) {
    return parent.getWhenTrue() === child || parent.getWhenFalse() === child;
  }
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    return (
      op === SyntaxKind.BarBarToken ||
      op === SyntaxKind.QuestionQuestionToken ||
      op === SyntaxKind.AmpersandAmpersandToken
    );
  }
  return false;
}

/** One string literal a `model` value can take, and whether it was reached through a declaration. */
interface ModelLeaf {
  node: Node;
  viaDeclaration: boolean;
}

/**
 * Every string literal a `model` property's value can take, through the wrappers the scanner
 * treats as transparent for a value (isValueTransparent: parentheses, `as`, `||`, `??`, a
 * ternary's branches) and one hop through a const. The scanner holds a call whose model is
 * `opts.model || "o3-mini"` or `"o3-mini" as const` (review of PR #50, round three), so the
 * guard has to find that literal too, not only a bare one.
 */
function modelValueLeaves(modelProp: Node | undefined): ModelLeaf[] {
  if (!modelProp || !Node.isPropertyAssignment(modelProp)) {
    // Shorthand `{ model }` and anything else: the one-hop rule modelLiteralNode follows.
    const node = modelLiteralNode(modelProp);
    return node ? [{ node, viaDeclaration: true }] : [];
  }
  const init = modelProp.getInitializer();
  return init ? valueLeaves(init, false) : [];
}

function valueLeaves(expr: Node, viaDeclaration: boolean): ModelLeaf[] {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return [{ node: expr, viaDeclaration }];
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr)) {
    return valueLeaves(expr.getExpression(), viaDeclaration);
  }
  if (Node.isConditionalExpression(expr)) {
    return [...valueLeaves(expr.getWhenTrue(), viaDeclaration), ...valueLeaves(expr.getWhenFalse(), viaDeclaration)];
  }
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getKind();
    if (op !== SyntaxKind.BarBarToken && op !== SyntaxKind.QuestionQuestionToken) return [];
    return [...valueLeaves(expr.getLeft(), viaDeclaration), ...valueLeaves(expr.getRight(), viaDeclaration)];
  }
  if (Node.isIdentifier(expr) && !viaDeclaration) {
    const decl = expr.getSymbol()?.getValueDeclaration();
    const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    return init ? valueLeaves(init, true) : [];
  }
  return [];
}

/** Is this request object one the scan held, judged by the rule the scan applied to its model? */
function isHeldObject(
  obj: ObjectLiteralExpression,
  reasonsByNode: ReadonlyMap<Node, (string | undefined)[]>,
): boolean {
  for (const leaf of modelValueLeaves(obj.getProperty('model'))) {
    const reasons = reasonsByNode.get(leaf.node);
    if (!reasons) continue;
    // The object's own value: the scan judged this very request.
    if (!leaf.viaDeclaration) return true;
    if (isHeldConsumer(obj, leaf.node, reasons)) return true;
  }
  return false;
}

/**
 * A request fed a declaration the scan held. The scan holds a declaration when ANY consumer
 * is held, so judge THIS consumer the way the scan judges a literal written in it
 * (classifyByEnclosure, then the example-tree and gateway-prefix rules in findModelIdLiterals).
 */
function isHeldConsumer(obj: ObjectLiteralExpression, literal: Node, reasons: (string | undefined)[]): boolean {
  // The scan judges a declaration by the consumers in its own file (collectTsSinks is per
  // file), so a consumer elsewhere was never part of that verdict.
  if (literal.getSourceFile() !== obj.getSourceFile()) return false;
  const call = enclosingCallOfObject(obj);
  const wrapperCtor = !call && enclosingNewOfObject(obj) !== undefined && !hasCatalogSiblings(obj);
  // An example tree, and a gateway-prefixed id, hold every real request that uses the value,
  // and nothing that is data.
  if (reasons.includes(TS_EXAMPLE_CALL_REASON) || reasons.includes(TS_PREFIXED_REASON)) {
    return call ? classifyCallSurface(call).position !== 'data' : wrapperCtor;
  }
  if (call) return classifyCallSurface(call).position === 'surface_capped';
  return wrapperCtor;
}

/** Keep only the param sites whose model literal pass 1 swapped (see LlmFixOptions). */
export function onSwappedCalls(sites: ParamMatch[], swapped: ReadonlySet<Node>): ParamMatch[] {
  return sites.filter((site) => {
    const literal = modelLiteralNode(site.object.getProperty('model'));
    return literal !== undefined && swapped.has(literal);
  });
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
 * ONE scan (as modelId.ts now does), then per-file edits applied in DESCENDING
 * position order: every edit lands at an offset BEFORE the previous one, so
 * earlier offsets never shift and no pending ts-morph node reference goes
 * stale. `precomputed`, when given, reuses a caller's `findParamSites` result
 * from this same (not-yet-edited) project instead of scanning again.
 */
export function applyParamFixes(
  project: Project,
  registry: LlmRegistry,
  precomputed?: ParamMatch[],
): ParamEdit[] {
  const edits: ParamEdit[] = [];

  const sites = precomputed ?? findParamSites(project, registry);
  const byFile = new Map<string, ParamMatch[]>();
  for (const s of sites) {
    const list = byFile.get(s.location.file);
    if (list) list.push(s);
    else byFile.set(s.location.file, [s]);
  }

  for (const fileSites of byFile.values()) {
    fileSites.sort((a, b) => b.paramProp.getStart() - a.paramProp.getStart());
    for (const site of fileSites) {
      const { deprecation, paramProp, model } = site;
      // Two registry entries can target the SAME property (duplicate/overlapping
      // param entries); once the first edit consumed it, skip the stale site.
      if (paramProp.wasForgotten()) continue;
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
