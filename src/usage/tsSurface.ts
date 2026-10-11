import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import type {
  AsExpression,
  CallExpression,
  Expression,
  Identifier,
  NewExpression,
  NonNullExpression,
  ParenthesizedExpression,
  SatisfiesExpression,
  SourceFile,
} from 'ts-morph';
import { CATALOG_SIBLING_KEYS, isDefaultContainerName, isModelLikeName } from './sharedRules.js';

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
export type TsSurface = 'direct' | 'azure' | 'vertex' | 'proxy' | 'unknown_wrapper' | 'not_provider';

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
/**
 * The one verdict in this file that DEMOTES. Everything else here can only refuse to
 * promote; this says a call is provably not a provider request at all, so a model id
 * handed to it is a recorded value rather than a selection.
 *
 * Measured 2026-09-28: three of promptfoo's four new false positives were
 * `'model.name': 'gpt-3.5-turbo'` inside OpenTelemetry span attributes, capped at review
 * because the local helper carrying them (`runInSpan`, declared in the same file) came back
 * `unknown_wrapper (undeclared)` — `declarationsOf` collected imports, variables, parameters
 * and class properties, and never function declarations. Seeing the declaration is only half
 * the fix: a local function still resolves to no provider, so the reason improved and the
 * verdict did not. The demotion below is the other half, and it is deliberately narrow.
 */
export const TS_NOT_PROVIDER_REASON =
  'recorded by a helper in a file that cannot reach a provider (no provider import, no network call, no provider endpoint): telemetry or logging, not a selection';
export const TS_PREFIXED_REASON =
  'provider-prefixed selector (gateway / provider registry); the successor may need a different prefix, capped at review';
export const TS_CLI_DEFAULT_REASON =
  'default value of a command-line --model option; a real selector whose use is not traced, review before changing';
export const TS_EXAMPLE_REASON =
  'example / sample / demo / docs tree: informational, not a dependency of the shipped product';
/**
 * An example that actually CALLS a provider. Measured 2026-09-28 across twelve public
 * repositories: the blanket example-tree rule was the single largest cause of missed live
 * call sites — langgraph's registered graph entrypoints, three of chroma's five live sites,
 * and most of openai-cookbook's evaluation harnesses. Copying one of those files into `src/`
 * made the scanner classify it correctly, which proved the parser was already right and the
 * path rule was discarding its answer.
 *
 * Capped at review rather than promoted to Tier A: a sample is still a weaker claim on the
 * shipped product than application code, and rewriting somebody's example unattended is
 * presumptuous. Detection is right; an unattended swap is not.
 */
/**
 * `new OpenAiChat({ model: "gpt-4" })` — a model argument to a wrapper CLASS. Real: the value
 * is the model this object will request with. Capped at review because the constructor is not
 * a provider SDK call and nothing here proves what it does with the id; a first-party wrapper
 * may normalise, map or ignore it.
 */
export const TS_WRAPPER_CTOR_REASON =
  'model argument to a constructor: a real selection, but the constructor is not a provider SDK request, so the swap is not verifiable here — review';
export const TS_EXAMPLE_CALL_REASON =
  'example / sample tree, but the id is passed to a real provider request here: runnable, so it breaks at retirement — review, never an unattended swap';
export const TS_DEFAULT_UNTRACED_REASON =
  'model-named declaration not traced to any provider request in this file';
export const TS_DEFAULT_CONTAINER_REASON =
  'model value inside a default-configuration object; a real default whose consumer is not traced, review before changing';
export const TS_LOOKUP_DEFAULT_REASON =
  'fallback value of a model lookup; a real default whose consumer is not traced, review before changing';
/**
 * `const req = { model: 'gpt-4', messages }` … `client.chat.completions.create(req)`, where the
 * variable is ALSO used some other way: spread into another object, read by something that is
 * not a provider request, changed after it was built, declared with `let`, or exported. The
 * object reaches a provider request, so the id is live; what that request finally carries is not
 * all visible in the object literal, so the swap is not an unattended one.
 */
export const TS_REQUEST_VARIABLE_REASON =
  'request object built in a variable and passed to a provider request, but the variable is also used, spread, changed or exported elsewhere, so the request it sends is not all visible here — review';

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
 * Packages that cannot originate a model request. Deliberately an ALLOWLIST, not a denylist
 * of provider SDKs: a gateway or aggregator (`langchain`, `litellm`, `openrouter`, a relative
 * `./llm` module) reaches a provider without naming one, so "not in FIRST_PARTY" is nowhere
 * near the same claim as "inert". Anything unrecognised keeps the review cap.
 */
const INERT_PACKAGE = /^(@opentelemetry\/|node:)/;
const NODE_BUILTIN = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'os', 'path', 'process',
  'stream', 'string_decoder', 'timers', 'url', 'util', 'zlib',
]);

/** Callees that put bytes on the wire. A file holding one of these is never inert. */
const NETWORK_CALL = /^(fetch|axios|got|superagent|undici|XMLHttpRequest)$|\b(https?\.(request|get)|axios\.\w+)$/;

/**
 * Module specifiers a file pulls in, via `import` or `require()`. Takes the call list the
 * caller already walked — this runs on every file in a repository, and litellm alone holds
 * tens of thousands of call expressions.
 */
function moduleSpecifiersOf(sf: SourceFile, calls: readonly CallExpression[]): string[] {
  const out = sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue());
  for (const call of calls) {
    if (call.getExpression().getText() !== 'require') continue;
    const arg = call.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      out.push(arg.getLiteralValue());
    }
  }
  return out;
}

const INERT_FILE = new WeakMap<SourceFile, boolean>();

/**
 * Can NOTHING in this file reach a model provider? True only when every module it imports is
 * telemetry or the standard library AND no call puts bytes on the wire. Both halves are
 * needed: without the import check a file could forward to `./llm`; without the network check
 * it could hand-roll the HTTP request. A `false` here is the safe answer, and an unrecognised
 * import always produces one — the failure this guards against is a false clean, which
 * `tsGuards.test.ts` calls the one answer this product must never give.
 */
function fileCannotReachProvider(sf: SourceFile): boolean {
  const cached = INERT_FILE.get(sf);
  if (cached !== undefined) return cached;
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const inertImports = moduleSpecifiersOf(sf, calls).every(
    (s) => INERT_PACKAGE.test(s) || NODE_BUILTIN.has(s),
  );
  const noNetwork = !calls.some((c) => NETWORK_CALL.test(c.getExpression().getText()));
  // The import check alone is NOT enough, and this line is why. A file with no imports at all
  // passes `inertImports` vacuously, so an injected client — `function ask(client, opts) {
  // return client.chat.completions.create(opts) }` — was demoted to informational on a file
  // that makes a real OpenAI request. Caught by probing the rule before shipping it; it is a
  // FALSE CLEAN, the one answer this product must never give. A provider endpoint shape
  // anywhere in the file disqualifies it regardless of how the client got there.
  const noProviderEndpoint = !calls.some(
    (c) => endpointFamily(c) !== null || TS_MODEL_FACTORIES.has(lastIdentifier(c) ?? ''),
  );
  const verdict = inertImports && noNetwork && noProviderEndpoint;
  INERT_FILE.set(sf, verdict);
  return verdict;
}

/** Is this declaration a function the caller could be invoking? */
function isFunctionValued(decl: Node): boolean {
  if (Node.isFunctionDeclaration(decl)) return true;
  if (!Node.isVariableDeclaration(decl)) return false;
  const init = decl.getInitializer();
  return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
}

/**
 * Every declaration of `name` visible from `from`, found SYNTACTICALLY: import
 * bindings of the file, then function and variable declarations and parameters walking up
 * the scope chain. No type checker — `getSymbol()` forces a full semantic program
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
        // A hoisted `function foo() {}` is a binding like any other. Collecting only
        // variable statements made every locally-declared helper read as `undeclared`,
        // which is why an OpenTelemetry span helper was indistinguishable from an
        // unresolvable provider wrapper. See TS_NOT_PROVIDER_REASON.
        if (Node.isFunctionDeclaration(st) && st.getName() === name) {
          out.push(st);
          continue;
        }
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
  // The only DEMOTION in this file, and both halves of its test are lexical. A helper
  // declared HERE (so it is not a cross-file wrapper we cannot read) in a file that can make
  // no provider request (so nothing it calls is one either) does not select a model — it
  // records one. Everything else below can still only refuse to promote.
  if (isFunctionValued(decl) && fileCannotReachProvider(id.getSourceFile())) {
    return {
      surface: 'not_provider',
      family: null,
      via: `${id.getText()} declared in this file, which makes no provider request`,
    };
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
  | { position: 'usage_unverified'; reason: string }
  | { position: 'data'; purpose: 'not_provider_call'; reason: string };

/**
 * G1 + G4 for one call: module-level execution and any non-direct surface cap
 * at review; only a resolved first-party client inside a function reaches
 * `model_arg`.
 */
export function classifyCallSurface(call: CallExpression): SurfaceClassification {
  const v = resolveCallSurface(call);
  // Checked BEFORE the module-level cap: "this file cannot reach a provider" is the stronger
  // fact of the two. Module-level execution caps at review because the call fires at import —
  // which is only interesting if the call could be a request at all.
  if (v.surface === 'not_provider') {
    return { position: 'data', purpose: 'not_provider_call', reason: TS_NOT_PROVIDER_REASON };
  }
  if (isModuleLevel(call)) return { position: 'surface_capped', reason: TS_MODULE_LEVEL_REASON };
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

// --- request parameter keys ---------------------------------------------------------
//
// The parameter guards (coupledParams.ts) judge a swap by the keys of the request its model
// reaches. Three things have to agree for that to be honest: which key a property names, which
// wrappers a model value can sit in and still be that property's value, and which requests a
// declaration's model reaches. They live here, beside the sink rule, so the scanner and the
// parameter pass read keys one way.

/**
 * The key a property names, unquoted: `max_tokens`, `"max_tokens"` and `'max_tokens'` are one
 * key. A computed key (`[k]`) is returned as written, because its name is not known here.
 */
export function propertyKeyName(nameNode: Node): string {
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.getLiteralValue();
  }
  return nameNode.getText();
}

/**
 * The key a request property is sent under: {@link propertyKeyName}, and also the string inside a
 * computed key, so `["max_tokens"]: 5` is `max_tokens` to the provider, to the parameter checks
 * and to the param pass. It used to read as `["max_tokens"]`, which no rule names, so
 * `{ model: 'gpt-4-0613', ["max_tokens"]: 5 }` was swapped while its plain-key twin was held.
 * (classifyByEnclosure keeps {@link propertyKeyName}: its model test is a pattern over the key's
 * text, which a computed `["model"]` already matched, so no position changes.)
 */
export function requestKeyName(nameNode: Node): string {
  if (Node.isComputedPropertyName(nameNode)) {
    const expr = nameNode.getExpression();
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();
  }
  return propertyKeyName(nameNode);
}

/** The keys of a request object, unquoted: the parameters the call passes beside its model. */
export function requestParamKeys(obj: Node): string[] {
  if (!Node.isObjectLiteralExpression(obj)) return [];
  const keys: string[] = [];
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) {
      const name = requestKeyName(p.getNameNode());
      if (name) keys.push(name);
    }
  }
  return keys;
}

/**
 * Wrappers that change neither a value nor where it goes: parentheses, `as`, `satisfies`, `!`.
 * A `||`, `??` or ternary is NOT one of them: it can hand the property a different value.
 * (`satisfies` is listed so the rule is complete, but no parameter check meets one today:
 * classifyLiteral does not see through it and collectTsSinks does not unwrap it, so a model id
 * behind `satisfies` never earns `model_arg`.)
 */
export function isValueWrapper(
  node: Node,
): node is ParenthesizedExpression | AsExpression | SatisfiesExpression | NonNullExpression {
  return (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node)
  );
}

/** `expr` with its value wrappers ({@link isValueWrapper}) taken off. */
export function unwrapValueWrappers(expr: Node): Node {
  let n = expr;
  while (isValueWrapper(n)) n = n.getExpression();
  return n;
}

/**
 * The parameter keys of each request in `call` whose model is `name`, read the way an inline
 * literal's keys are read: an object-literal argument whose model-like property is `{ name }`, or
 * a value one of whose leaves is `name` (through value wrappers, `||`, `??` and a ternary's
 * branches, as collectTsSinks finds it). A model reached through a fallback (`x || name`) is this
 * request's model whenever that branch is taken, and its inline twin (`x || '…'`) is judged by the
 * same keys (requestKeySets in scanLiterals.ts). A factory consumer (`openai(name)`) carries no
 * request keys of its own, like its inline twin.
 *
 * With `decl`, a request whose `name` provably reads ANOTHER binding adds nothing either (see
 * {@link consumerReadsDeclaration}). The sink map files consumers by name, which is right for the
 * surface rule it was built for, but read as parameter keys it held a declaration for a call that
 * never sees it: `const model = 'gpt-4-0613'` beside `function b(model: string) { create({ model,
 * max_tokens }) }` was held for b's `max_tokens`. (Review of 402c1e4, 2026-10-07.)
 */
export function consumerRequestKeys(call: CallExpression, name: string, decl?: Node): string[][] {
  const out: string[][] = [];
  for (const arg of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const carries = arg.getProperties().some((prop) => {
      if (Node.isShorthandPropertyAssignment(prop)) {
        return (
          prop.getName() === name &&
          isModelLikeName(name) &&
          (!decl || consumerReadsDeclaration(prop.getNameNode(), decl, name))
        );
      }
      if (!Node.isPropertyAssignment(prop) || !isModelLikeName(prop.getName())) return false;
      const init = prop.getInitializer();
      if (!init) return false;
      return leavesOf(init).some((leaf) => {
        const value = unwrapValueWrappers(leaf);
        return traceableName(value) === name && (!decl || consumerReadsDeclaration(value, decl, name));
      });
    });
    if (carries) out.push(requestParamKeys(arg));
  }
  return out;
}

// --- which binding a consumer's model reads ----------------------------------------
//
// Syntactic, like declarationsOf: `getSymbol()` would force a full semantic program (see there).
// The question is narrow — can the `model` a consumer passes be shown to be some OTHER binding
// than the declaration — so the rules below only ever DROP a consumer on a positive answer:
//   - it resolves to a different variable, parameter or destructured binding that is not fed the
//     declaration (by its initializer or default, by destructuring, or, for a parameter of a named
//     function or class, by an argument at one of its calls in this file, or by a call it is
//     handed to beside the value). Feeding is followed through other bindings: `const m = MODEL;
//     ask(m)` feeds ask's parameter, and so does `new Bot(MODEL)` a field the constructor assigns
//     from its own parameter;
//   - it reads `this.<name>` while the declaration is a plain variable, and no member of that
//     class is initialised or assigned from the declaration;
//   - it is a plain name while the declaration writes a property of another object
//     (`config.model = '…'`), and the binding that name resolves to is not fed a `.model` read.
// Anything unresolved, and every kind of declaration not listed here, keeps the consumer: the
// conservative direction (hold) is the one name matching already took.

/**
 * What reading a declaration looks like: a variable binding, `this.<name>`, a property of an object
 * other than `this` (`config.model = '…'`, read back only through a `.model` read), or not known.
 */
type DeclarationTarget =
  | { kind: 'variable'; binding: Node }
  | { kind: 'member' }
  | { kind: 'property' }
  | { kind: 'unknown' };

function declarationTarget(decl: Node): DeclarationTarget {
  if (Node.isVariableDeclaration(decl)) return { kind: 'variable', binding: decl };
  if (Node.isPropertyDeclaration(decl) || isThisAssignment(decl)) return { kind: 'member' };
  if (Node.isBinaryExpression(decl)) {
    // `model = '…'`: the binding it writes is the variable its consumers read.
    const left = decl.getLeft();
    const binding = Node.isIdentifier(left) ? lexicalBindingOf(left, left.getText()) : undefined;
    if (binding) return { kind: 'variable', binding };
    // `config.model = '…'`: only a `.model` read can give the value back. (Review of 947967d,
    // 2026-10-10: it was 'unknown', so a function's own `model` parameter, which can never read
    // config.model, held the declaration with its own `max_tokens`.)
    if (Node.isPropertyAccessExpression(left)) return { kind: 'property' };
  }
  return { kind: 'unknown' };
}

/**
 * Does the `model` a consumer passes — `value` is the identifier, the shorthand's name, or the
 * `this.<name>` read the sink map filed under `name` — read `decl`, or can that not be ruled out?
 */
export function consumerReadsDeclaration(value: Node, decl: Node, name: string): boolean {
  const target = declarationTarget(decl);
  if (target.kind === 'unknown') return true;
  const seen = new Set<Node>();
  if (Node.isPropertyAccessExpression(value)) {
    // `this.<name>`: the member itself, or a member a plain variable feeds. For `config.model = …`,
    // `this` may be that object, so it counts.
    return target.kind !== 'variable' || memberFedBy(value, target, name, seen);
  }
  const binding = lexicalBindingOf(value, name);
  if (!binding) return true;
  if (target.kind === 'variable' && binding === target.binding) return true;
  return bindingFedBy(binding, target, name, seen);
}

/** Is `n` a read of `this.<name>`? */
function isThisRead(n: Node, name: string): boolean {
  return Node.isPropertyAccessExpression(n) && Node.isThisExpression(n.getExpression()) && n.getName() === name;
}

/**
 * Does `expr` hand on the declaration's value: one of its leaves, through wrappers and fallbacks,
 * reads it, or names another binding that is fed it (`const m = MODEL; ask(m)`)? `seen` holds the
 * bindings already asked about in this query, so a recursive function ends the walk.
 */
function readsDeclaration(expr: Node, target: DeclarationTarget, name: string, seen: Set<Node>): boolean {
  return leavesOf(expr).some((leaf) => {
    const l = unwrapValueWrappers(leaf);
    if (Node.isPropertyAccessExpression(l)) {
      if (target.kind === 'member') return isThisRead(l, name);
      // `x.model` on any object: it may be the object `config.model = …` wrote.
      return target.kind === 'property' && l.getName() === name;
    }
    if (!Node.isIdentifier(l)) return false;
    const b = lexicalBindingOf(l, l.getText());
    // A name nothing in the file binds is a global, and may be the declaration (never `this.<name>`).
    if (b === undefined) return target.kind !== 'member' && l.getText() === name;
    if (target.kind === 'variable' && b === target.binding) return true;
    return bindingFedBy(b, target, name, seen);
  });
}

/**
 * Is a binding other than the declaration fed the declaration's value? By its initializer or
 * default (`const m = MODEL`, `chat(model = this.model)`), by destructuring (`const { model } =
 * this`), or, for a parameter, by an argument at a call of its function.
 */
function bindingFedBy(binding: Node, target: DeclarationTarget, name: string, seen: Set<Node>): boolean {
  if (seen.has(binding)) return false;
  seen.add(binding);
  if (Node.isVariableDeclaration(binding) || Node.isParameterDeclaration(binding) || Node.isBindingElement(binding)) {
    const init = binding.getInitializer();
    if (init && readsDeclaration(init, target, name, seen)) return true;
  }
  if (Node.isParameterDeclaration(binding)) return parameterFedBy(binding, target, name, seen);
  if (Node.isBindingElement(binding)) return destructuredFrom(binding, target, name);
  return false;
}

/**
 * `const { model } = this` (or `{ model: m }`) reads the member `model`. For `config.model = …`,
 * destructuring `model` out of any object, a parameter's pattern included, may read it back.
 */
function destructuredFrom(el: Node, target: DeclarationTarget, name: string): boolean {
  if (!Node.isBindingElement(el)) return false;
  const key = el.getPropertyNameNode()?.getText() ?? el.getName();
  if (key !== name) return false;
  if (target.kind === 'property') return true;
  if (target.kind !== 'member') return false;
  const pattern = el.getParent();
  const owner = pattern?.getParent();
  if (!owner || !Node.isVariableDeclaration(owner)) return false;
  const init = owner.getInitializer();
  return !!init && Node.isThisExpression(unwrapValueWrappers(init));
}

/** The name a function is called by in this file, if it has one: its own, its variable's, its method's, its class's. */
function calleeNameOf(fn: Node): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName();
  if (Node.isConstructorDeclaration(fn)) {
    const cls = fn.getParent();
    if (Node.isClassDeclaration(cls)) return cls.getName();
    // `const Bot = class { constructor(…) }`, or a named class expression.
    return Node.isClassExpression(cls) ? (cls.getName() ?? holderName(cls)) : undefined;
  }
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) return holderName(fn);
  return undefined;
}

/** The name a value is bound to where it is written: `const ask = …`, `{ ask: … }`, a class field `ask = …`. */
function holderName(value: Node): string | undefined {
  let holder = value.getParent();
  while (holder && isValueWrapper(holder)) holder = holder.getParent();
  if (
    holder &&
    (Node.isVariableDeclaration(holder) || Node.isPropertyAssignment(holder) || Node.isPropertyDeclaration(holder))
  ) {
    const n = holder.getNameNode();
    return Node.isIdentifier(n) ? n.getText() : undefined;
  }
  return undefined;
}

/** Is `arg` the function itself, handed on by name (`ask`, `this.ask`), not called? */
function isFunctionReference(arg: Node, callee: string): boolean {
  const a = unwrapValueWrappers(arg);
  if (Node.isIdentifier(a)) return a.getText() === callee;
  return Node.isPropertyAccessExpression(a) && Node.isThisExpression(a.getExpression()) && a.getName() === callee;
}

/**
 * A parameter of a named function is fed the declaration when a call of that function in this
 * file passes it at the parameter's position: `function ask(model: string) { … }` then
 * `ask(model)`, `ask(m)` with `const m = model`, or `new Bot(model)` for a constructor. A spread
 * before that position hides which argument lands there, so it counts. So does handing the
 * function to another call beside the value, `withRetry(ask, model)`: which argument that call
 * passes on is not visible here. A destructured parameter, or a function with no name to call it
 * by, is not traced. (Review of 947967d, 2026-10-10: the alias, the hand-off and a class
 * expression's constructor were all read as unfed, and their declaration swapped with
 * `max_tokens` kept.)
 */
function parameterFedBy(param: Node, target: DeclarationTarget, name: string, seen: Set<Node>): boolean {
  if (!Node.isParameterDeclaration(param) || !Node.isIdentifier(param.getNameNode())) return false;
  const fn = param.getParent();
  if (!fn || !(Node.isFunctionLikeDeclaration(fn) || Node.isFunctionExpression(fn))) return false;
  const callee = calleeNameOf(fn);
  if (!callee) return false;
  const index = fn.getParameters().indexOf(param);
  for (const call of callsAndNewsOf(param.getSourceFile())) {
    const callee2 = call.getExpression();
    const called = Node.isIdentifier(callee2)
      ? callee2.getText()
      : Node.isPropertyAccessExpression(callee2)
        ? callee2.getName()
        : undefined;
    const args = call.getArguments();
    if (called !== callee) {
      const handedOn = args.some((a) => isFunctionReference(a, callee));
      if (handedOn && args.some((a) => !isFunctionReference(a, callee) && readsDeclaration(a, target, name, seen))) {
        return true;
      }
      continue;
    }
    if (args.slice(0, index + 1).some((a) => Node.isSpreadElement(a))) return true;
    const arg = args[index];
    if (arg && readsDeclaration(arg, target, name, seen)) return true;
  }
  return false;
}

/**
 * Every call and `new` in a file, built once per parse of the file (keyed like IDENTIFIER_INDEX).
 * {@link parameterFedBy} runs for each consumer whose model is a parameter, and walking the whole
 * file each time would make a file with many such consumers quadratic.
 */
const CALL_INDEX = new WeakMap<SourceFile, { compiler: unknown; calls: Array<CallExpression | NewExpression> }>();

function callsAndNewsOf(sf: SourceFile): Array<CallExpression | NewExpression> {
  let entry = CALL_INDEX.get(sf);
  if (!entry || entry.compiler !== sf.compilerNode) {
    entry = {
      compiler: sf.compilerNode,
      calls: [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.NewExpression)],
    };
    CALL_INDEX.set(sf, entry);
  }
  return entry.calls;
}

/**
 * A plain variable reaches `this.<name>` only through the class: a property initialised from it
 * (`model = MODEL`), an assignment `this.model = MODEL`, or a parameter property fed it. The
 * assignment may go through the constructor's own parameter, `constructor(model: string) {
 * this.model = model }` fed by `new Bot(MODEL)`, as the parameter property is. `this` outside a
 * class cannot be resolved, so it counts.
 */
function memberFedBy(read: Node, target: DeclarationTarget, name: string, seen: Set<Node>): boolean {
  const cls = enclosingClass(read);
  if (!cls || !(Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) return true;
  for (const member of cls.getMembers()) {
    if (Node.isPropertyDeclaration(member) && member.getName() === name) {
      const init = member.getInitializer();
      if (init && readsDeclaration(init, target, name, seen)) return true;
    }
    if (Node.isConstructorDeclaration(member)) {
      for (const p of member.getParameters()) {
        if (p.isParameterProperty() && p.getName() === name && bindingFedBy(p, target, name, seen)) return true;
      }
    }
  }
  for (const assign of cls.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (
      isThisAssignment(assign) &&
      isThisRead(assign.getLeft(), name) &&
      readsDeclaration(assign.getRight(), target, name, seen)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The binding `name` resolves to where `from` sits, found syntactically by walking out through
 * the scopes: a function's parameters, a block's (or the file's, or a `switch`'s) declarations, a
 * `for` or `catch` binding, then the file's imports. The innermost wins, as in the language.
 * Returns the VariableDeclaration, ParameterDeclaration or BindingElement (or a function, class
 * or import) that binds it, or undefined when nothing in the file does.
 */
export function lexicalBindingOf(from: Node, name: string): Node | undefined {
  for (let scope = from.getParent(); scope; scope = scope.getParent()) {
    const found = bindingIn(scope, name);
    if (found) return found;
  }
  return undefined;
}

function bindingIn(scope: Node, name: string): Node | undefined {
  if (Node.isFunctionLikeDeclaration(scope) || Node.isFunctionExpression(scope)) {
    for (const p of scope.getParameters()) {
      const hit = boundBy(p, name);
      if (hit) return hit;
    }
    return undefined;
  }
  if (Node.isCatchClause(scope)) {
    const v = scope.getVariableDeclaration();
    return v ? boundBy(v, name) : undefined;
  }
  if (Node.isForStatement(scope) || Node.isForOfStatement(scope) || Node.isForInStatement(scope)) {
    const init = scope.getInitializer();
    if (init && Node.isVariableDeclarationList(init)) {
      for (const d of init.getDeclarations()) {
        const hit = boundBy(d, name);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  const statements: Node[] = Node.isCaseBlock(scope)
    ? scope.getClauses().flatMap((c) => c.getStatements())
    : Node.isBlock(scope) || Node.isSourceFile(scope) || Node.isModuleBlock(scope)
      ? scope.getStatements()
      : [];
  for (const st of statements) {
    if (Node.isVariableStatement(st)) {
      for (const d of st.getDeclarations()) {
        const hit = boundBy(d, name);
        if (hit) return hit;
      }
    } else if ((Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) && st.getName() === name) {
      return st;
    } else if (Node.isImportDeclaration(st)) {
      if (st.getDefaultImport()?.getText() === name) return st;
      if (st.getNamespaceImport()?.getText() === name) return st;
      for (const spec of st.getNamedImports()) {
        if ((spec.getAliasNode()?.getText() ?? spec.getName()) === name) return spec;
      }
    }
  }
  return undefined;
}

/** The declaration, parameter or destructured element under `owner` that binds `name`. */
function boundBy(owner: Node, name: string): Node | undefined {
  if (!(Node.isVariableDeclaration(owner) || Node.isParameterDeclaration(owner))) return undefined;
  const n = owner.getNameNode();
  if (Node.isIdentifier(n)) return n.getText() === name ? owner : undefined;
  for (const el of n.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const en = el.getNameNode();
    if (Node.isIdentifier(en) && en.getText() === name) return el;
  }
  return undefined;
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

/** `this.model = …` — an assignment to instance state, scoped to the class like a property. */
export function isThisAssignment(node: Node): boolean {
  if (!Node.isBinaryExpression(node) || node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return false;
  const left = node.getLeft();
  return Node.isPropertyAccessExpression(left) && Node.isThisExpression(left.getExpression());
}

/** Does a sink call see the declaration? Module-level: everywhere. Local: same function. Class property: same class. */
function sinkInScope(decl: Node, call: CallExpression): boolean {
  if (Node.isPropertyDeclaration(decl) || isThisAssignment(decl)) {
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

/** The calls that consume `name` and can see `decl`: the consumers the declaration is judged by. */
export function inScopeSinks(decl: Node, name: string, sinks: TsSinkMap | undefined): CallExpression[] {
  return (sinks?.get(name) ?? []).filter((c) => sinkInScope(decl, c));
}

/**
 * Rule (b), the sink rule: a model-named declaration is swap-eligible only when
 * every in-scope consumer is a resolved first-party request inside a function.
 * No consumer → `usage_unverified` (review). Any capped consumer → the cap wins.
 */
export function judgeDeclarationSinks(decl: Node, name: string, sinks: TsSinkMap | undefined): SurfaceClassification {
  const calls = inScopeSinks(decl, name, sinks);
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

/**
 * The `new X({ … })` that this object literal is an argument of, if any.
 *
 * {@link enclosingCallOfObject} matches `Node.isCallExpression` only, and a `new` is a
 * NewExpression, so `new OpenAiChat({ model: "gpt-3.5-turbo" })` had no enclosing call at all
 * and fell through to plain data — silenced at `monitor`, not even review.
 *
 * Measured 2026-09-28: first-party wrapper CLASSES were the second-largest cause of the 37%
 * recall, after the examples/ rule. promptfoo's `new OpenAiCompletionProvider(...)` and
 * chroma's sample route handlers are this shape.
 *
 * Deliberately separate from `enclosingCallOfObject` rather than widening its return type:
 * that value flows into `classifyCallSurface`, which resolves a receiver to a first-party SDK
 * client. A constructor has no such receiver to resolve, so feeding it there would ask that
 * machinery a question it was not built to answer. The caller consults this ONLY when there is
 * no enclosing call, so no existing verdict can change.
 */
export function enclosingNewOfObject(obj: Node): Node | undefined {
  const top = climbTransparent(obj);
  const parent = top.getParent();
  if (parent && Node.isNewExpression(parent) && parent.getArguments().includes(top as Expression)) return parent;
  return undefined;
}

/** Where a request object built in a variable goes. See {@link requestObjectFlow}. */
export interface RequestObjectFlow {
  /** The provider requests (an endpoint {@link endpointFamily} recognises) the object is passed to. */
  calls: CallExpression[];
  /**
   * True when the object literal is the WHOLE request: a non-exported `const`, initialised with
   * the literal itself, whose every use is a direct argument of one of `calls`. Only then does the
   * literal show everything the request carries, which the swap and its parameter checks rely on.
   */
  exclusive: boolean;
}

/**
 * Every identifier in a file, by name, built once per parse of the file. {@link requestObjectFlow}
 * runs for each matched literal in a standalone object, and walking the whole file each time was
 * quadratic: 800 module-level model objects in one 4,800-line file took 327 s. Keyed on the
 * compiler node, which ts-morph replaces whenever the file is edited, so an index is never read
 * across an edit (its wrappers would be forgotten nodes by then). The param pass reads it too, to
 * find the writes to a `let` (paramFix.ts, neverReassigned).
 */
const IDENTIFIER_INDEX = new WeakMap<SourceFile, { compiler: unknown; byName: Map<string, Identifier[]> }>();

export function identifiersNamed(sf: SourceFile, name: string): Identifier[] {
  let entry = IDENTIFIER_INDEX.get(sf);
  if (!entry || entry.compiler !== sf.compilerNode) {
    const byName = new Map<string, Identifier[]>();
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const text = id.getText();
      const list = byName.get(text);
      if (list) list.push(id);
      else byName.set(text, [id]);
    }
    entry = { compiler: sf.compilerNode, byName };
    IDENTIFIER_INDEX.set(sf, entry);
  }
  return entry.byName.get(name) ?? [];
}

/** The nearest node that opens a block scope for a `let` / `const` / class / function declared in it. */
function blockScopeOf(node: Node): Node {
  for (let n = node.getParent(); n; n = n.getParent()) {
    if (
      Node.isBlock(n) ||
      Node.isSourceFile(n) ||
      Node.isModuleBlock(n) ||
      Node.isCaseBlock(n) ||
      Node.isCatchClause(n) ||
      Node.isForStatement(n) ||
      Node.isForOfStatement(n) ||
      Node.isForInStatement(n)
    ) {
      return n;
    }
  }
  return node.getSourceFile();
}

/** The scope a variable declaration binds its name in: the function for `var`, the block otherwise. */
function variableScopeOf(decl: Node): Node {
  const list = decl.getParent();
  const isVar = Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Var;
  return isVar ? (enclosingFunction(decl) ?? decl.getSourceFile()) : blockScopeOf(decl);
}

/**
 * When `id` is the name a BINDING introduces (a variable, parameter, function, class, import,
 * destructured name), the node whose extent that binding covers; otherwise undefined. Positional
 * and per-name, so it costs nothing per reference: an earlier version resolved every reference by
 * walking every statement of its enclosing scopes, and that took 373 s on a 4,800-line file.
 */
function bindingScopeOfName(id: Node): Node | undefined {
  const parent = id.getParent();
  if (!parent) return undefined;
  const named = (p: Node): boolean => (p as Node & { getNameNode?(): Node | undefined }).getNameNode?.() === id;
  if (Node.isVariableDeclaration(parent) && named(parent)) return variableScopeOf(parent);
  if (Node.isParameterDeclaration(parent) && named(parent)) return parent.getParent();
  if (Node.isBindingElement(parent) && named(parent)) {
    for (let n: Node | undefined = parent.getParent(); n; n = n.getParent()) {
      if (Node.isVariableDeclaration(n)) return variableScopeOf(n);
      if (Node.isParameterDeclaration(n)) return n.getParent();
    }
    return undefined;
  }
  if ((Node.isFunctionExpression(parent) || Node.isClassExpression(parent)) && named(parent)) return parent;
  if ((Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) || Node.isEnumDeclaration(parent)) && named(parent)) {
    return blockScopeOf(parent);
  }
  if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent) || Node.isImportEqualsDeclaration(parent)) {
    return id.getSourceFile();
  }
  return undefined;
}

const within = (node: Node, scope: Node): boolean => node.getPos() >= scope.getPos() && node.getEnd() <= scope.getEnd();

/** Is `id` the NAME a declaration introduces, or a property name, rather than a read of a binding? */
function isNameNotReference(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === id;
  if (
    Node.isVariableDeclaration(parent) ||
    Node.isParameterDeclaration(parent) ||
    Node.isFunctionDeclaration(parent) ||
    Node.isClassDeclaration(parent) ||
    Node.isBindingElement(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isPropertyDeclaration(parent) ||
    Node.isPropertySignature(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isImportSpecifier(parent)
  ) {
    return (parent as Node & { getNameNode(): Node | undefined }).getNameNode() === id;
  }
  return false;
}

/**
 * `const arr = { messages, model: 'gpt-3.5-turbo' }` … `chatGPT.chat.completions.create(arr)`.
 *
 * {@link enclosingCallOfObject} only sees an object written INSIDE the call's parentheses, so a
 * request built in a variable first and passed by name had no call at all and was filed as a
 * catalog value: Tier C, "no action", and `fix-llm` reported nothing to do. Measured on
 * miroslavpejic85/mirotalksfu (2026-10-09), whose Video AI handler sends gpt-3.5-turbo this way.
 *
 * Deliberately narrow, because a model id in a standalone object is catalog data far more often
 * than it is a request: the object has to be the initializer of a variable whose value, by name,
 * reaches a call whose callee is a provider ENDPOINT (`.chat.completions.create`,
 * `.messages.create`, `generateContent`…) — directly, through a fallback, or spread into an
 * object that is that call's argument. Passing it to any other call (`console.log(arr)`,
 * `res.json(arr)`, `save(arr)`) is not evidence of a request and finds nothing here, so those
 * objects stay where they were. Undefined when no provider request is reached.
 *
 * Syntactic, like the rest of this file, and positional: a reference counts only when it lies in
 * this binding's scope and outside every nested scope where another binding of the same name
 * shadows it, so a shadowing binding is neither evidence of a flow nor mistaken for one.
 */
export function requestObjectFlow(obj: Node): RequestObjectFlow | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  // The object must BE the variable's value. Parentheses and type wrappers keep it whole; a
  // fallback (`opts ?? { … }`) or a ternary branch makes it one of two possible values.
  let top: Node = obj;
  let wholeValue = true;
  for (let p = top.getParent(); p; p = top.getParent()) {
    if (
      Node.isParenthesizedExpression(p) ||
      Node.isAsExpression(p) ||
      Node.isSatisfiesExpression(p) ||
      Node.isNonNullExpression(p)
    ) {
      top = p;
      continue;
    }
    const op = Node.isBinaryExpression(p) ? p.getOperatorToken().getKind() : undefined;
    if (
      (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) ||
      (Node.isConditionalExpression(p) && (p.getWhenTrue() === top || p.getWhenFalse() === top))
    ) {
      top = p;
      wholeValue = false;
      continue;
    }
    break;
  }
  const decl = top.getParent();
  if (!decl || !Node.isVariableDeclaration(decl) || decl.getInitializer() !== top) return undefined;
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return undefined;
  const name = nameNode.getText();

  const list = decl.getParent();
  const isConst =
    Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const;
  const statement = list?.getParent();
  const exported = !!statement && Node.isVariableStatement(statement) && statement.isExported();

  const calls: CallExpression[] = [];
  let exclusive = isConst && !exported && wholeValue;
  // Which same-named identifiers are reads of THIS binding: those inside its scope and outside
  // every nested scope where another binding of the name shadows it. A second binding in the very
  // same scope (`var x` twice) is ambiguity: still evidence of a flow, never a clean single use.
  const scope = variableScopeOf(decl);
  const named = identifiersNamed(decl.getSourceFile(), name).filter((id) => id !== nameNode && within(id, scope));
  const shadows: Node[] = [];
  for (const id of named) {
    const bound = bindingScopeOfName(id);
    if (!bound) continue;
    if (bound === scope) exclusive = false;
    else shadows.push(bound);
  }
  for (const id of named) {
    if (isNameNotReference(id) || bindingScopeOfName(id) || shadows.some((s) => within(id, s))) continue;
    // Climb the wrappers that pass the value through unchanged, then look at what receives it.
    let use: Node = id;
    let direct = true;
    for (let p = use.getParent(); p; p = use.getParent()) {
      if (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isSatisfiesExpression(p) || Node.isNonNullExpression(p)) {
        use = p;
        continue;
      }
      const uop = Node.isBinaryExpression(p) ? p.getOperatorToken().getKind() : undefined;
      if (
        (uop === SyntaxKind.BarBarToken || uop === SyntaxKind.QuestionQuestionToken) ||
        (Node.isConditionalExpression(p) && (p.getWhenTrue() === use || p.getWhenFalse() === use))
      ) {
        use = p;
        direct = false;
        continue;
      }
      break;
    }
    const receiver = use.getParent();
    let call: CallExpression | undefined;
    if (receiver && Node.isCallExpression(receiver) && receiver.getArguments().includes(use as Expression)) {
      call = receiver;
    } else if (receiver && Node.isSpreadAssignment(receiver)) {
      // `create({ ...arr, stream: true })`: the request is the object around the spread, whose
      // other keys the literal does not show.
      const outer = receiver.getParent();
      call = outer ? enclosingCallOfObject(outer) : undefined;
      direct = false;
    }
    if (call && endpointFamily(call) !== null) {
      calls.push(call);
      if (!direct) exclusive = false;
    } else {
      // Read by something that is not a provider request, written to, aliased, returned…
      exclusive = false;
    }
  }
  return calls.length > 0 ? { calls, exclusive } : undefined;
}

/** Does an object literal carry catalog-shaped siblings (label, pricing, description…)? */
export function hasCatalogSiblings(obj: Node): boolean {
  if (!Node.isObjectLiteralExpression(obj)) return false;
  return obj.getProperties().some((p) => {
    const name = Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : '';
    return CATALOG_SIBLING_KEYS.test(name.replace(/^['"]|['"]$/g, ''));
  });
}

/**
 * Is this object literal (through nested objects/arrays) the value of a
 * declaration whose NAME says "default configuration" — `DEFAULT_MEMORY_CONFIG`,
 * `defaultLlm`, `settings`? Then a `model:` inside it is the default a caller
 * inherits, not a catalog card.
 */
export function isInDefaultContainer(obj: Node): boolean {
  let n: Node | undefined = obj;
  while (n) {
    if (Node.isVariableDeclaration(n) || Node.isPropertyDeclaration(n)) return isDefaultContainerName(n.getName());
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const left = n.getLeft();
      const name = Node.isIdentifier(left) ? left.getText() : Node.isPropertyAccessExpression(left) ? left.getName() : '';
      return isDefaultContainerName(name);
    }
    if (
      Node.isObjectLiteralExpression(n) ||
      Node.isPropertyAssignment(n) ||
      Node.isArrayLiteralExpression(n) ||
      Node.isAsExpression(n) ||
      Node.isParenthesizedExpression(n) ||
      Node.isSatisfiesExpression(n)
    ) {
      n = n.getParent();
      continue;
    }
    return false;
  }
  return false;
}

/** Is this call a command-line option/argument declaration (commander, yargs, oclif)? */
export function isCliOptionCall(call: CallExpression): boolean {
  const name = lastIdentifier(call);
  return !!name && /^(option|requiredOption|addOption|argument|positional|flag)$/.test(name);
}

/**
 * `program.option('-m, --model <model>', 'Model ID', 'dall-e-3')`: the default of a CLI flag.
 *
 * The flag's NAME used to have to match /model/i. That gate is gone, because it is exactly
 * how the same defect hid in the Python scanner: `--gpt_version` names a model and contains
 * no "model", so a 4,954-star repository whose documented Quick Start runs a retiring id
 * audited as NO EXPOSURE IN COMPLETED SURFACES (going-doer/Paper2Code, 2026-09-16).
 *
 * The value is the signal instead, and it is a stronger one: this is only reached for a
 * literal already matched against the registry, so the question is not "is this a model id"
 * but "is this id the one the program runs with when the flag is omitted" — and for a CLI
 * default it is, whatever the flag is called. It caps at review, never swap-eligible, since
 * the path from parsed argv to a provider request is not traced.
 */
export function isCliModelOptionDefault(call: CallExpression, arg: Node): boolean {
  if (!isCliOptionCall(call)) return false;
  const args = call.getArguments();
  // The first argument is the flag spec itself; a default is always a later one.
  return args.length >= 2 && args[0] !== arg;
}

/** Re-exported for callers that only need the constructor check. */
export function isNewExpressionNode(n: Node): n is NewExpression {
  return Node.isNewExpression(n);
}
