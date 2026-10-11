import { relative } from 'node:path';
import { gitUnifiedPatch } from '../report/diff.js';
import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import type {
  Identifier,
  NoSubstitutionTemplateLiteral,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  StringLiteral,
  VariableDeclaration,
} from 'ts-morph';
import type { LlmModelIdDeprecation, LlmParamDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { loadProject } from '../usage/scanRepo.js';
import { modelMatches, paramEntries } from '../usage/llmRegistry.js';
import { fileAnnotation, isMaskingCast, isTestPath } from '../usage/scanLiterals.js';
import { paramHoldReason } from '../usage/coupledParams.js';
import {
  classifyCallSurface,
  enclosingCallOfObject,
  enclosingNewOfObject,
  hasCatalogSiblings,
  identifiersNamed,
  requestKeyName,
  requestObjectFlow,
  requestParamKeys,
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
//      string/template literal inline, or a `const` (or a `let`/`var` that is
//      never reassigned) bound to one. If we cannot see the model verbatim, we
//      SKIP the site rather than guess. We never touch a call whose model we
//      cannot prove.
//   3. Only sites whose resolved model matches `on_models` are edited; a
//      matching object on a non-listed model is left exactly as-is.
//   4. All edits are in-memory on the passed Project; NOTHING is ever saved.
//
// KNOWN LIMITATIONS (same accuracy-over-recall trade as the model-id locator):
//   - Model resolution is one hop: an inline literal or a same-file const/let
//     with a literal initializer. A model read from an env var, built by string
//     concatenation/template interpolation, imported from another module, or
//     reassigned is treated as unresolvable and SKIPPED. (The "reassigned" half
//     was not true until 2026-10-07: `let model = 'claude-opus-4-8'; if (cheap)
//     model = 'claude-sonnet-4-6'` resolved to Opus and lost `temperature` on
//     the Sonnet path too. See neverReassigned.)
//   - It edits any object literal with a `model` key and a rule's parameter,
//     written as plain names, not only a request it can see reach a call: a
//     standalone request body (`const body = { model, max_tokens }` posted
//     with fetch) is one, and so is a catalog row, whose readers the rename
//     breaks. Narrowing that is a separate, release-noted change. A key written
//     quoted or computed (`"max_tokens"`, `["max_tokens"]`) is read only in a
//     request (isRequestObject), so a quoted catalog row is left as it was.
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

type ModelLiteral = StringLiteral | NoSubstitutionTemplateLiteral;

/**
 * `expr` seen through the wrappers the model-id swap sees through: parentheses, a cast that masks
 * nothing (`as string`, `as const`; see isMaskingCast) and a non-null `!`. The param pass has to
 * read a model exactly where pass 1 writes one, or a swap behind a cast is followed by no parameter
 * fix: `{ model: 'o3-mini' as string, max_tokens }` became `'gpt-5.6-sol' as string` with
 * `max_tokens` left on it, while the bare twin had it renamed. The sink rule reads `MODEL!` as
 * `MODEL` (collectTsSinks), so pass 1 swaps the const behind it, and `!` is read through here too.
 */
function swapTransparent(expr: Node | undefined): Node | undefined {
  let n = expr;
  while (
    n &&
    (Node.isParenthesizedExpression(n) ||
      Node.isNonNullExpression(n) ||
      (Node.isAsExpression(n) && !isMaskingCast(n)))
  ) {
    n = n.getExpression();
  }
  return n;
}

/** The string literal `expr` is, through {@link swapTransparent} wrappers. */
function swapTransparentLiteral(expr: Node | undefined): ModelLiteral | undefined {
  const n = swapTransparent(expr);
  return n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n : undefined;
}

/**
 * The property of a request object that names `name`, quoted or not: `max_tokens`, `"max_tokens"`
 * and `'max_tokens'` are one key to the provider and to the scan (requestParamKeys).
 * `ObjectLiteralExpression.getProperty(name)` compares the key AS WRITTEN, so a quoted key was
 * invisible here: the model was swapped and the `"max_tokens"` beside it was never renamed.
 * A computed string key (`["max_tokens"]`) is the same key too (requestKeyName).
 */
function propertyNamed(obj: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
  return obj.getProperties().find((p) => !Node.isSpreadAssignment(p) && requestKeyName(p.getNameNode()) === name);
}

/** Is this property's key written as a plain name (`max_tokens`, or a `{ model }` shorthand)? */
function hasPlainKey(prop: Node): boolean {
  return (
    (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) &&
    Node.isIdentifier(prop.getNameNode())
  );
}

/**
 * Is this object a request: passed to a call (through parentheses, casts or a fallback), or built
 * in a variable and passed to a provider endpoint (requestObjectFlow)? Every object pass 1 can swap
 * a model in, or reach through a const, is one of these.
 *
 * A quoted (`"max_tokens"`) or computed (`["max_tokens"]`) key is read as the same key as the
 * plain one, so a swap is followed by its parameter fix however the request spells the key. That
 * reading is used only in a request: quoted keys are how a JSON-shaped model table or catalog row
 * is usually written, and renaming a key there breaks its readers while fixing no request. A plain
 * key is renamed in any object with a `model`, as it always was (see the header).
 */
function isRequestObject(obj: ObjectLiteralExpression): boolean {
  return enclosingCallOfObject(obj) !== undefined || requestObjectFlow(obj) !== undefined;
}

/** The literal a `model` property's own value is written as, or undefined when it is not one. */
function ownModelLiteral(modelProp: Node | undefined): ModelLiteral | undefined {
  return modelProp && Node.isPropertyAssignment(modelProp) ? swapTransparentLiteral(modelProp.getInitializer()) : undefined;
}

/**
 * The node a `model` property's value is written in: its own literal, or the literal a one-hop
 * const/let is initialised with. Handles:
 *   - `{ model: "claude-opus-5" }`, `{ model: "…" as string }`  (inline string / template literal)
 *   - `{ model: m }` with `const m = "…"`                        (one-hop const/let, literal init)
 *   - `{ model }`     shorthand, same rule
 * Anything else (env var, concatenation, interpolation, import) is unresolvable.
 *
 * The shorthand is resolved through its VALUE symbol. `getNameNode().getSymbol()` on `{ model }`
 * is the PROPERTY's symbol, whose declaration is the shorthand itself, so the shorthand never
 * resolved: `const model = 'o3-mini'; create({ model, max_tokens })` was swapped and its
 * `max_tokens` never renamed, and a held one was invisible to withoutHeldCalls.
 *
 * resolveModel reads its answer from here, so the param pass and withoutHeldCalls cannot disagree
 * about which literal a request's model is.
 *
 * Only a binding with ONE value resolves: a `const`, or a `let`/`var` nothing reassigns
 * (neverReassigned). `let model = 'claude-opus-4-8'; if (cheap) model = 'claude-sonnet-4-6'` is
 * either model at run time, and resolving it to its initializer removed `temperature` from a
 * request that may go to Sonnet. Through `{ model: model }` that was so before the shorthand
 * resolved; resolving the shorthand made `{ model }` do it too.
 */
function modelLiteralNode(modelProp: Node | undefined): ModelLiteral | undefined {
  if (!modelProp) return undefined;
  const own = ownModelLiteral(modelProp);
  if (own) return own;
  const value = Node.isPropertyAssignment(modelProp) ? swapTransparent(modelProp.getInitializer()) : undefined;
  const symbol =
    value && Node.isIdentifier(value)
      ? value.getSymbol()
      : Node.isShorthandPropertyAssignment(modelProp)
        ? modelProp.getValueSymbol()
        : undefined;
  const decl = symbol?.getValueDeclaration();
  if (!decl || !Node.isVariableDeclaration(decl) || !neverReassigned(decl)) return undefined;
  return swapTransparentLiteral(decl.getInitializer());
}

/**
 * Does this variable hold its initializer for good? A `const` does. A `let` or `var` does when no
 * write in its file targets it: an assignment (`=`, `+=`, `??=`, …), `++`/`--`, a destructuring
 * assignment, or a `for (x of …)` / `for (x in …)` head. An exported `let` cannot be written by
 * an importer, so its own file is the whole story.
 */
function neverReassigned(decl: VariableDeclaration): boolean {
  const list = decl.getParent();
  if (Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const) return true;
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return false;
  const own = nameNode.getSymbol()?.compilerSymbol;
  if (!own) return false;
  const name = nameNode.getText();
  for (const id of identifiersNamed(decl.getSourceFile(), name)) {
    if (id === nameNode || !isWriteTarget(id)) continue;
    // `({ model } = next)`: the shorthand's own symbol is the property; the variable is its value symbol.
    const parent = id.getParent();
    const symbol =
      parent && Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : id.getSymbol();
    if (symbol?.compilerSymbol === own) return false;
  }
  return true;
}

/** Is this identifier written to: an assignment target, a `++`/`--` operand, or a `for…of/in` head? */
function isWriteTarget(id: Identifier): boolean {
  // Climb through what can wrap an assignment target: parentheses and destructuring patterns
  // (`[a, model] = …`, `({ model } = …)`, `({ x: model } = …)`, `[...model] = …`).
  let target: Node = id;
  let parent = target.getParent();
  while (
    parent &&
    (Node.isParenthesizedExpression(parent) ||
      Node.isArrayLiteralExpression(parent) ||
      Node.isObjectLiteralExpression(parent) ||
      Node.isShorthandPropertyAssignment(parent) ||
      (Node.isPropertyAssignment(parent) && parent.getInitializer() === target) ||
      Node.isSpreadElement(parent) ||
      Node.isSpreadAssignment(parent))
  ) {
    target = parent;
    parent = target.getParent();
  }
  if (!parent) return false;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    return parent.getLeft() === target && op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
  }
  if (target !== id) return false;
  if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
    const op = parent.getOperatorToken();
    return op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken;
  }
  if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) return parent.getInitializer() === id;
  return false;
}

/** A `model` property's value as a concrete compile-time string, or undefined if it cannot be proven. */
function resolveModel(modelProp: Node): string | undefined {
  return modelLiteralNode(modelProp)?.getLiteralValue();
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
      const modelProp = propertyNamed(object, 'model');
      if (!modelProp) continue; // not a request-options object

      // Resolve the model ONCE per object; skip the whole object if we can't.
      const model = resolveModel(modelProp);
      if (model === undefined) continue;

      // A key written quoted or computed counts only in a request (see isRequestObject), read once.
      let request: boolean | undefined;
      for (const entry of entries) {
        const paramProp = propertyNamed(object, entry.param);
        // We only transform a plain `key: value` property. A shorthand/spread/
        // method sharing the name is left untouched (we can't safely rewrite it).
        if (!paramProp || !Node.isPropertyAssignment(paramProp)) continue;
        if (!modelMatches(model, entry.on_models)) continue;
        if (!hasPlainKey(modelProp) || !hasPlainKey(paramProp)) {
          request ??= isRequestObject(object);
          if (!request) continue;
        }

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

/**
 * A literal the model-id scan held for review: the node itself, the scan's reason, and the record
 * it was held under (a LiteralMatch carries all three), so a consumer reached through a held
 * declaration can be judged by the parameter rule the scan applies to an inline literal.
 */
export interface HeldLiteral {
  node: Node;
  reason?: string;
  deprecation?: LlmModelIdDeprecation;
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
 * holds THIS call: the file is an example tree, this call's own surface is capped, or this call's
 * own parameters hold it (the scan now holds a declaration for its consumers' parameters, so
 * `registry` is the one the scan ran with, to judge them by the same rule).
 */
export function withoutHeldCalls(
  sites: ParamMatch[],
  held: ReadonlyArray<HeldLiteral>,
  registry: LlmRegistry,
): ParamMatch[] {
  if (held.length === 0) return sites;
  const heldByNode = new Map<Node, HeldLiteral[]>();
  for (const h of held) {
    const list = heldByNode.get(h.node);
    if (list) list.push(h);
    else heldByNode.set(h.node, [h]);
  }
  return sites.filter((site) => !isHeldSite(site, heldByNode, registry));
}

/**
 * A site is held when its request object is held, or when that object sits inside a held
 * request: `fallbacks: [{ model, max_tokens }]` or `override: { … }` within a held call's own
 * argument. The nested object's literal is data to the scan (it is not a call argument), so its
 * own verdict cannot say the call is held; the request it is part of can. (Review of PR #50,
 * round two: the nested `max_tokens` was still renamed inside a call listed as held.)
 */
function isHeldSite(site: ParamMatch, heldByNode: ReadonlyMap<Node, HeldLiteral[]>, registry: LlmRegistry): boolean {
  return requestObjectsAround(site.object).some((obj) => isHeldObject(obj, heldByNode, registry));
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
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr) || Node.isNonNullExpression(expr)) {
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
  heldByNode: ReadonlyMap<Node, HeldLiteral[]>,
  registry: LlmRegistry,
): boolean {
  for (const leaf of modelValueLeaves(propertyNamed(obj, 'model'))) {
    const held = heldByNode.get(leaf.node);
    if (!held) continue;
    // The object's own value: the scan judged this very request.
    if (!leaf.viaDeclaration) return true;
    if (isHeldConsumer(obj, leaf.node, held, registry)) return true;
  }
  return false;
}

/**
 * A request fed a declaration the scan held. The scan holds a declaration when ANY consumer
 * is held, so judge THIS consumer the way the scan judges a literal written in it
 * (classifyByEnclosure, then the example-tree, gateway-prefix and parameter rules in
 * findModelIdLiterals).
 */
function isHeldConsumer(
  obj: ObjectLiteralExpression,
  literal: Node,
  held: readonly HeldLiteral[],
  registry: LlmRegistry,
): boolean {
  // The scan judges a declaration by the consumers in its own file (collectTsSinks is per
  // file), so a consumer elsewhere was never part of that verdict.
  if (literal.getSourceFile() !== obj.getSourceFile()) return false;
  const call = enclosingCallOfObject(obj);
  const wrapperCtor = !call && enclosingNewOfObject(obj) !== undefined && !hasCatalogSiblings(obj);
  // An example tree, and a gateway-prefixed id, hold every real request that uses the value,
  // and nothing that is data.
  if (held.some((h) => h.reason === TS_EXAMPLE_CALL_REASON || h.reason === TS_PREFIXED_REASON)) {
    return call ? classifyCallSurface(call).position !== 'data' : wrapperCtor;
  }
  if (!call) return wrapperCtor;
  const surface = classifyCallSurface(call).position;
  if (surface === 'surface_capped') return true;
  // An ordinary request is held by its own parameters, as its inline twin would be. A declaration
  // shared by a call held for its parameters and one that is not keeps the other's fix.
  const keys = [requestParamKeys(obj)];
  return (
    surface === 'model_arg' &&
    held.some((h) => h.deprecation !== undefined && paramHoldReason(keys, h.deprecation, registry) !== undefined)
  );
}

/** Keep only the param sites whose model literal pass 1 swapped (see LlmFixOptions). */
export function onSwappedCalls(sites: ParamMatch[], swapped: ReadonlySet<Node>): ParamMatch[] {
  return sites.filter((site) => {
    const literal = modelLiteralNode(propertyNamed(site.object, 'model'));
    return literal !== undefined && swapped.has(literal);
  });
}

/**
 * Rename a property key to `replacement`, preserving how it was written: a quoted key keeps its
 * quote, and a computed `["max_tokens"]` stays computed (`["max_completion_tokens"]`).
 */
function renameKey(paramProp: PropertyAssignment, replacement: string): void {
  const nameNode = paramProp.getNameNode();
  const written = Node.isComputedPropertyName(nameNode) ? nameNode.getExpression() : nameNode;
  if (Node.isStringLiteral(written) || Node.isNoSubstitutionTemplateLiteral(written)) {
    const quote = written.getText()[0];
    written.replaceWithText(`${quote}${replacement}${quote}`);
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
