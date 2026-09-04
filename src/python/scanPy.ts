import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node as PyNode, type Tree } from 'web-tree-sitter';
import type { LlmModelIdDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { effectiveVerificationState, isVerified, modelIdEntries } from '../usage/llmRegistry.js';
import { isExamplePath, splitProviderPrefix } from '../usage/sharedRules.js';
import {
  detectPySurface,
  dottedCallee,
  enclosingCall,
  inCollectionDisplay,
  isCatalogConstructor,
  isCatalogKwarg,
  isLegacySdkSink,
  isPlaceholderValue,
  isProviderModelFactory,
  isRequestModelKwarg,
  matchSdkSink,
  pyContextOf,
  receiverOf,
  resolveReceiverSurface,
  sinkFamily,
  SURFACE_MAX_TIER,
  TIER_A_ELIGIBLE_ENDPOINTS,
  type PySurface,
} from './sinks.js';
import {
  catalogIdsInText,
  fileAnnotation,
  isAzureDeploymentName,
  isModelLikeName,
  AZURE_DEPLOYMENT_REASON,
  USAGE_UNVERIFIED_REASON,
  type AnnotationScan,
  type AzureDeploymentLocate,
  type BlockedModelLocate,
  type CatalogFileReport,
  type DataPurpose,
  type LiteralPosition,
  type ModelIdDataLocate,
  type UsageUnverifiedLocate,
} from '../usage/scanLiterals.js';

// LLM mode — locate (PYTHON).
//
// The Python analogue of src/usage/scanLiterals.ts, sharing its exact
// philosophy: value-driven exact matching, call-site classification, and
// accuracy over recall at every decision point. Where the TS scanner walks a
// ts-morph AST, this one walks a tree-sitter CST (web-tree-sitter +
// tree-sitter-python compiled to WASM — no native build, no Python runtime).
//
// Precision (mirroring the TS scanner):
//   - EXACT value equality only, never substring. "gemini-1.5-pro-notes" has a
//     different value, so it does NOT match.
//   - Only PLAIN string literals are matched: an unprefixed `'...'` / `"..."`
//     (or triple-quoted) whose raw content is compared byte-for-byte to a
//     registry id. Comments are trivia in the CST, never string nodes.
//   - f-strings are NEVER matched (their value is not a fixed compile-time
//     string — the TS scanner's interpolated-template rule). Prefixed strings
//     (r"", b"", u"", rb"") are also excluded: b"" is bytes, not str, and the
//     others are rare enough for model ids that skipping them is the cheaper
//     side of the accuracy-over-recall trade. Escaped spellings
//     (`"gpt-4"`) compare unequal raw and are invisible — deliberately.
//   - A piece of an implicit concatenation (`"gpt-4" "-turbo"`) is a FRAGMENT
//     of a larger value, never a whole model id — excluded outright.
//
// KNOWN LIMITATION (same as TS): only literal model ids written inline are
// seen. An id read from os.environ, a constant referenced by name, or built by
// % / .format() / f-string interpolation is invisible. We never guess through
// a value we cannot see verbatim.
//
// CALL-SITE AWARENESS: an exact value match proves the STRING is a retired
// model id, not that it is USED as a live model argument. The same literal is
// routinely DATA in Python too: a pricing-dict key, a model-choices list, a
// `== "gpt-4"` comparison. Every match is classified by its CST position
// (see `classifyPyLiteralPosition`); only genuine model-argument positions are
// `model_arg` (swap-eligible), everything else is `data` (Tier C locate-only).

/** A Python source file handed to the scanner: absolute-ish path + full text. */
export interface PySource {
  path: string;
  text: string;
}

/**
 * A plain-string literal whose value matches a registry `model_id` deprecation.
 * Unlike the TS `LiteralMatch` this holds NO live AST node — trees are freed
 * per file after scanning — so the fixer works purely on text offsets.
 */
export interface PyLiteralMatch {
  /** Path of the containing file (as given to the scanner). */
  file: string;
  /** The literal's exact content (between the quotes), e.g. `"gemini-1.5-pro"`. */
  value: string;
  /** Offset of the first content byte (just past the opening quote). */
  contentStart: number;
  /** Offset just past the last content byte (at the closing quote). */
  contentEnd: number;
  /** Where the literal sits in source, anchored at the opening quote (1-based). */
  location: SourceLocation;
  /** The registry entry this literal matched. */
  deprecation: LlmModelIdDeprecation;
  /** CST-classified position: `model_arg` is swap-eligible, `data` is locate-only. */
  position: LiteralPosition;
  /** For `data` positions: WHY it is data (purpose-aware Tier C language). */
  purpose?: DataPurpose;
  /** A per-match override of the generic review advice, when a guard fired. */
  reason?: string;
}

// --- Parser bootstrap -------------------------------------------------------
//
// The grammar ships as `wasm/tree-sitter-python.wasm` at the repo root (copied
// verbatim from the `tree-sitter-python` npm package, which is a devDependency
// only — consumers never trigger its node-gyp install). Like the registry JSON,
// `tsc` does not copy data assets into `dist/`, so the file is resolved by
// walking UP from this module's own directory — robust to running from either
// `src/` (tsx) or `dist/` (built), and to the package being installed under a
// consumer's node_modules.

const PY_WASM_RELATIVE = join('wasm', 'tree-sitter-python.wasm');

/** Walk up from this module's directory to find the Python grammar WASM. */
export function resolvePythonWasmPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, PY_WASM_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(
    `could not locate ${PY_WASM_RELATIVE} by walking up from ${dirname(fileURLToPath(import.meta.url))}`,
  );
}

// One WASM runtime + one loaded grammar + one parser per process. Parser.init()
// loads web-tree-sitter's own .wasm from inside its package; Language.load
// reads ours. Both are cheap enough to do lazily on first use.
let pythonParser: Parser | undefined;

/** Lazily initialize and return the shared Python parser. */
export async function getPythonParser(): Promise<Parser> {
  if (!pythonParser) {
    await Parser.init();
    const language = await Language.load(resolvePythonWasmPath());
    pythonParser = new Parser();
    pythonParser.setLanguage(language);
  }
  return pythonParser;
}

/**
 * Parse Python source text. `parse` returns null only when no language is set
 * or parsing was cancelled — neither applies here, so a null is a hard error
 * rather than a silently-empty scan.
 */
export async function parsePython(text: string): Promise<Tree> {
  const parser = await getPythonParser();
  const tree = parser.parse(text);
  if (!tree) throw new Error('tree-sitter returned no tree for Python source');
  return tree;
}

/**
 * Count ERROR + MISSING nodes in a tree — the honesty metric for the Python
 * syntax gate (fixPy.ts): a patched file must not parse WORSE than its
 * baseline. Counted (not boolean) so a file that already had syntax errors
 * before the patch is judged relative to itself, mirroring the TS type gate's
 * baseline-relative discipline.
 */
export function countSyntaxErrors(tree: Tree): number {
  const walk = (node: PyNode): number => {
    let count = node.isError || node.isMissing ? 1 : 0;
    for (const child of node.children) count += walk(child);
    return count;
  };
  return walk(tree.rootNode);
}

// --- File discovery ---------------------------------------------------------

/**
 * Directory names never descended into. Virtualenvs and caches are the Python
 * equivalents of node_modules: vendored third-party code we must not scan
 * (their model ids are not the target repo's problem to fix).
 */
const PY_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
]);

/**
 * Test-support files whose model ids are fixtures/mocks, not live app calls —
 * the Python spelling of the TS `isTestPath` rule (same rationale: rewriting a
 * project's test model ids is noise at best, breaks their suite at worst).
 */
export function isPyTestPath(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return (
    /(^|\/)test_[^/]*\.py$/.test(f) ||
    /_test\.py$/.test(f) ||
    /(^|\/)conftest\.py$/.test(f) ||
    /(^|\/)tests?\//.test(f)
  );
}

/**
 * Every `.py` file under `repoPath`, excluding virtualenv/cache dirs. Test
 * files ARE included here — this list backs the "Scanned N source files" count
 * (mirroring the TS count, which also includes test files); the literal scan
 * skips them separately via `isPyTestPath`.
 */
/** How many of the collected files the literal scan will SKIP as test support (disclosed in coverage). */
export function countPyTestFiles(files: readonly string[]): number {
  return files.filter((f) => isPyTestPath(f)).length;
}

export function collectPythonFiles(repoPath: string): string[] {
  const abs = resolve(repoPath);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it rather than fail the whole scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!PY_EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

/** Read a list of .py paths into scanner inputs, skipping unreadable files. */
export function readPythonSources(files: string[]): PySource[] {
  const sources: PySource[] = [];
  for (const path of files) {
    try {
      sources.push({ path, text: readFileSync(path, 'utf8') });
    } catch {
      // Unreadable file: skip rather than abort. It was still COUNTED as
      // scanned-eligible by collectPythonFiles, which slightly overstates
      // coverage — acceptable for a permissions edge case.
    }
  }
  return sources;
}

// --- Call-site classification -----------------------------------------------
//
// Mirrors classifyLiteralPosition in scanLiterals.ts rule for rule. A literal
// is only swap-eligible when it is provably in a model-argument slot; anything
// else is left byte-identical and surfaced Tier C.

/**
 * Callee last-identifier names whose direct string argument IS the model
 * (e.g. `genai.GenerativeModel("gemini-1.5-pro")`). Deliberately small and
 * curated — recall traded for precision, as everywhere else. Note the absence
 * of `create`: `client.messages.create(...)` passes its model as the `model=`
 * keyword, which rule (a) catches; its positional args are never a model.
 */
const PY_MODEL_FACTORIES: ReadonlySet<string> = new Set([
  'GenerativeModel', // google-generativeai: genai.GenerativeModel("...")
  'ChatOpenAI', // langchain-openai: ChatOpenAI("...") (model is 1st positional)
  'ChatAnthropic', // langchain-anthropic
  'ChatGoogleGenerativeAI', // langchain-google-genai
  'init_chat_model', // langchain: init_chat_model("provider:model")
]);

/**
 * Is `parent` a value-transparent wrapper around `child`? Lets a literal inside
 * an `or` fallback, a parenthesis, or a conditional-expression branch still be
 * seen as the value of its enclosing keyword/pair/assignment — the Python
 * spelling of the TS `||`/paren/ternary rule (`and` is NOT transparent, just
 * as `&&` is not).
 */
function isValueTransparent(parent: PyNode, child: PyNode): boolean {
  if (parent.type === 'parenthesized_expression') return true;
  if (parent.type === 'boolean_operator') {
    return parent.childForFieldName('operator')?.type === 'or';
  }
  if (parent.type === 'conditional_expression') {
    // `a if cond else b` — transparent for the VALUE branches (a, b) only; the
    // condition is control flow, not a value position.
    const named = parent.namedChildren;
    const first = named[0];
    const last = named[named.length - 1];
    return (first !== undefined && child.equals(first)) || (last !== undefined && child.equals(last));
  }
  return false;
}

/**
 * Extract a PLAIN string literal's raw content, or undefined when the node is
 * not a plain string: any prefix (f/r/b/u) or an interpolation child rejects
 * it, and a piece of an implicit concatenation is rejected as a fragment.
 * Raw content is compared verbatim, so escape spellings never match — exactly
 * the "never guess through a value we cannot see" posture.
 */
function plainStringContent(node: PyNode): { value: string; start: number; end: number } | undefined {
  if (node.type !== 'string') return undefined;
  if (node.parent?.type === 'concatenated_string') return undefined; // fragment
  const children = node.children;
  const start = children[0];
  const end = children[children.length - 1];
  if (!start || start.type !== 'string_start') return undefined;
  if (!end || end.type !== 'string_end') return undefined;
  // Unprefixed quotes only: ' " ''' """ — an f/r/b/u prefix lands in the
  // string_start token text and fails this check.
  if (!/^('|"|'''|""")$/.test(start.text)) return undefined;
  // Any interpolation child means an f-string slipped through — reject.
  if (children.some((c) => c.type === 'interpolation')) return undefined;
  const value = node.text.slice(start.endIndex - node.startIndex, end.startIndex - node.startIndex);
  return { value, start: start.endIndex, end: end.startIndex };
}

/** Is a dict KEY node a plain string whose content is a model-like name? */
function isModelLikeStringKey(key: PyNode): boolean {
  const content = plainStringContent(key);
  return content !== undefined && isModelLikeName(content.value);
}

/** The last identifier of a call's callee: `ChatOpenAI`, or for `genai.GenerativeModel(...)`, `GenerativeModel`. */
function calleeLastIdentifier(call: PyNode): string | undefined {
  const callee = call.childForFieldName('function');
  if (!callee) return undefined;
  if (callee.type === 'identifier') return callee.text;
  if (callee.type === 'attribute') return callee.childForFieldName('attribute')?.text;
  return undefined;
}

/**
 * Is the dictionary that directly contains `pair` passed as an ARGUMENT to a
 * call — either positionally (`post(url, {"model": "…"})`) or as a keyword
 * value (`post(url, json={"model": "…"})`)? Only then is a model-keyed pair a
 * live model argument we trust enough to swap. A model id in a STANDALONE dict
 * (a catalog entry, a module-level config) is left as data — the same
 * catalog-corruption guard as the TS `isEnclosingObjectACallArgument`.
 */
function isEnclosingDictACallArgument(pair: PyNode): boolean {
  const dict = pair.parent;
  if (!dict || dict.type !== 'dictionary') return false;
  let node: PyNode = dict;
  let parent = node.parent;
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.parent;
  }
  if (!parent) return false;
  if (parent.type === 'argument_list' && parent.parent?.type === 'call') return true;
  return (
    parent.type === 'keyword_argument' &&
    parent.childForFieldName('value')?.equals(node) === true &&
    parent.parent?.type === 'argument_list'
  );
}

// --- Same-file sink trace -----------------------------------------------------
//
// THE SINK RULE (the simulator.py regression): a bare assignment like
// `model = "gpt-4"` proves the VALUE is a retired id, NOT that the variable is
// ever USED as a model. In the real failure the assignment lived inside an
// event-payload generator — pure data wearing a model-like name — and the
// name-only rule wrongly promoted it to Tier A. So a model-like assignment (or
// parameter default) is swap-eligible ONLY when its name is also passed to a
// recognized SINK somewhere in the SAME file: a model-like keyword argument
// (`client.chat.completions.create(model=model)`), a model-factory positional
// argument (`genai.GenerativeModel(model)`), or the value of a model-like dict
// key in a dict passed to a call. No in-file sink -> `usage_unverified`: a
// candidate reported for manual review, never auto-applied, never in --write.
//
// The trace is deliberately SIMPLE — same file, name equality, no scoping and
// no textual ordering — because Python's late-binding lookup makes "later in
// the file" unreliable (a function defined ABOVE an assignment still reads it
// at call time), and a name that reaches a sink anywhere in the file is the
// evidence we need.

/** The traceable name of a value node: `model` for both `model` and `self.model`. */
function traceableName(node: PyNode): string | undefined {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'attribute') return node.childForFieldName('attribute')?.text;
  return undefined;
}

/**
 * Every identifier/attribute name in `tree` that reaches a model SINK: a
 * model-like keyword argument in any call, a direct argument to a known model
 * factory, or the value of a model-like string key in a dict that is itself a
 * call argument — the exact positions where a LITERAL would classify as
 * `model_arg`, applied to names instead.
 */
/**
 * Where a traced name actually FLOWS. The plain name set is not enough: a guard
 * that only inspects the literal's own enclosing call is bypassed by one hop
 * through a variable —
 *
 *     MODEL = "gpt-4"                       # no enclosing call here…
 *     client.embeddings.create(model=MODEL) # …so the endpoint cap never ran
 *
 * and Azure, embeddings, legacy-SDK and unknown-wrapper call sites all reached
 * Tier A that way. Recording the SINK NODE per name lets the caps apply at the
 * place the value is actually used.
 */
export interface PySinkTarget {
  /** The call the traced name flows into. */
  call: PyNode;
  /** The keyword it arrives under, when it is a keyword argument. */
  kwName?: string;
}

/** Every traced name mapped to the call(s) it reaches. */
export function collectPySinkTargets(tree: Tree): Map<string, PySinkTarget[]> {
  const out = new Map<string, PySinkTarget[]>();
  const add = (name: string, call: PyNode | null, kwName?: string): void => {
    if (!call) return;
    const list = out.get(name) ?? [];
    list.push({ call, kwName });
    out.set(name, list);
  };
  for (const kw of tree.rootNode.descendantsOfType('keyword_argument')) {
    if (!kw) continue;
    const name = kw.childForFieldName('name');
    const value = kw.childForFieldName('value');
    if (!name || !value || !isModelLikeName(name.text)) continue;
    const traced = traceableName(value);
    if (traced) add(traced, enclosingCall(value), name.text);
  }
  for (const call of tree.rootNode.descendantsOfType('call')) {
    if (!call) continue;
    const factory = calleeLastIdentifier(call);
    if (!factory || !PY_MODEL_FACTORIES.has(factory)) continue;
    const args = call.childForFieldName('arguments');
    if (!args) continue;
    for (const arg of args.namedChildren) {
      if (!arg) continue;
      const traced = traceableName(arg);
      if (traced) add(traced, call);
    }
  }
  for (const pair of tree.rootNode.descendantsOfType('pair')) {
    if (!pair) continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value || !isModelLikeStringKey(key)) continue;
    if (!isEnclosingDictACallArgument(pair)) continue;
    const traced = traceableName(value);
    if (traced) add(traced, enclosingCall(value));
  }
  return out;
}

export function collectPySinkNames(tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const kw of tree.rootNode.descendantsOfType('keyword_argument')) {
    if (!kw) continue;
    const name = kw.childForFieldName('name');
    const value = kw.childForFieldName('value');
    if (!name || !value || !isModelLikeName(name.text)) continue;
    const traced = traceableName(value);
    if (traced) names.add(traced);
  }
  for (const call of tree.rootNode.descendantsOfType('call')) {
    if (!call) continue;
    const factory = calleeLastIdentifier(call);
    if (!factory || !PY_MODEL_FACTORIES.has(factory)) continue;
    const args = call.childForFieldName('arguments');
    if (!args) continue;
    for (const arg of args.namedChildren) {
      if (!arg) continue;
      const traced = traceableName(arg);
      if (traced) names.add(traced);
    }
  }
  for (const pair of tree.rootNode.descendantsOfType('pair')) {
    if (!pair) continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value || !isModelLikeStringKey(key)) continue;
    if (!isEnclosingDictACallArgument(pair)) continue;
    const traced = traceableName(value);
    if (traced) names.add(traced);
  }
  return names;
}

/** Per-file evidence the guards need: the provider surface of this file. */
export interface PyGuardContext {
  surface: PySurface;
  value?: string;
  /** Where each traced name flows — lets the caps follow a variable hop. */
  sinkTargets?: Map<string, PySinkTarget[]>;
}

export const PY_SURFACE_REASON = 'provider surface is not a verified direct provider — a direct replacement is not valid here';
export const PY_ENDPOINT_REASON = 'the successor is not endpoint-compatibility verified for this endpoint';
export const PY_LEGACY_SDK_REASON = 'legacy provider SDK — the migration differs from the modern client';
export const PY_MODULE_REQUEST_REASON = 'a provider request executed at module import — real, but not an unattended swap';
export const PY_UNRECOGNIZED_SINK_REASON =
  'the call target is not a recognized provider SDK request — real, but not an unattended swap';
export const PY_UNRESOLVED_RECEIVER_REASON =
  'the client object this call is made on could not be resolved to a first-party provider client in this file';
export const PY_FAMILY_MISMATCH_REASON =
  'the resolved client belongs to a different provider family than this endpoint';
export const PY_CATALOG_REASON = 'catalog / stored-metadata construction, not a provider request';
export const PY_FIELD_DEFAULT_REASON =
  'default value of a model-named field or parameter; a real selector whose use is not traced, review before changing';
export const PY_RETURN_DEFAULT_REASON =
  'returned as the fallback from a model-named function; a real selector whose consumer is not traced, review before changing';
export const PY_WRAPPER_FACTORY_REASON =
  'framework wrapper factory (LangChain), not a direct provider SDK request; the swap is not verified for this surface';
export const PY_EXAMPLE_REASON =
  'example / sample / demo / docs tree: informational, not a dependency of the shipped product';
export const PY_PREFIXED_REASON =
  'provider-prefixed selector (gateway / provider registry); the successor may need a different prefix, capped at review';

/** Wrapper factories: real selection points that are NOT the provider SDK. */
const LANGCHAIN_FACTORIES: ReadonlySet<string> = new Set([
  'ChatOpenAI',
  'ChatAnthropic',
  'ChatGoogleGenerativeAI',
  'init_chat_model',
]);

/**
 * C5 (external validation): factory literals bypassed every surface guard —
 * `ChatOpenAI(model="gpt-4", base_url="http://localhost:11434/v1")` reached Tier A.
 * A LangChain factory is a wrapper, capped at review outright; a first-party
 * factory (`genai.GenerativeModel`) still needs a direct surface and no proxy
 * override. Returns the cap, or null when the factory may keep its position.
 */
function capFactory(
  call: PyNode,
  dotted: string | null,
  ctx?: PyGuardContext,
): { position: LiteralPosition; reason: string } | null {
  const last = (dotted ?? '').split('.').pop() ?? '';
  if (LANGCHAIN_FACTORIES.has(last)) return { position: 'surface_capped', reason: PY_WRAPPER_FACTORY_REASON };
  const args = call.childForFieldName('arguments')?.text ?? '';
  if (/\b(base_url|api_base|endpoint|endpoint_url|client_options|transport|http_client)\s*=/.test(args)) {
    return { position: 'surface_capped', reason: `${PY_SURFACE_REASON} (proxy)` };
  }
  const surface = ctx?.surface ?? 'unknown_wrapper';
  if (SURFACE_MAX_TIER[surface] !== 'A') {
    return { position: 'surface_capped', reason: `${PY_SURFACE_REASON} (${surface})` };
  }
  return null;
}

/**
 * M2: is this `default=` / `value=` keyword the default of a model-named
 * assignment target — `model_name: str = Field(default="…")`,
 * `model = Column(default="…")`? Then the literal is a real selector.
 */
function modelNamedAssignmentTarget(kwarg: PyNode): boolean {
  const call = kwarg.parent?.parent; // keyword_argument → argument_list → call
  if (!call || call.type !== 'call') return false;
  const assign = call.parent;
  if (!assign || assign.type !== 'assignment') return false;
  const left = assign.childForFieldName('left');
  const name = left ? traceableName(left) : undefined;
  return !!name && isModelLikeName(name);
}

/**
 * G1–G5. Returns a classification when a guard DECIDES the outcome, else null so
 * the positional rules below still apply.
 *
 * Ordering matters: a placeholder is suppressed; catalog construction is data
 * whatever the keyword looks like; a module-level SDK request is REAL (Python
 * executes module bodies at import) but capped at review rather than dropped; and
 * only a qualified sink, on a verified direct surface, at a Tier-A-eligible
 * endpoint, may stay swap-eligible.
 */
export function applyPyGuards(
  literal: PyNode,
  ctx?: PyGuardContext,
): { position: LiteralPosition; purpose?: DataPurpose; reason?: string } | null {
  // G3 — an obvious placeholder is never a real model id.
  const raw = ctx?.value ?? plainStringContent(literal)?.value;
  if (raw && isPlaceholderValue(raw)) {
    return { position: 'data', purpose: 'generic', reason: 'placeholder value' };
  }

  const call = enclosingCall(literal);
  const dotted = call ? dottedCallee(call) : null;
  const sink = matchSdkSink(dotted);

  // G3 — a catalog/metadata keyword never proves model selection, whatever call
  // it sits in. `base_model_name="gpt-4"` is a stored-credential lookup key:
  // rewriting it breaks every workspace whose credentials name that base model.
  const kwName = literal.parent?.type === 'keyword_argument'
    ? literal.parent.childForFieldName('name')?.text
    : undefined;
  if (kwName && isCatalogKwarg(kwName)) {
    return { position: 'data', purpose: 'catalog_entry', reason: PY_CATALOG_REASON };
  }

  // G1/G2 — a constructor building stored metadata is DATA, never a sink.
  if (call && isCatalogConstructor(dotted)) {
    return { position: 'data', purpose: 'catalog_entry', reason: PY_CATALOG_REASON };
  }

  // G1 — executability AND context. Module level is not "unreachable": a
  // recognized SDK request there fires at import, so it is capped at B. What
  // earns C is module-level DATA construction.
  const context = pyContextOf(literal);
  if (context === 'module_sdk_request') {
    return { position: 'surface_capped', reason: PY_MODULE_REQUEST_REASON };
  }
  // Module-level / class-level DATA CONSTRUCTION is Tier C — but only when the
  // literal is genuinely inside a call or a collection display. A bare
  // `MODEL_NAME = "gpt-4"` constant is NOT data: a function below may feed it to
  // a real SDK call, which is exactly what the existing sink rule decides.
  if ((context === 'module_data' || context === 'class_body') && (call !== null || inCollectionDisplay(literal))) {
    return { position: 'data', purpose: 'catalog_entry', reason: PY_CATALOG_REASON };
  }

  // G5 — legacy SDK generation caps at review.
  if (isLegacySdkSink(dotted)) return { position: 'surface_capped', reason: PY_LEGACY_SDK_REASON };

  // G2 — a call that is NOT a recognized sink is an unknown function or wrapper.
  // We only reach here when the positional rules already said `model_arg`, so
  // ANY such position must be capped: a raw `requests.post(json={"model": ...})`
  // to a gateway, or a model-like kwarg on an unrecognized callee, is real but
  // never swap-eligible. Recognized provider model factories are the exception.
  if (call && !sink && !isProviderModelFactory(dotted)) {
    if (kwName && isModelLikeName(kwName)) {
      return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
    }
    return { position: 'surface_capped', reason: PY_UNRECOGNIZED_SINK_REASON };
  }
  // C5: a factory is a real selection point but earns Tier A only on a direct
  // surface with no proxy override; a LangChain wrapper never does.
  if (call && !sink && isProviderModelFactory(dotted)) {
    const cap = capFactory(call, dotted, ctx);
    if (cap) return cap;
  }

  if (sink) {
    // G3 — the keyword must be a request-model argument for THIS endpoint.
    if (kwName && !isRequestModelKwarg(kwName, sink.endpoint)) {
      return { position: 'data', purpose: 'catalog_entry', reason: PY_CATALOG_REASON };
    }
    // G4 — the surface caps the tier. Only a verified direct provider reaches A.
    const surface = ctx?.surface ?? 'unknown_wrapper';
    if (SURFACE_MAX_TIER[surface] !== 'A') {
      return { position: 'surface_capped', reason: `${PY_SURFACE_REASON} (${surface})` };
    }
    // G4 (receiver-bound). A file-wide text signal cannot say WHICH object the
    // call is made on. Without this, one unused import — or the word "openai" in
    // a DOCSTRING — conferred Tier A on a call whose client is a function
    // parameter, and `fix-llm --write` then rewrote injected production code.
    // The receiver must resolve to a single first-party constructor IN THIS FILE,
    // and its provider family must MATCH the sink's (anthropic evidence must
    // never authorize an OpenAI chat.completions swap).
    const receiver = call ? receiverOf(dotted ?? '', sink.suffix) : null;
    const bound = receiver ? resolveReceiverSurface(literal, receiver) : null;
    const wanted = sinkFamily(sink.suffix);
    if (!bound) {
      return { position: 'surface_capped', reason: PY_UNRESOLVED_RECEIVER_REASON };
    }
    if (wanted && bound.family !== wanted) {
      return {
        position: 'surface_capped',
        reason: `${PY_FAMILY_MISMATCH_REASON} (client is ${bound.family}, endpoint is ${wanted})`,
      };
    }
    // G5 — endpoint family must be one whose successor mapping we can verify.
    if (!TIER_A_ELIGIBLE_ENDPOINTS.has(sink.endpoint)) {
      return { position: 'surface_capped', reason: `${PY_ENDPOINT_REASON} (${sink.endpoint})` };
    }
  }

  // THE VARIABLE-HOP PATH. When the literal has no enclosing call it reached
  // `model_arg` through the sink TRACE (an assignment or a parameter default).
  // The caps must then be applied where the value is USED, not where it is
  // written — otherwise `MODEL = "gpt-4"` next to an Azure/embeddings/legacy call
  // bypasses G2, G4 and G5 entirely. Every reachable sink must qualify; the
  // strictest verdict wins, and an unresolvable one caps.
  if (!call) {
    const traced = tracedNameOf(literal);
    // SCOPE-AWARE. Sink names are collected file-globally, so an unrelated local
    // `model = "gpt-4"` matched a sink fed by a same-named parameter in ANOTHER
    // function — and fix-llm rewrote that unrelated assignment. A local binding
    // is only trusted against a sink in the same function.
    const reachable = traced ? ctx?.sinkTargets?.get(traced) ?? [] : [];
    // `traceableName` returns the ATTRIBUTE name for `self.model`, so detect the
    // self-attribute case from the AST instead of the traced string.
    const left = literal.parent?.type === 'assignment' ? literal.parent.childForFieldName('left') : null;
    const isSelfAttr = left?.type === 'attribute';
    const targets = reachable.filter((t) => sinkIsInScope(literal, t.call, isSelfAttr));
    if (targets.length === 0) {
      return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
    }
    for (const t of targets) {
      const verdict = judgeSinkCall(literal, t.call, t.kwName, ctx);
      if (verdict) return verdict;
    }
  }

  return null;
}

/**
 * Apply G2/G4/G5 to ONE call the value reaches. Returns a capping classification
 * when that call fails a gate, else null (this call is fine).
 */
function judgeSinkCall(
  literal: PyNode,
  call: PyNode,
  kwName: string | undefined,
  ctx?: PyGuardContext,
): { position: LiteralPosition; purpose?: DataPurpose; reason?: string } | null {
  const dotted = dottedCallee(call);
  if (isLegacySdkSink(dotted)) return { position: 'surface_capped', reason: PY_LEGACY_SDK_REASON };
  const sink = matchSdkSink(dotted);
  if (!sink) {
    if (isProviderModelFactory(dotted)) {
      // A factory is a real selection point, but still surface-capped (C5).
      return capFactory(call, dotted, ctx);
    }
    return { position: 'surface_capped', reason: PY_UNRECOGNIZED_SINK_REASON };
  }
  if (kwName && !isRequestModelKwarg(kwName, sink.endpoint)) {
    return { position: 'data', purpose: 'catalog_entry', reason: PY_CATALOG_REASON };
  }
  const surface = ctx?.surface ?? 'unknown_wrapper';
  if (SURFACE_MAX_TIER[surface] !== 'A') {
    return { position: 'surface_capped', reason: `${PY_SURFACE_REASON} (${surface})` };
  }
  const receiver = receiverOf(dotted ?? '', sink.suffix);
  const bound = receiver ? resolveReceiverSurface(literal, receiver) : null;
  if (!bound) return { position: 'surface_capped', reason: PY_UNRESOLVED_RECEIVER_REASON };
  const wanted = sinkFamily(sink.suffix);
  if (wanted && bound.family !== wanted) {
    return { position: 'surface_capped', reason: `${PY_FAMILY_MISMATCH_REASON} (client is ${bound.family}, endpoint is ${wanted})` };
  }
  if (!TIER_A_ELIGIBLE_ENDPOINTS.has(sink.endpoint)) {
    return { position: 'surface_capped', reason: `${PY_ENDPOINT_REASON} (${sink.endpoint})` };
  }
  return null;
}

/** The nearest enclosing function node, or null at module level. */
function enclosingFunction(node: PyNode): PyNode | null {
  let n: PyNode | null = node;
  while (n) {
    if (n.type === 'function_definition' || n.type === 'lambda') return n;
    n = n.parent;
  }
  return null;
}

/**
 * Do these two nodes share a scope for the purpose of trusting a sink trace?
 *
 * A module-level constant may legitimately feed a sink inside any function. But a
 * LOCAL binding must only be trusted against a sink in the SAME function — a
 * `model = "gpt-4"` inside an unrelated metadata helper must not inherit
 * authority from a same-named parameter that reaches a real sink elsewhere.
 */
function sinkIsInScope(literal: PyNode, sinkCall: PyNode, isSelfAttr: boolean): boolean {
  // A self-attribute is INSTANCE state — set in one method, used in another — so
  // its scope is the enclosing CLASS, not the enclosing function.
  if (isSelfAttr) {
    const declClass = enclosingClass(literal);
    if (!declClass) return true;
    const useClass = enclosingClass(sinkCall);
    return useClass !== null && useClass.equals(declClass);
  }
  const declScope = enclosingFunction(literal);
  if (!declScope) return true; // module-level constant: visible everywhere
  const useScope = enclosingFunction(sinkCall);
  return useScope !== null && useScope.equals(declScope);
}

/** The nearest enclosing class, or null. */
function enclosingClass(node: PyNode): PyNode | null {
  let n: PyNode | null = node;
  while (n) {
    if (n.type === 'class_definition') return n;
    n = n.parent;
  }
  return null;
}

/** The traced name this literal is bound to, if it is an assignment/param default. */
function tracedNameOf(literal: PyNode): string | null {
  const p = literal.parent;
  if (!p) return null;
  if (p.type === 'assignment') {
    const left = p.childForFieldName('left');
    return left ? traceableName(left) ?? null : null;
  }
  if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
    const n = p.childForFieldName('name');
    return n ? n.text : null;
  }
  return null;
}

/**
 * Classify a matched model-id literal by its CST position.
 *
 * ACCEPT (`model_arg`, swap-eligible) when the literal is any of:
 *   (a) a model-like KEYWORD argument in any call (`create(model="…")`,
 *       `AzureOpenAI(deployment_name="…")`), including inside an `or` fallback;
 *   (b) the VALUE of a model-like string key in a dict PASSED TO A CALL
 *       (`post(url, json={"model": "…"})`) — a standalone/catalog dict is data;
 *   (c) an assignment to a model-like name (`MODEL_NAME = "…"`,
 *       `self.model = "…"`, `model: str = "…"`), or the DEFAULT of a
 *       model-like function parameter (`def ask(prompt, model="…")`) — BUT
 *       only when the name is traced to an in-file SINK per `sinkNames` (see
 *       the sink rule above); a bare assignment with no sink usage DEMOTES to
 *       `usage_unverified` instead of being trusted on its name alone;
 *   (d) a direct string argument to a known model-factory call
 *       (`genai.GenerativeModel("…")`, `ChatOpenAI("…")`).
 *
 * REJECT (`data`, locate-only) otherwise — a dict KEY (`lookup_key`), a
 * list/tuple/set element (`list_entry`), a comparison operand (`m == "…"`,
 * `m in ("…",)` — `comparison`), a standalone dict value (`catalog_entry`), or
 * any position not matching an ACCEPT rule (`generic`). The purpose rides
 * along so the CLI's Tier C language can say WHY, mirroring the TS scanner.
 *
 * `sinkNames` is the file's {@link collectPySinkNames} result. Omitting it
 * means "no sinks known", so rule (c) can only ever demote — the safe default.
 */
export function classifyPyLiteral(
  literal: PyNode,
  sinkNames?: ReadonlySet<string>,
  ctx?: PyGuardContext,
): { position: LiteralPosition; purpose?: DataPurpose; reason?: string } {
  const base = classifyPyPosition(literal, sinkNames);
  // Guards only DEMOTE. A data position keeps its precise purpose; only a
  // swap-eligible `model_arg` is re-examined against G1-G5.
  if (base.position !== 'model_arg') return base;
  return applyPyGuards(literal, ctx) ?? base;
}

/** The positional (CST-shape) classification, before any guard. */
export function classifyPyPosition(
  literal: PyNode,
  sinkNames?: ReadonlySet<string>,
): {
  position: LiteralPosition;
  purpose?: DataPurpose;
  reason?: string;
} {
  // GUARDS G1-G5 run AFTER the positional rules, in classifyPyLiteral's wrapper
  // below. They may only ever DEMOTE a `model_arg`, never invent one and never
  // overwrite a more precise data purpose (lookup_key / list_entry / comparison).

  // Climb through value-transparent wrappers so a literal inside a fallback /
  // parenthesis / conditional branch is judged by its real enclosing position.
  let node: PyNode = literal;
  let parent = node.parent;
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.parent;
  }
  if (!parent) return { position: 'data', purpose: 'generic' };

  // (a) model-like keyword argument, in ANY call. Unlike a dict pair there is
  // no call-flow question to settle — a keyword argument IS a call argument.
  // Azure deployment keywords (`deployment_name=` etc.) route to their own
  // locate surface: the value is a deployment alias, not a model id.
  if (parent.type === 'keyword_argument') {
    const name = parent.childForFieldName('name');
    const value = parent.childForFieldName('value');
    if (name && value?.equals(node)) {
      if (isAzureDeploymentName(name.text)) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeName(name.text)) return { position: 'model_arg' };
      // M2 (external validation): `model_name: str = Field(default="gpt-3.5-turbo")`
      // is the runtime default of every ChatOpenAI() built without a model — it was
      // filed as Tier C "no selector" while a parser label next to it was Tier A.
      if (/^(default|value)$/.test(name.text) && modelNamedAssignmentTarget(parent)) {
        return { position: 'usage_unverified', reason: PY_FIELD_DEFAULT_REASON };
      }
    }
    return { position: 'data', purpose: 'generic' };
  }

  // M2: `return cfg.MODEL if cfg.MODEL else 'dall-e-2'` inside `get_image_model()` —
  // the fallback returned from a model-named function is the selector every
  // caller receives. Not data; a review candidate.
  if (parent.type === 'return_statement') {
    const fn = enclosingFunction(node);
    const fname = fn?.childForFieldName('name')?.text;
    if (fname && isModelLikeName(fname)) {
      return { position: 'usage_unverified', reason: PY_RETURN_DEFAULT_REASON };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (b) value side of a model-like string key — ONLY when the enclosing dict is
  // actually passed to a call. A KEY position, or a standalone/catalog dict
  // value, is never swapped (duplicate-key / catalog-corruption risk).
  if (parent.type === 'pair') {
    const key = parent.childForFieldName('key');
    const value = parent.childForFieldName('value');
    if (key?.equals(node)) {
      return { position: 'data', purpose: 'lookup_key' };
    }
    if (key && value?.equals(node)) {
      const keyContent = plainStringContent(key);
      if (keyContent && isAzureDeploymentName(keyContent.value)) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeStringKey(key) && isEnclosingDictACallArgument(parent)) {
        return { position: 'model_arg' };
      }
      return { position: 'data', purpose: 'catalog_entry' };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (c) assignment to a model-like name: `MODEL = "…"` / `self.model = "…"`.
  // Covers annotated assignments too (`model: str = "…"` is the same node).
  // THE SINK RULE: the name alone is not proof of use — swap-eligible only
  // when the same name reaches an in-file sink; otherwise usage_unverified.
  if (parent.type === 'assignment') {
    const left = parent.childForFieldName('left');
    const right = parent.childForFieldName('right');
    if (left && right?.equals(node)) {
      const name = traceableName(left);
      if (name && isAzureDeploymentName(name)) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (name && isModelLikeName(name)) {
        if (sinkNames?.has(name)) return { position: 'model_arg' };
        return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
      }
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (c) parameter-default form: `def ask(prompt, model="…")` — with or without
  // a type annotation (typed_default_parameter). The same sink rule applies:
  // the default is only trusted when the parameter's name reaches a sink.
  if (parent.type === 'default_parameter' || parent.type === 'typed_default_parameter') {
    const name = parent.childForFieldName('name');
    const value = parent.childForFieldName('value');
    if (name && value?.equals(node)) {
      if (isAzureDeploymentName(name.text)) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeName(name.text)) {
        if (sinkNames?.has(name.text)) return { position: 'model_arg' };
        return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
      }
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (d) direct positional argument to a known model factory.
  if (parent.type === 'argument_list' && parent.parent?.type === 'call') {
    const factory = calleeLastIdentifier(parent.parent);
    if (factory && PY_MODEL_FACTORIES.has(factory)) return { position: 'model_arg' };
    return { position: 'data', purpose: 'generic' };
  }

  // Comparison operand: `m == "gpt-4"` may gate runtime logic. A literal inside
  // the tuple/list of an `in` membership test (`m in ("gpt-4",)`) is the same
  // runtime-gating story, so the collection is looked through when its parent
  // is the comparison itself.
  if (parent.type === 'comparison_operator') {
    return { position: 'data', purpose: 'comparison' };
  }
  if (parent.type === 'list' || parent.type === 'tuple' || parent.type === 'set') {
    if (parent.parent?.type === 'comparison_operator') {
      return { position: 'data', purpose: 'comparison' };
    }
    return { position: 'data', purpose: 'list_entry' };
  }

  return { position: 'data', purpose: 'generic' };
}

/** Position-only view of {@link classifyPyLiteral} (kept for call-site brevity). */
export function classifyPyLiteralPosition(
  literal: PyNode,
  sinkNames?: ReadonlySet<string>,
): LiteralPosition {
  return classifyPyLiteral(literal, sinkNames).position;
}

// --- Scan --------------------------------------------------------------------

/**
 * Find every plain string literal in `sources` whose content EXACTLY equals a
 * registry `model_id` deprecated token. Test-support files are skipped, and
 * matches are returned as plain snapshots (offsets + classification), so the
 * per-file trees can be freed immediately. Callers pass pre-read sources, which
 * keeps this function hermetic for tests (mirroring the in-memory ts-morph
 * projects the TS suite builds).
 */
export async function findPyModelIdLiterals(
  sources: PySource[],
  registry: LlmRegistry,
): Promise<PyLiteralMatch[]> {
  // Index model-id deprecations by exact `deprecated` value for O(1) lookup —
  // a MULTIMAP, not first-wins, exactly as the TS scan (see findModelIdLiterals
  // for the full rationale): the registry may carry two records for one id, and
  // dropping the second silently loses its retirement deadline downstream (the
  // `mendr watch` exposure most of all). One match is emitted per matching
  // record; the fixer collapses them back to one splice per literal.
  const byValue = new Map<string, LlmModelIdDeprecation[]>();
  for (const dep of modelIdEntries(registry)) {
    const list = byValue.get(dep.deprecated);
    if (list) list.push(dep);
    else byValue.set(dep.deprecated, [dep]);
  }
  if (byValue.size === 0) return [];

  const out: PyLiteralMatch[] = [];

  for (const source of sources) {
    if (isPyTestPath(source.path)) continue;
    // Annotated files never yield matches: a `model-catalog` file's ids are
    // expected registry content (own one-line surface), an `ignore-file` is
    // skipped outright. Both are surfaced via scanPyAnnotations instead.
    if (fileAnnotation(source.text) !== undefined) continue;

    const tree = await parsePython(source.text);
    try {
      // The sink rule's evidence set, computed once per file (see above).
      const sinkNames = collectPySinkNames(tree);
      const sinkTargets = collectPySinkTargets(tree);
      // G4: the provider surface, resolved once per file, caps every tier below.
      const surface = detectPySurface(source.path, source.text);
      // An examples/samples/demos/docs tree is informational by rule (C3).
      const example = isExamplePath(source.path);
      for (const node of tree.rootNode.descendantsOfType('string')) {
        const content = plainStringContent(node);
        if (!content) continue; // f-string / prefixed / concatenation fragment
        let deprecations = byValue.get(content.value);
        let prefixed = false;
        if (!deprecations) {
          // `openai/gpt-5-nano` / `openai:gpt-5-mini`: a gateway or registry
          // selector carrying a registry id — real, never swap-eligible.
          const split = splitProviderPrefix(content.value);
          deprecations = split ? byValue.get(split.id) : undefined;
          if (!deprecations) continue; // exact-value guard: no substring matching
          prefixed = true;
        }

        // Position/purpose belong to the CST node, not the registry entry, so
        // classify once and emit one match per matching record (multimap).
        let classification: { position: LiteralPosition; purpose?: DataPurpose; reason?: string } = example
          ? { position: 'data', purpose: 'example', reason: PY_EXAMPLE_REASON }
          : classifyPyLiteral(node, sinkNames, { surface, sinkTargets });
        // A prefixed id is a gateway SELECTOR only where a plain id would have
        // been one; in a list or a catalog dict it is data like any other.
        if (prefixed && !example && classification.position !== 'data') {
          classification = { position: 'surface_capped', reason: PY_PREFIXED_REASON };
        }
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;
        for (const deprecation of deprecations) {
          out.push({
            file: source.path,
            value: content.value,
            contentStart: content.start,
            contentEnd: content.end,
            location: { file: source.path, line, column },
            deprecation,
            position: classification.position,
            purpose: classification.purpose,
            reason: classification.reason,
          });
        }
      }
    } finally {
      tree.delete(); // free WASM-side memory per file; matches are plain data
    }
  }

  return out;
}

/**
 * Project a Python scan down to its DATA-position matches for Tier C
 * locate-only reporting — the same plain shape the TS pipeline reports, so the
 * CLI prints both languages through one code path.
 */
export function toPyModelIdDataMatches(matches: PyLiteralMatch[]): ModelIdDataLocate[] {
  return matches
    .filter((m) => m.position === 'data')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
      purpose: m.purpose,
      reason: m.reason,
    }));
}

/**
 * Project a Python scan down to its AZURE-DEPLOYMENT matches — the same
 * never-swapped locate surface as the TS `toAzureDeploymentMatches`.
 */
export function toPyAzureDeploymentMatches(matches: PyLiteralMatch[]): AzureDeploymentLocate[] {
  return matches
    .filter((m) => m.position === 'azure_deployment')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
    }));
}

/**
 * Project a Python scan down to its USAGE-UNVERIFIED candidates: model-like
 * assignments the sink rule could not tie to any in-file sink. Reported for
 * manual review only — never auto-applied, never included in --write.
 */
export function toPyUsageUnverifiedMatches(matches: PyLiteralMatch[]): UsageUnverifiedLocate[] {
  return matches
    .filter((m) => m.position === 'usage_unverified' || m.position === 'surface_capped')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
      reason: m.reason ?? USAGE_UNVERIFIED_REASON,
    }));
}

/**
 * Collect the annotated Python files (same scope rules as the literal scan:
 * test-support files skipped), so the CLI can report catalogs as expected
 * content and ignored files as a count — mirroring scanProjectAnnotations.
 */
export function scanPyAnnotations(sources: PySource[], registry: LlmRegistry): AnnotationScan {
  const catalogs: CatalogFileReport[] = [];
  const ignoredFiles: string[] = [];
  for (const source of sources) {
    if (isPyTestPath(source.path)) continue;
    const annotation = fileAnnotation(source.text);
    if (annotation === 'ignore-file') {
      ignoredFiles.push(source.path);
    } else if (annotation === 'model-catalog') {
      catalogs.push({ file: source.path, ids: catalogIdsInText(source.text, registry) });
    }
  }
  return { catalogs, ignoredFiles };
}

/**
 * Project a Python scan down to its BLOCKED matches: deprecated ids in LIVE
 * model-argument positions whose entry is NOT `verified` — the engine gate
 * refuses these in Python exactly as in TS.
 */
export function toPyBlockedModelArgMatches(matches: PyLiteralMatch[]): BlockedModelLocate[] {
  return matches
    .filter((m) => m.position === 'model_arg' && !isVerified(m.deprecation))
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      status: effectiveVerificationState(m.deprecation),
      location: m.location,
      note: m.deprecation.note,
      reasons: m.deprecation.verification?.reasons,
    }));
}

/** Repo-relative display path with forward slashes (diff headers, messages). */
export function displayPath(rootDir: string | undefined, file: string): string {
  return (rootDir ? relative(rootDir, file) : file).replace(/\\/g, '/');
}
