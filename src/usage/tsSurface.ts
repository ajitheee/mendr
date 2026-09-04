import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, Expression, Identifier, NewExpression, SourceFile } from 'ts-morph';
import { isModelLikeName } from './scanLiterals.js';

// The TypeScript spelling of the Python guards G1–G5 (src/python/sinks.ts).
//
// External validation on 12 real repositories (2026-09-03) found that the TS
// scanner granted Tier A — an unattended, auto-applied swap — to:
//   * any `model:` property in an object passed to ANY call (a React Query
//     mutation, `JSON.stringify` of a mocked response, an internal wrapper);
//   * any exported constant whose name contained "model", with no request
//     anywhere in the repo;
//   * a module-level constant in a smoke-test helper.
// 60 of the 62 Tier-A locations checked were wrong. The Python scanner had
// already learned every one of these lessons; this module ports them.
//
// THE CONTRACT. A literal earns `model_arg` (Tier A candidate) only when the
// call it feeds is a request on a FIRST-PARTY provider SDK whose client resolves,
// in this file, to that SDK's constructor or factory with no proxy / Azure /
// custom-fetch override, and the call is not module-level execution. Every
// other shape is REAL but capped at review — "uncertainty always reduces
// authority". Nothing here can promote; it can only refuse to promote.

export type TsProviderFamily = 'openai' | 'anthropic' | 'google';
export type TsSurface = 'direct' | 'azure' | 'vertex' | 'proxy' | 'unknown_wrapper';

/** First-party provider packages and the surface each one is. */
const FIRST_PARTY: ReadonlyArray<{ test: RegExp; family: TsProviderFamily; surface: TsSurface }> = [
  { test: /^openai(\/|$)/, family: 'openai', surface: 'direct' },
  { test: /^@anthropic-ai\/sdk(\/|$)/, family: 'anthropic', surface: 'direct' },
  { test: /^@anthropic-ai\/(bedrock|vertex)-sdk/, family: 'anthropic', surface: 'vertex' },
  { test: /^@google\/generative-ai(\/|$)/, family: 'google', surface: 'direct' },
  { test: /^@google\/genai(\/|$)/, family: 'google', surface: 'direct' },
  { test: /^@google-cloud\/vertexai/, family: 'google', surface: 'vertex' },
  { test: /^@ai-sdk\/openai(\/|$)/, family: 'openai', surface: 'direct' },
  { test: /^@ai-sdk\/anthropic(\/|$)/, family: 'anthropic', surface: 'direct' },
  { test: /^@ai-sdk\/google(\/|$)/, family: 'google', surface: 'direct' },
  { test: /^@ai-sdk\/google-vertex/, family: 'google', surface: 'vertex' },
  { test: /^@ai-sdk\/azure/, family: 'openai', surface: 'azure' },
  { test: /^@ai-sdk\/amazon-bedrock/, family: 'anthropic', surface: 'vertex' },
];

/** Constructor / factory names that are Azure regardless of the package. */
const AZURE_CTORS = new Set(['AzureOpenAI', 'createAzure', 'azure']);

/** Option keys whose presence means the client is NOT talking to the provider directly. */
const OVERRIDE_KEY = /\b(baseURL|baseUrl|base_url|apiBase|api_base|endpoint|endpointUrl|fetch|httpAgent|dangerouslyAllowBrowser)\s*:/;

export interface TsSurfaceVerdict {
  surface: TsSurface;
  family: TsProviderFamily | null;
  /** How the receiver was resolved, for the review reason. */
  via: string;
}

// --- reason strings (exported so tests pin the exact wording) -----------------

export const TS_MODULE_LEVEL_REASON =
  'module-level execution (fires at import); a real request, capped at review';
export const TS_SURFACE_REASON = 'provider surface caps this call at review';
export const TS_PREFIXED_REASON =
  'provider-prefixed selector (gateway / provider registry); the successor may need a different prefix, capped at review';
export const TS_CLI_DEFAULT_REASON =
  'default value of a command-line --model option; a real selector whose use is not traced, review before changing';
export const TS_EXAMPLE_REASON =
  'example / sample / demo / docs tree: informational, not a dependency of the shipped product';
export const TS_DEFAULT_UNTRACED_REASON =
  'model-named declaration not traced to any provider request in this file';

// --- AST helpers ----------------------------------------------------------------

/** Is `node` executed at module top level (outside every function/method/arrow)? */
export function isModuleLevel(node: Node): boolean {
  let n: Node | undefined = node.getParent();
  while (n) {
    if (
      Node.isFunctionDeclaration(n) ||
      Node.isFunctionExpression(n) ||
      Node.isArrowFunction(n) ||
      Node.isMethodDeclaration(n) ||
      Node.isConstructorDeclaration(n) ||
      Node.isGetAccessorDeclaration(n) ||
      Node.isSetAccessorDeclaration(n)
    ) {
      return false;
    }
    n = n.getParent();
  }
  return true;
}

/** The nearest enclosing function-like node, or undefined at module level. */
function enclosingFunction(node: Node): Node | undefined {
  let n: Node | undefined = node.getParent();
  while (n) {
    if (
      Node.isFunctionDeclaration(n) ||
      Node.isFunctionExpression(n) ||
      Node.isArrowFunction(n) ||
      Node.isMethodDeclaration(n) ||
      Node.isConstructorDeclaration(n)
    ) {
      return n;
    }
    n = n.getParent();
  }
  return undefined;
}

/** The nearest enclosing class, or undefined. */
function enclosingClass(node: Node): Node | undefined {
  let n: Node | undefined = node.getParent();
  while (n) {
    if (Node.isClassDeclaration(n) || Node.isClassExpression(n)) return n;
    n = n.getParent();
  }
  return undefined;
}

/**
 * The leftmost expression of a callee chain: `client` for
 * `client.chat.completions.create`, the NewExpression for `new OpenAI().chat…`,
 * the identifier for `openai(...)`, `this` for `this.complete(...)`.
 */
function rootOfCallee(expr: Expression): Node {
  let n: Node = expr;
  for (;;) {
    if (Node.isPropertyAccessExpression(n) || Node.isElementAccessExpression(n)) {
      n = n.getExpression();
    } else if (Node.isCallExpression(n)) {
      n = n.getExpression();
    } else if (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isNonNullExpression(n)) {
      n = n.getExpression();
    } else if (Node.isAwaitExpression(n)) {
      n = n.getExpression();
    } else {
      return n;
    }
  }
}

/** Module specifier of the import that declares `decl`, if it is an import binding. */
function importSpecifierOf(decl: Node): string | undefined {
  if (Node.isImportSpecifier(decl)) return decl.getImportDeclaration().getModuleSpecifierValue();
  if (Node.isImportClause(decl)) {
    const p = decl.getParent();
    return Node.isImportDeclaration(p) ? p.getModuleSpecifierValue() : undefined;
  }
  if (Node.isNamespaceImport(decl)) {
    const clause = decl.getParent();
    const p = clause?.getParent();
    return p && Node.isImportDeclaration(p) ? p.getModuleSpecifierValue() : undefined;
  }
  if (Node.isImportEqualsDeclaration(decl)) {
    const ref = decl.getModuleReference();
    if (Node.isExternalModuleReference(ref)) {
      const e = ref.getExpression();
      if (e && Node.isStringLiteral(e)) return e.getLiteralValue();
    }
  }
  return undefined;
}

function familyOfPackage(spec: string): { family: TsProviderFamily; surface: TsSurface } | undefined {
  for (const p of FIRST_PARTY) if (p.test.test(spec)) return { family: p.family, surface: p.surface };
  return undefined;
}

/** The text of a construction/factory call's arguments (to detect proxy overrides). */
function argumentsText(node: Node): string {
  if (Node.isNewExpression(node) || Node.isCallExpression(node)) {
    return node
      .getArguments()
      .map((a) => a.getText())
      .join(',');
  }
  return '';
}

const MAX_HOPS = 4;

/**
 * Resolve what a callee root ultimately IS: a first-party SDK binding (direct /
 * azure / vertex), a proxied client, or something we cannot see through. Bounded
 * to a few declaration hops so pathological files cannot stall the scan.
 */
function resolveRoot(root: Node, hops: number): TsSurfaceVerdict {
  if (hops > MAX_HOPS) return { surface: 'unknown_wrapper', family: null, via: 'too many hops' };

  // `new OpenAI({...})` inline, or the initializer of a resolved variable.
  if (Node.isNewExpression(root) || Node.isCallExpression(root)) {
    const callee = rootOfCallee(root.getExpression());
    const name = Node.isIdentifier(callee) ? callee.getText() : '';
    const inner = Node.isIdentifier(callee)
      ? resolveIdentifier(callee, hops + 1)
      : { surface: 'unknown_wrapper' as TsSurface, family: null, via: 'non-identifier constructor' };
    if (inner.surface === 'unknown_wrapper') return inner;
    if (AZURE_CTORS.has(name)) return { surface: 'azure', family: inner.family, via: `${name}(…)` };
    if (OVERRIDE_KEY.test(argumentsText(root))) {
      return { surface: 'proxy', family: inner.family, via: `${name}(…) with a base URL / fetch override` };
    }
    return { ...inner, via: `${name}(…) ← ${inner.via}` };
  }
  if (Node.isIdentifier(root)) return resolveIdentifier(root, hops);
  if (Node.isThisExpression(root)) return { surface: 'unknown_wrapper', family: null, via: 'this.…' };
  return { surface: 'unknown_wrapper', family: null, via: root.getKindName() };
}

/**
 * Every declaration of `name` visible from `from`, found SYNTACTICALLY: import
 * bindings of the file, then variable declarations and parameters walking up the
 * scope chain. No type checker — `getSymbol()` forces a full semantic program
 * and took lobe-chat from 22 s to 77 s. The contract only ever trusts an
 * in-file binding anyway, so a syntactic lookup loses nothing.
 */
function declarationsOf(from: Node, name: string): Node[] {
  const out: Node[] = [];
  const sf = from.getSourceFile();
  for (const imp of sf.getImportDeclarations()) {
    const def = imp.getDefaultImport();
    if (def && def.getText() === name) out.push(imp.getImportClause()!);
    const ns = imp.getNamespaceImport();
    if (ns && ns.getText() === name) out.push(imp.getImportClause()!.getNamespaceImportOrThrow());
    for (const spec of imp.getNamedImports()) {
      const local = spec.getAliasNode()?.getText() ?? spec.getName();
      if (local === name) out.push(spec);
    }
  }
  let scope: Node | undefined = from.getParent();
  while (scope) {
    if (Node.isBlock(scope) || Node.isSourceFile(scope) || Node.isModuleBlock(scope) || Node.isCaseClause(scope)) {
      for (const st of scope.getChildSyntaxList()?.getChildren() ?? []) {
        if (!Node.isVariableStatement(st)) continue;
        for (const d of st.getDeclarations()) {
          if (Node.isIdentifier(d.getNameNode()) && d.getName() === name) out.push(d);
        }
      }
    }
    if (
      Node.isFunctionDeclaration(scope) ||
      Node.isFunctionExpression(scope) ||
      Node.isArrowFunction(scope) ||
      Node.isMethodDeclaration(scope) ||
      Node.isConstructorDeclaration(scope)
    ) {
      for (const p of scope.getParameters()) if (p.getName() === name) out.push(p);
    }
    if (Node.isClassDeclaration(scope) || Node.isClassExpression(scope)) {
      for (const m of scope.getMembers()) {
        if (Node.isPropertyDeclaration(m) && m.getName() === name) out.push(m);
      }
    }
    scope = scope.getParent();
  }
  return out;
}

function resolveIdentifier(id: Identifier, hops: number): TsSurfaceVerdict {
  const decls = declarationsOf(id, id.getText());
  if (decls.length === 0) return { surface: 'unknown_wrapper', family: null, via: `${id.getText()} (undeclared)` };
  // One binding only. Two declarations of the same name is ambiguity, and
  // ambiguity reduces authority.
  const decl = decls.length === 1 ? decls[0] : undefined;
  if (!decl) return { surface: 'unknown_wrapper', family: null, via: `${id.getText()} (multiple declarations)` };

  const spec = importSpecifierOf(decl);
  if (spec !== undefined) {
    const fp = familyOfPackage(spec);
    if (!fp) return { surface: 'unknown_wrapper', family: null, via: `imported from '${spec}'` };
    if (AZURE_CTORS.has(id.getText())) return { surface: 'azure', family: fp.family, via: `'${spec}'` };
    return { surface: fp.surface, family: fp.family, via: `'${spec}'` };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (!init) return { surface: 'unknown_wrapper', family: null, via: `${id.getText()} (no initializer)` };
    let expr: Node = init;
    while (Node.isAwaitExpression(expr) || Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr)) {
      expr = expr.getExpression();
    }
    if (Node.isNewExpression(expr) || Node.isCallExpression(expr)) return resolveRoot(expr, hops + 1);
    if (Node.isIdentifier(expr)) return resolveIdentifier(expr, hops + 1);
    return { surface: 'unknown_wrapper', family: null, via: `${id.getText()} = ${expr.getKindName()}` };
  }
  // A parameter, a class property, a destructured binding, `this` — injected or
  // dynamic. We cannot see the client, so we cannot authorize an unattended swap.
  return { surface: 'unknown_wrapper', family: null, via: `${id.getText()} (${decl.getKindName()})` };
}

/** Resolve the provider surface behind a call's receiver / callee. */
export function resolveCallSurface(call: CallExpression): TsSurfaceVerdict {
  return resolveRoot(rootOfCallee(call.getExpression()), 0);
}

/**
 * The provider family an ENDPOINT belongs to, read off the callee chain:
 * `messages.create` is Anthropic, `chat.completions.create` / `responses.create`
 * is OpenAI, `getGenerativeModel` / `generateContent` is Google. Unknown → null.
 * (G4, receiver-bound: an Anthropic client must never authorize an OpenAI swap.)
 */
export function endpointFamily(call: CallExpression): TsProviderFamily | null {
  const text = call.getExpression().getText();
  if (/\.messages\.(create|stream)\b/.test(text)) return 'anthropic';
  if (/\.(chat\.completions|completions|responses|embeddings|images|audio|moderations)\.\w+$/.test(text)) return 'openai';
  if (/\b(getGenerativeModel|generateContent|generateContentStream|embedContent)\b/.test(text)) return 'google';
  return null;
}

// --- the verdicts the classifier consumes -----------------------------------------

export type SurfaceClassification =
  | { position: 'model_arg' }
  | { position: 'surface_capped'; reason: string }
  | { position: 'usage_unverified'; reason: string };

/**
 * G1 + G4 for one call: module-level execution and any non-direct surface cap
 * at review; only a resolved first-party client inside a function reaches
 * `model_arg`.
 */
export function classifyCallSurface(call: CallExpression): SurfaceClassification {
  if (isModuleLevel(call)) return { position: 'surface_capped', reason: TS_MODULE_LEVEL_REASON };
  const v = resolveCallSurface(call);
  if (v.surface !== 'direct') {
    return { position: 'surface_capped', reason: `${TS_SURFACE_REASON} (${v.surface}: ${v.via})` };
  }
  const wanted = endpointFamily(call);
  if (wanted && v.family && wanted !== v.family) {
    return {
      position: 'surface_capped',
      reason: `${TS_SURFACE_REASON} (client is ${v.family}, endpoint is ${wanted})`,
    };
  }
  return { position: 'model_arg' };
}

// --- sink tracing for declarations ----------------------------------------------------

/** Every identifier name that is fed to a model position, with the calls that consume it. */
export type TsSinkMap = ReadonlyMap<string, readonly CallExpression[]>;

/** Callee last-identifiers that take a model id as a direct string argument. */
export const TS_MODEL_FACTORIES: ReadonlySet<string> = new Set([
  'google',
  'openai',
  'anthropic',
  'azure',
  'createOpenAI',
  'createAnthropic',
  'createGoogleGenerativeAI',
  'createAzure',
  'getGenerativeModel',
  'generativeModel',
  'languageModel',
  'textEmbeddingModel',
  'embeddingModel',
  'embedding',
  'imageModel',
  'image',
  'responses',
  'completion',
  'messages',
  'chat',
]);

function lastIdentifier(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

/** Climb `||` / `??` / parens / casts / ternaries to the value's real container. */
function climbTransparent(node: Node): Node {
  let n: Node = node;
  let p = n.getParent();
  while (p) {
    if (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p)) {
      n = p;
    } else if (Node.isBinaryExpression(p)) {
      const op = p.getOperatorToken().getKind();
      if (op !== SyntaxKind.BarBarToken && op !== SyntaxKind.QuestionQuestionToken) break;
      n = p;
    } else if (Node.isConditionalExpression(p) && (p.getWhenTrue() === n || p.getWhenFalse() === n)) {
      n = p;
    } else {
      break;
    }
    p = n.getParent();
  }
  return n;
}

/** The traceable name of an expression: `MODEL` → "MODEL", `this.model` → "model". */
function traceableName(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr) && Node.isThisExpression(expr.getExpression())) return expr.getName();
  return undefined;
}

/**
 * Collect, once per file, every identifier that reaches a model position: the
 * value of a model-like property in an object passed to a call, or a direct
 * argument to a model factory. The DECLARATION rule consults this so that
 * `const MODEL = "gpt-4"` is judged by where MODEL is USED, not by its name.
 */
export function collectTsSinks(sf: SourceFile): TsSinkMap {
  const sinks = new Map<string, CallExpression[]>();
  const add = (name: string | undefined, call: CallExpression): void => {
    if (!name) return;
    const list = sinks.get(name);
    if (list) list.push(call);
    else sinks.set(name, [call]);
  };
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const factory = lastIdentifier(call);
    for (const arg of call.getArguments()) {
      // (c) `openai(MODEL)`
      if (factory && TS_MODEL_FACTORIES.has(factory)) add(traceableName(arg), call);
      // (a) `create({ model: MODEL })`, `create({ model })`, `create({ model: x ?? MODEL })`
      if (!Node.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.getProperties()) {
        if (Node.isShorthandPropertyAssignment(prop)) {
          if (isModelLikeName(prop.getName())) add(prop.getName(), call);
        } else if (Node.isPropertyAssignment(prop)) {
          if (!isModelLikeName(prop.getName())) continue;
          const init = prop.getInitializer();
          if (!init) continue;
          for (const leaf of leavesOf(init)) add(traceableName(leaf), call);
        }
      }
    }
  }
  return sinks;
}

/** The identifier leaves of a value expression through `||` / `??` / parens / ternaries. */
function leavesOf(expr: Node): Node[] {
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr) || Node.isNonNullExpression(expr)) {
    return leavesOf(expr.getExpression());
  }
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getKind();
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
      return [...leavesOf(expr.getLeft()), ...leavesOf(expr.getRight())];
    }
    return [];
  }
  if (Node.isConditionalExpression(expr)) return [...leavesOf(expr.getWhenTrue()), ...leavesOf(expr.getWhenFalse())];
  return [expr];
}

/** Does a sink call see the declaration? Module-level: everywhere. Local: same function. Class property: same class. */
function sinkInScope(decl: Node, call: CallExpression): boolean {
  if (Node.isPropertyDeclaration(decl)) {
    const c = enclosingClass(decl);
    const u = enclosingClass(call);
    return !!c && !!u && c === u;
  }
  const declFn = enclosingFunction(decl);
  if (!declFn) return true;
  // Lexical scoping: a closure NESTED inside the declaring function sees the
  // declaration (`const model = "…"; const run = async () => client.…create({ model })`).
  let n: Node | undefined = call;
  while (n) {
    if (n === declFn) return true;
    n = n.getParent();
  }
  return false;
}

/**
 * Rule (b), the sink rule: a model-named declaration is swap-eligible only when
 * every in-scope consumer is a resolved first-party request inside a function.
 * No consumer → `usage_unverified` (review). Any capped consumer → the cap wins.
 */
export function judgeDeclarationSinks(decl: Node, name: string, sinks: TsSinkMap | undefined): SurfaceClassification {
  const calls = (sinks?.get(name) ?? []).filter((c) => sinkInScope(decl, c));
  if (calls.length === 0) return { position: 'usage_unverified', reason: TS_DEFAULT_UNTRACED_REASON };
  for (const call of calls) {
    const v = classifyCallSurface(call);
    if (v.position !== 'model_arg') return v;
  }
  return { position: 'model_arg' };
}

/**
 * The enclosing CallExpression of an object literal that is (through transparent
 * wrappers) one of that call's arguments — or undefined when the object stands
 * alone (a catalog entry, a returned config, an array element).
 */
export function enclosingCallOfObject(obj: Node): CallExpression | undefined {
  const top = climbTransparent(obj);
  const parent = top.getParent();
  if (parent && Node.isCallExpression(parent) && parent.getArguments().includes(top as Expression)) return parent;
  return undefined;
}

/** `program.option('-m, --model <model>', 'Model ID', 'dall-e-3')`: the default of a --model flag. */
export function isCliModelOptionDefault(call: CallExpression, arg: Node): boolean {
  const name = lastIdentifier(call);
  if (!name || !/^(option|requiredOption|addOption|argument|flag)$/.test(name)) return false;
  const args = call.getArguments();
  if (args.length < 2 || args[0] === arg) return false;
  const first = args[0];
  const flags = Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first) ? first.getLiteralValue() : first.getText();
  return /model/i.test(flags);
}

/** Re-exported for callers that only need the constructor check. */
export function isNewExpressionNode(n: Node): n is NewExpression {
  return Node.isNewExpression(n);
}
