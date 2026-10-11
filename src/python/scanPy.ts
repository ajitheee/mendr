import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node as PyNode, type Tree } from 'web-tree-sitter';
import type { LlmModelIdDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { effectiveVerificationState, isVerified, modelIdEntries } from '../usage/llmRegistry.js';
import { fineTuneHoldReason, resolveSourceFineTune } from '../usage/fineTune.js';
import { paramHoldReason } from '../usage/coupledParams.js';
import {
  CATALOG_SIBLING_KEYS,
  isDefaultContainerName,
  isExamplePath,
  LOOKUP_WITH_DEFAULT,
  splitProviderPrefix,
} from '../usage/sharedRules.js';
import {
  explainPySurface,
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
  /**
   * The base model when the literal is a fine-tuned model id (`ft:<base>:<org>:<suffix>:<id>`),
   * matched through the registry's row for fine-tunes of that base. Never swapped.
   */
  fineTuneOf?: string;
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
  /**
   * The expression the call takes as its model (`MODEL`, `model`, `self.model`, `self.judge.model`).
   * Targets are keyed by the last name only, so a reader that must know the call takes THIS value
   * compares it with the binding (see samePyReference).
   */
  value: PyNode;
}

/** Every traced name mapped to the call(s) it reaches. */
export function collectPySinkTargets(tree: Tree): Map<string, PySinkTarget[]> {
  const out = new Map<string, PySinkTarget[]>();
  const add = (name: string, value: PyNode, call: PyNode | null, kwName?: string): void => {
    if (!call) return;
    const list = out.get(name) ?? [];
    list.push({ call, kwName, value });
    out.set(name, list);
  };
  for (const kw of tree.rootNode.descendantsOfType('keyword_argument')) {
    if (!kw) continue;
    const name = kw.childForFieldName('name');
    const value = kw.childForFieldName('value');
    if (!name || !value || !isModelLikeName(name.text)) continue;
    const traced = traceableName(value);
    if (traced) add(traced, value, enclosingCall(value), name.text);
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
      if (traced) add(traced, arg, call);
    }
  }
  for (const pair of tree.rootNode.descendantsOfType('pair')) {
    if (!pair) continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value || !isModelLikeStringKey(key)) continue;
    if (!isEnclosingDictACallArgument(pair)) continue;
    const traced = traceableName(value);
    if (traced) add(traced, value, enclosingCall(value));
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
  /** What in the file decided a non-direct `surface` (see explainPySurface), for the reason. */
  surfaceVia?: string;
  value?: string;
  /** Where each traced name flows — lets the caps follow a variable hop. */
  sinkTargets?: Map<string, PySinkTarget[]>;
}

export const PY_SURFACE_REASON = 'provider surface is not a verified direct provider — a direct replacement is not valid here';

/** {@link PY_SURFACE_REASON}, naming the surface and, when known, the evidence in the file. */
function surfaceCapReason(surface: PySurface, ctx?: PyGuardContext): string {
  return `${PY_SURFACE_REASON} (${surface}${ctx?.surfaceVia ? `: ${ctx.surfaceVia}` : ''})`;
}

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
/** The Python twin of TS_EXAMPLE_CALL_REASON. See the C3 narrowing, 2026-09-28. */
export const PY_EXAMPLE_CALL_REASON =
  'example / sample tree, but the id is passed to a real provider request here: runnable, so it breaks at retirement — review, never an unattended swap';
export const PY_PREFIXED_REASON =
  'provider-prefixed selector (gateway / provider registry); the successor may need a different prefix, capped at review';

export const PY_LOOKUP_DEFAULT_REASON =
  'fallback value of a model lookup (getattr / .get / getenv); a real default whose consumer is not traced, review before changing';
export const PY_DEFAULT_CONTAINER_REASON =
  'model value inside a default-configuration dict; a real default whose consumer is not traced, review before changing';
export const PY_CLI_DEFAULT_REASON =
  'default value of a command-line option; the model used whenever the flag is omitted, and its use is not traced — review before changing';
/**
 * `params = {"model": "gpt-4", …}` … `client.chat.completions.create(**params)`. A real request,
 * and the Python twin of TS_REQUEST_VARIABLE_REASON. Always held: the call can add or override
 * keys the dict does not show, and Python's only gate is a re-parse.
 */
export const PY_REQUEST_DICT_REASON =
  'request dict built in a variable and unpacked (**) into a provider request; what the call finally sends is not all visible in the dict, so it is held for review';

/**
 * Is the dict holding `pair` the value of a plain `name = {…}` assignment whose name is unpacked
 * (`**name`) into a recognised provider request, model factory or legacy SDK call?
 *
 * The dict pair rule only trusted a dict written inside the call's parentheses, so a request built
 * in a variable first was a catalog value — the false clean the TypeScript scanner gave a Node
 * server (2026-10-09), in its Python spelling. Narrow on purpose: a `**name` into any other callee
 * (`log_event(**payload)`) is not evidence of a request, a positional or `json=` argument is not
 * followed, and the unpacking must be in the dict's own function (or anywhere, for a module-level
 * dict), so a same-named dict in another function is not mistaken for the one that is sent.
 */
/**
 * Every `**name` in a parse, by name, built once per tree. Walking the tree per matched literal
 * was quadratic: 800 module-level model dicts in a 4,800-function file took 60 s, against 1.1 s
 * without the rule. A tree is never re-parsed in place, so the index is never read across an edit.
 */
const SPLAT_INDEX = new WeakMap<Tree, Map<string, PyNode[]>>();

function splatsNamed(tree: Tree, name: string): PyNode[] {
  let byName = SPLAT_INDEX.get(tree);
  if (!byName) {
    byName = new Map();
    for (const splat of tree.rootNode.descendantsOfType('dictionary_splat')) {
      const inner = splat?.namedChildren[0];
      if (!splat || !inner || inner.type !== 'identifier') continue;
      const list = byName.get(inner.text);
      if (list) list.push(splat);
      else byName.set(inner.text, [splat]);
    }
    SPLAT_INDEX.set(tree, byName);
  }
  return byName.get(name) ?? [];
}

function isDictUnpackedIntoProviderCall(pair: PyNode): boolean {
  const dict = pair.parent;
  if (!dict || dict.type !== 'dictionary') return false;
  let node: PyNode = dict;
  let parent = node.parent;
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.parent;
  }
  if (!parent || parent.type !== 'assignment' || !parent.childForFieldName('right')?.equals(node)) return false;
  const left = parent.childForFieldName('left');
  if (!left || left.type !== 'identifier') return false;
  const name = left.text;
  const scope = enclosingFunction(parent);
  for (const splat of splatsNamed(pair.tree, name)) {
    // A function-local dict is only the one unpacked in that same function.
    if (scope && !enclosingFunction(splat)?.equals(scope)) continue;
    const call = splat.parent?.type === 'argument_list' ? splat.parent.parent : null;
    if (!call || call.type !== 'call') continue;
    const dotted = dottedCallee(call);
    if (matchSdkSink(dotted) || isLegacySdkSink(dotted) || isProviderModelFactory(dotted)) return true;
  }
  return false;
}

/** Is the literal the LAST argument of a lookup whose key names a model, or whose result is assigned to a model-named name? */
function isLookupDefaultForModel(argList: PyNode, literal: PyNode): boolean {
  const args = argList.namedChildren;
  if (args.length < 2 || !args[args.length - 1].equals(literal)) return false;
  // `response.get("modelVersion", …)` / `message.get("model", …)` read the model
  // a PROVIDER RETURNED; the default fills a parse, it does not select a request.
  const callee = argList.parent?.childForFieldName('function');
  const receiver = callee?.type === 'attribute' ? (callee.childForFieldName('object')?.text ?? '') : '';
  if (/(response|resp|result|message|msg|reply|output|usage|event|chunk)/i.test(receiver.split('.').pop() ?? '')) return false;
  for (const a of args.slice(0, -1)) {
    const c = plainStringContent(a);
    if (c && isModelLikeName(c.value)) return true;
  }
  const call = argList.parent;
  const assign = call?.parent;
  if (assign?.type === 'assignment') {
    const left = assign.childForFieldName('left');
    const name = left ? traceableName(left) : undefined;
    if (name && isModelLikeName(name)) return true;
  }
  return false;
}

/** Does the dict holding `pair` carry catalog-shaped sibling keys (label, pricing, description…)? */
function hasCatalogSiblingsPy(pair: PyNode): boolean {
  const dict = pair.parent;
  if (!dict || dict.type !== 'dictionary') return false;
  for (const p of dict.namedChildren) {
    if (p.type !== 'pair') continue;
    const k = p.childForFieldName('key');
    const c = k ? plainStringContent(k) : undefined;
    if (c && CATALOG_SIBLING_KEYS.test(c.value)) return true;
  }
  return false;
}

/** Is this pair (through nested dicts/lists) the value of an assignment to a default-configuration name? */
function isInDefaultContainerPy(pair: PyNode): boolean {
  let n: PyNode | null = pair.parent;
  while (n) {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      const name = left ? traceableName(left) : undefined;
      return !!name && isDefaultContainerName(name);
    }
    if (n.type === 'dictionary' || n.type === 'pair' || n.type === 'list' || n.type === 'parenthesized_expression') {
      n = n.parent;
      continue;
    }
    return false;
  }
  return false;
}

/** Is the node inside a class whose name says it IS a model / LLM / embedder / provider? */
function isModelClassScope(node: PyNode): boolean {
  let n: PyNode | null = node.parent;
  while (n) {
    if (n.type === 'function_definition') return false; // a local `id = …` inside a method is not a field
    if (n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text ?? '';
      return /(model|llm|chat|embed|provider|client|completion)/i.test(name);
    }
    n = n.parent;
  }
  return false;
}

export const PY_TOKENIZER_REASON =
  'model id selects a local tokenizer / encoding table, not a provider request';
export const PY_NON_SELECTOR_FUNCTION_REASON =
  'model literal inside a pricing, tokenizer, logging, metrics or param-mapping helper — not a request selector';

/** Callees that take a model id to pick a LOCAL encoding table, never to send a request. */
const TOKENIZER_CALLEES: ReadonlySet<string> = new Set([
  'token_counter', 'count_tokens', 'num_tokens_from_messages', 'num_tokens', 'decode', 'encode',
  'encoding_for_model', 'get_encoding', 'get_tokenizer', 'tokenizer', 'get_max_tokens', 'get_model_info',
]);

/** Is `dotted` a tokenizer / encoding helper (`litellm.decode`, `token_counter`, `tiktoken.encoding_for_model`)? */
function isTokenizerCallee(dotted: string | null): boolean {
  if (!dotted) return false;
  return TOKENIZER_CALLEES.has(dotted.split('.').pop() ?? '');
}

/**
 * Functions whose model literals are NEVER request selectors: pricing and cost
 * calculators, tokenizers, logging/observability callbacks, metrics/analytics
 * filters, and OpenAI-param mapping helpers that use a sentinel model to pick a
 * capability branch. Partner audits (2026-09-04, litellm): fifteen such literals
 * were review candidates.
 */
const NON_SELECTOR_FUNCTION =
  /(token|encod|tokeniz|cost|pric|spend|metric|analytic|dashboard|^log_|_log$|_log_|logger|^map_\w*params$|_params$|^supports_|^get_supported)/i;

/** Files whose whole purpose is tokenizing, pricing or observability logging. */
const NON_SELECTOR_FILE = /(^|\/)([^/]*(token_count|tokeniz|cost_calc|pricing)[^/]*\.py|integrations\/[^/]+\.py)$/i;

/** Is the node inside a function whose name says it cannot be selecting a request model? */
function isNonSelectorFunction(node: PyNode): boolean {
  const fn = enclosingFunction(node);
  const name = fn?.childForFieldName('name')?.text;
  return !!name && NON_SELECTOR_FUNCTION.test(name);
}

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
    return { position: 'surface_capped', reason: surfaceCapReason(surface, ctx) };
  }
  return null;
}

/**
 * M2: is this `default=` / `value=` keyword the default of a model-named
 * assignment target — `model_name: str = Field(default="…")`,
 * `model = Column(default="…")`? Then the literal is a real selector.
 */
/**
 * `parser.add_argument('--gpt_version', type=str, default="o3-mini")`.
 *
 * A command-line option's `default=` IS the model the program runs with whenever the flag is
 * omitted — and for a documented command in a README, the flag is omitted every time. Two
 * separate rules had to miss this for it to read as inert data: the option's name is not an
 * assignment target, so `modelNamedAssignmentTarget` sees nothing to test; and a flag called
 * `--gpt_version` does not contain the substring "model", so `isModelLikeName` rejects it too.
 *
 * External validation (going-doer/Paper2Code, 2026-09-16): `scripts/run.sh` and both README
 * evaluation commands run `o3-mini`, which OpenAI retires in 37 days, and the audit concluded
 * NO EXPOSURE IN COMPLETED SURFACES. A wrong "clean" is the one answer this scanner must never
 * give, so a CLI default holding a retiring id has to surface.
 *
 * Deliberately keyed on the CALL rather than on the option's name: by the time this runs the
 * value is already known to match a registry model id, and a CLI default holding a model id is
 * a selector whatever the flag happens to be called. It caps at review — the path from
 * `args.x` to a provider request is not traced — so this never becomes swap-eligible.
 */
function isCliOptionDefault(kwarg: PyNode): boolean {
  const call = kwarg.parent?.parent; // keyword_argument → argument_list → call
  if (!call || call.type !== 'call') return false;
  const dotted = dottedCallee(call);
  if (!dotted) return false;
  // argparse / optparse / absl (`add_argument`, `add_option`), and click / typer
  // decorators (`@click.option(...)`, `typer.Option(...)`).
  const last = dotted.split('.').pop() ?? '';
  return last === 'add_argument' || last === 'add_option' || last === 'option' || last === 'Option';
}

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

  // A model id handed to a tokenizer / encoding helper (`token_counter(model=…)`,
  // `litellm.decode(model=…)`) selects a local table, not a provider request.
  if (call && !sink && isTokenizerCallee(dotted)) {
    return { position: 'data', purpose: 'generic', reason: PY_TOKENIZER_REASON };
  }
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
      return { position: 'surface_capped', reason: surfaceCapReason(surface, ctx) };
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
    const targets = inScopeSinkTargets(literal, ctx);
    if (targets.length === 0) {
      // No in-scope consumer. A same-named sink elsewhere in the file made the
      // positional rule say model_arg, but inside a pricing / tokenizer / logging /
      // param-mapping helper the literal is a sentinel or lookup key, not a default.
      if (isNonSelectorFunction(literal)) {
        return { position: 'data', purpose: 'generic', reason: PY_NON_SELECTOR_FUNCTION_REASON };
      }
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
 * The calls a model value bound to a name (`MODEL = "…"`, `self.model = "…"`, a parameter
 * default) is traced into, limited to the ones in its scope.
 *
 * SCOPE-AWARE. Sink names are collected file-globally, so an unrelated local
 * `model = "gpt-4"` matched a sink fed by a same-named parameter in ANOTHER
 * function — and fix-llm rewrote that unrelated assignment. A local binding
 * is only trusted against a sink in the same function.
 */
function inScopeSinkTargets(literal: PyNode, ctx?: PyGuardContext): PySinkTarget[] {
  const traced = tracedNameOf(literal);
  const reachable = traced ? ctx?.sinkTargets?.get(traced) ?? [] : [];
  // `traceableName` returns the ATTRIBUTE name for `self.model`, so detect the
  // self-attribute case from the AST instead of the traced string.
  const left = literal.parent?.type === 'assignment' ? literal.parent.childForFieldName('left') : null;
  const isSelfAttr = left?.type === 'attribute';
  return reachable.filter((t) => sinkIsInScope(literal, t.call, isSelfAttr));
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
    return { position: 'surface_capped', reason: surfaceCapReason(surface, ctx) };
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
      // The same defaulting idea one call shape over: a command-line option's
      // default, which no assignment target and no model-like flag name betray.
      if (name.text === 'default' && isCliOptionDefault(parent)) {
        return { position: 'usage_unverified', reason: PY_CLI_DEFAULT_REASON };
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
    if (fname && isModelLikeName(fname) && !isNonSelectorFunction(node)) {
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
      // The same request, built in a variable and unpacked into the call (`create(**params)`).
      // Flow evidence outranks the name rule below, and it is held, never swapped.
      if (isModelLikeStringKey(key) && isDictUnpackedIntoProviderCall(parent)) {
        return { position: 'surface_capped', reason: PY_REQUEST_DICT_REASON };
      }
      // A `"model"` value in a standalone DEFAULT-configuration dict
      // (`DEFAULT_CONFIG = {"llm": {"config": {"model": "…"}}}`) is the default a
      // caller inherits — review — unless the dict is catalog-shaped.
      if (isModelLikeStringKey(key) && !hasCatalogSiblingsPy(parent) && isInDefaultContainerPy(parent)) {
        return { position: 'usage_unverified', reason: PY_DEFAULT_CONTAINER_REASON };
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
        // A traced sink is EVIDENCE and always wins over a name heuristic.
        if (sinkNames?.has(name)) return { position: 'model_arg' };
        // Otherwise a local `model = "…"` inside a pricing / tokenizer / logging /
        // param-mapping helper is a sentinel or a lookup key, never a selector.
        if (isNonSelectorFunction(node)) {
          return { position: 'data', purpose: 'generic', reason: PY_NON_SELECTOR_FUNCTION_REASON };
        }
        return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
      }
      // `id: str = "gemini-embedding-001"` on a class whose NAME says it is a model
      // or embedder (agno's convention): the field is the model id, review.
      if (name === 'id' && isModelClassScope(node)) {
        return { position: 'usage_unverified', reason: PY_FIELD_DEFAULT_REASON };
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
        // A parameter default on a metrics / cost / logging endpoint filters data;
        // it does not select a request model (litellm `/model/metrics`).
        if (isNonSelectorFunction(node)) {
          return { position: 'data', purpose: 'generic', reason: PY_NON_SELECTOR_FUNCTION_REASON };
        }
        return { position: 'usage_unverified', reason: USAGE_UNVERIFIED_REASON };
      }
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (d) direct positional argument to a known model factory.
  if (parent.type === 'argument_list' && parent.parent?.type === 'call') {
    const factory = calleeLastIdentifier(parent.parent);
    if (factory && PY_MODEL_FACTORIES.has(factory)) return { position: 'model_arg' };
    // M2 (partner audits, mem0): `getattr(cfg, "model", "gpt-4")`,
    // `os.environ.get("MEM0_DEFAULT_LLM_MODEL", "gpt-4")`, `d.get("model", "gpt-4")`
    // — the literal is the DEFAULT of a model-named lookup: a real selector.
    if (factory && LOOKUP_WITH_DEFAULT.has(factory) && isLookupDefaultForModel(parent, node)) {
      if (isNonSelectorFunction(node)) {
        return { position: 'data', purpose: 'generic', reason: PY_NON_SELECTOR_FUNCTION_REASON };
      }
      return { position: 'usage_unverified', reason: PY_LOOKUP_DEFAULT_REASON };
    }
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

// --- The parameter guard -----------------------------------------------------
//
// THE PYTHON HALF OF src/usage/coupledParams.ts. A verified replacement is not yet a safe patch:
// the registry record says which id to put there and nothing about the request around it. Until
// this guard, `client.chat.completions.create(model="gpt-3.5-turbo", max_tokens=20)` was a Tier A
// swap to gpt-5.6-terra with `max_tokens` kept, and a Claude Opus 4.1 call passing `temperature`
// was a Tier A swap to claude-opus-4-8 with `temperature` kept, although the registry's own rules
// say each replacement rejects that request. TypeScript held both for review. Python has no
// parameter pass either, so nothing edited the request after the swap.
//
// This scanner only COLLECTS the parameter names a request passes. Whether they hold the call,
// and the sentence that says why, come from paramHoldReason, which the TypeScript scanner calls
// too, so the two languages give one call the same reason code. The names are:
//
//   - the keyword arguments of the call the model is written in (`max_tokens=20`);
//   - the keys of a dict unpacked into that call with `**name`, where `name` is bound in a scope
//     the call can see: `name = {…}` or `name = dict(…)`, plus keys added by `name["k"] = …`,
//     `name.update(…)` or `name.setdefault("k", …)` there or beside the call; and the keys of a
//     `**{…}` or `**dict(…)` written in the call itself;
//   - for a `**kwargs` (or any other) function parameter, only the keys added to it in that way,
//     because those are sent whatever the caller passed;
//   - for a model value inside a dict passed to a call, that dict's own keys, as TypeScript reads
//     the object literal that holds `model`;
//   - for a model bound to a name the scanner traced into a call (`MODEL = "…"`, then
//     `create(model=MODEL, …)`), the keyword arguments of each call in scope whose model is that
//     same reference (see samePyReference).
//
// A dict mendr cannot see adds nothing of its own: the caller's keys in a function parameter
// (`**kwargs`), an attribute, a call result. The guard never invents a parameter, the same way a
// spread adds none in TypeScript.

/** The parameter names one request passes, and the call's line when the model reaches it through a name. */
interface PyRequestParams {
  names: string[];
  /** 1-based line of the call, set only when the model value is written somewhere else. */
  callLine?: number;
}

/** The scope a binding at `node` lives in: the nearest function, lambda or class body. Null is the module. */
function pyScopeOf(node: PyNode): PyNode | null {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'function_definition' || n.type === 'lambda' || n.type === 'class_definition') return n;
  }
  return null;
}

/** Does this function or lambda take `name` as a parameter (`params`, `params: dict`, `params=None`, `**params`, `**params: Any`)? */
function declaresPyParameter(scope: PyNode, name: string): boolean {
  const params = scope.childForFieldName('parameters');
  if (!params) return false;
  for (const p of params.namedChildren) {
    if (!p) continue;
    let id: PyNode | null | undefined = p.type === 'identifier' ? p : p.childForFieldName('name');
    if (!id) {
      // `params: dict` puts the name first; `*args: int` and `**kw: dict` wrap it in a splat pattern.
      const first = p.namedChildren[0];
      id =
        first?.type === 'list_splat_pattern' || first?.type === 'dictionary_splat_pattern'
          ? first.namedChildren.find((c) => c?.type === 'identifier')
          : first?.type === 'identifier'
            ? first
            : undefined;
    }
    if (id?.text === name) return true;
  }
  return false;
}

const PY_COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/** Does a `for … in` clause of this comprehension bind `name` (`for model in …`, `for _, model in …`)? */
function comprehensionBinds(comprehension: PyNode, name: string): boolean {
  const binds = (target: PyNode): boolean => {
    if (target.type === 'identifier') return target.text === name;
    if (target.type === 'attribute' || target.type === 'subscript') return false;
    return target.namedChildren.some((c) => c !== null && binds(c));
  };
  return comprehension.namedChildren.some((c) => {
    const left = c?.type === 'for_in_clause' ? c.childForFieldName('left') : null;
    return left !== null && binds(left);
  });
}

/**
 * The scope whose binding of the identifier `id` Python reads there: the innermost scope that
 * assigns, imports or defines the name or takes it as a parameter, looked up outward, with a class
 * body visible only to code written directly in it. Null is the module. A comprehension that binds
 * the name in its own `for` clause is returned as its own scope. Undefined when nothing in this file
 * binds the name, so no value can be tied to it.
 */
function pyBindingScopeOf(id: PyNode): PyNode | null | undefined {
  const name = id.text;
  const index = pyNameIndex(id.tree);
  let first = true;
  for (let n = id.parent; n; n = n.parent) {
    if (PY_COMPREHENSIONS.has(n.type)) {
      if (comprehensionBinds(n, name)) return n;
      continue;
    }
    if (n.type !== 'function_definition' && n.type !== 'lambda' && n.type !== 'class_definition') continue;
    // A class body is not visible from the functions defined inside it.
    if (n.type === 'class_definition' && !first) continue;
    first = false;
    if (index.bindings.has(pyNameKey(name, n))) return n;
    if (n.type !== 'class_definition' && declaresPyParameter(n, name)) return n;
  }
  return index.bindings.has(pyNameKey(name, null)) ? null : undefined;
}

/** The two scopes are the same one (null is the module). */
function samePyScope(a: PyNode | null, b: PyNode | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/** The node a model value bound to a name is bound through: the assignment's target, or the parameter's name. */
function pyBindingTargetOf(literal: PyNode): PyNode | null {
  const p = literal.parent;
  if (p?.type === 'assignment') return p.childForFieldName('left');
  if (p?.type === 'default_parameter' || p?.type === 'typed_default_parameter') return p.childForFieldName('name');
  return null;
}

/**
 * Does `use` read the value bound through `binding`? The sink trace keys a call by the last name
 * only, so `self.judge.model`, another function's own `model` parameter and `args.model` all reach a
 * `self.model = "…"` or a module `model = "…"`. Only the same reference counts:
 *
 *   - a plain name: the same identifier, resolved to the same binding (not a parameter, local,
 *     import or comprehension variable that shadows it);
 *   - a class attribute (`model = "…"` in a class body): also `self.model`, `cls.model` or
 *     `Bot.model` inside that class;
 *   - an attribute (`self.model = "…"`): the same attribute path; `self` is the same instance within
 *     one class, any other root must resolve to the same binding.
 */
function samePyReference(binding: PyNode, use: PyNode): boolean {
  if (binding.type === 'identifier') {
    if (use.type === 'identifier') {
      if (use.text !== binding.text) return false;
      const declared = pyBindingScopeOf(binding);
      const read = pyBindingScopeOf(use);
      return declared !== undefined && read !== undefined && samePyScope(declared, read);
    }
    const cls = pyBindingScopeOf(binding);
    if (use.type !== 'attribute' || !cls || cls.type !== 'class_definition') return false;
    const obj = use.childForFieldName('object');
    const receivers = ['self', 'cls', cls.childForFieldName('name')?.text];
    return (
      use.childForFieldName('attribute')?.text === binding.text &&
      obj?.type === 'identifier' &&
      receivers.includes(obj.text) &&
      enclosingClass(use)?.equals(cls) === true
    );
  }
  if (binding.type !== 'attribute' || use.type !== 'attribute') return false;
  if (binding.childForFieldName('attribute')?.text !== use.childForFieldName('attribute')?.text) return false;
  const declaredObj = binding.childForFieldName('object');
  const readObj = use.childForFieldName('object');
  if (!declaredObj || !readObj) return false;
  if (declaredObj.type === 'identifier' && declaredObj.text === 'self') {
    if (readObj.type !== 'identifier' || readObj.text !== 'self') return false;
    const declaredClass = enclosingClass(declaredObj);
    const readClass = enclosingClass(readObj);
    return declaredClass !== null && readClass !== null && declaredClass.equals(readClass);
  }
  return samePyReference(declaredObj, readObj);
}

/**
 * Every binding of every plain name in a parse, keyed by name AND scope (see {@link pyNameKey}),
 * built once per tree like SPLAT_INDEX, so resolving a name is one lookup per scope rather than a
 * walk over every binding of that name in the file.
 */
interface PyNameIndex {
  /**
   * Name-in-scope keys that are bound: assignments, `for` targets, `with … as` aliases, `:=`,
   * augmented assignments, imports, and the names of `def` and `class` statements.
   */
  bindings: Set<string>;
  /** The right-hand side of each `name = …` with the name alone on the left. */
  values: Map<string, PyNode[]>;
  /** Keys added to the dict after it is built, and any expression whose keys are added with them. */
  added: Map<string, Array<{ keys: string[]; from: PyNode[] }>>;
}

const NAME_INDEX = new WeakMap<Tree, PyNameIndex>();

/** The index key for `name` bound in `scope` (null is the module). Node ids are unique within a tree. */
function pyNameKey(name: string, scope: PyNode | null): string {
  return `${scope ? scope.id : -1}:${name}`;
}

function pyNameIndex(tree: Tree): PyNameIndex {
  const cached = NAME_INDEX.get(tree);
  if (cached) return cached;
  const index: PyNameIndex = { bindings: new Set(), values: new Map(), added: new Map() };
  const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const bind = (name: string, at: PyNode): void => {
    index.bindings.add(pyNameKey(name, pyScopeOf(at)));
  };
  // `a, b = …`, `for k, v in …`, `with … as (x, y)`: every name in the target is bound, value unknown.
  const bindTargets = (target: PyNode, at: PyNode): void => {
    if (target.type === 'identifier') {
      bind(target.text, at);
      return;
    }
    if (target.type === 'attribute' || target.type === 'subscript') return;
    for (const c of target.namedChildren) if (c) bindTargets(c, at);
  };
  for (const a of tree.rootNode.descendantsOfType('assignment')) {
    const left = a?.childForFieldName('left');
    if (!a || !left) continue;
    if (left.type === 'identifier') {
      bind(left.text, a);
      const right = a.childForFieldName('right');
      if (right) push(index.values, pyNameKey(left.text, pyScopeOf(a)), right);
    } else if (left.type === 'subscript') {
      // `params["max_tokens"] = 20` adds a key to the dict `params` already names.
      const obj = left.childForFieldName('value');
      const key = left.childForFieldName('subscript');
      const content = key ? plainStringContent(key) : undefined;
      if (obj?.type === 'identifier' && content) {
        push(index.added, pyNameKey(obj.text, pyScopeOf(a)), { keys: [content.value], from: [] });
      }
    } else {
      bindTargets(left, a);
    }
  }
  for (const a of tree.rootNode.descendantsOfType('augmented_assignment')) {
    const left = a?.childForFieldName('left');
    if (!a || left?.type !== 'identifier') continue;
    bind(left.text, a);
    // `params |= {"temperature": 0}` adds that dict's keys.
    const right = a.childForFieldName('right');
    if (a.childForFieldName('operator')?.text === '|=' && right) {
      push(index.added, pyNameKey(left.text, pyScopeOf(a)), { keys: [], from: [right] });
    }
  }
  for (const f of tree.rootNode.descendantsOfType('for_statement')) {
    const left = f?.childForFieldName('left');
    if (f && left) bindTargets(left, f);
  }
  for (const t of tree.rootNode.descendantsOfType('as_pattern_target')) {
    if (t) bindTargets(t, t);
  }
  for (const w of tree.rootNode.descendantsOfType('named_expression')) {
    const name = w?.childForFieldName('name');
    if (w && name?.type === 'identifier') bind(name.text, w);
  }
  // `import a.b` binds `a`; `import c as d` and `from x import z as d` bind `d`; `from x import y` binds `y`.
  for (const imp of tree.rootNode.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!imp) continue;
    for (const n of imp.childrenForFieldName('name')) {
      const bound = n?.type === 'aliased_import' ? n.childForFieldName('alias') : n?.type === 'dotted_name' ? n.namedChildren[0] : null;
      if (bound?.type === 'identifier') bind(bound.text, imp);
    }
  }
  // `def model(…)` and `class Model` bind their names in the scope around them.
  for (const d of tree.rootNode.descendantsOfType(['function_definition', 'class_definition'])) {
    const name = d?.childForFieldName('name');
    if (d && name?.type === 'identifier') bind(name.text, d);
  }
  for (const call of tree.rootNode.descendantsOfType('call')) {
    const fn = call?.childForFieldName('function');
    const obj = fn?.type === 'attribute' ? fn.childForFieldName('object') : null;
    const method = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : undefined;
    const args = call?.childForFieldName('arguments');
    if (!call || obj?.type !== 'identifier' || !args || args.type !== 'argument_list') continue;
    if (method === 'update') {
      // `params.update(temperature=0)`, `params.update({"top_p": 1})`, `params.update(**extra)`.
      const keys: string[] = [];
      const from: PyNode[] = [];
      for (const arg of args.namedChildren) {
        if (!arg) continue;
        if (arg.type === 'keyword_argument') {
          const n = arg.childForFieldName('name');
          if (n) keys.push(n.text);
        } else if (arg.type === 'dictionary_splat') {
          if (arg.namedChildren[0]) from.push(arg.namedChildren[0]);
        } else {
          from.push(arg);
        }
      }
      push(index.added, pyNameKey(obj.text, pyScopeOf(call)), { keys, from });
    } else if (method === 'setdefault') {
      const first = args.namedChildren[0];
      const content = first ? plainStringContent(first) : undefined;
      if (content) push(index.added, pyNameKey(obj.text, pyScopeOf(call)), { keys: [content.value], from: [] });
    }
  }
  NAME_INDEX.set(tree, index);
  return index;
}

/**
 * The keys a dict-valued expression is known to carry: a dict display, a `dict(…)` call, a name
 * bound to one of those, and `or`, conditional and `|` combinations of them. Anything else is not
 * visible here and adds nothing. `seen` stops a self-reference (`params = {**params, …}`).
 */
function pyDictKeys(expr: PyNode, seen: Set<number>, depth = 0): string[] {
  if (depth > 8 || seen.has(expr.id)) return [];
  seen.add(expr.id);
  const next = (n: PyNode | null | undefined): string[] => (n ? pyDictKeys(n, seen, depth + 1) : []);
  switch (expr.type) {
    case 'dictionary': {
      const keys: string[] = [];
      for (const c of expr.namedChildren) {
        if (c?.type === 'pair') {
          const key = c.childForFieldName('key');
          const content = key ? plainStringContent(key) : undefined;
          if (content) keys.push(content.value);
        } else if (c?.type === 'dictionary_splat') {
          keys.push(...next(c.namedChildren[0]));
        }
      }
      return keys;
    }
    case 'call': {
      if (dottedCallee(expr) !== 'dict') return [];
      const args = expr.childForFieldName('arguments');
      if (!args || args.type !== 'argument_list') return [];
      const keys: string[] = [];
      for (const a of args.namedChildren) {
        if (!a) continue;
        if (a.type === 'keyword_argument') {
          const n = a.childForFieldName('name');
          if (n) keys.push(n.text);
        } else if (a.type === 'dictionary_splat') {
          keys.push(...next(a.namedChildren[0]));
        } else {
          keys.push(...next(a));
        }
      }
      return keys;
    }
    case 'identifier':
      return pyNameKeys(expr.text, expr, seen, depth + 1);
    case 'parenthesized_expression':
      return next(expr.namedChildren[0]);
    case 'boolean_operator':
      return expr.childForFieldName('operator')?.type === 'or'
        ? [...next(expr.childForFieldName('left')), ...next(expr.childForFieldName('right'))]
        : [];
    case 'binary_operator':
      return expr.childForFieldName('operator')?.type === '|'
        ? [...next(expr.childForFieldName('left')), ...next(expr.childForFieldName('right'))]
        : [];
    case 'conditional_expression': {
      const named = expr.namedChildren;
      return [...next(named[0]), ...next(named[named.length - 1])];
    }
    case 'assignment': // `a = b = {…}`
      return next(expr.childForFieldName('right'));
    default:
      return [];
  }
}

/**
 * The keys of the dict `name` refers to where it is used. The innermost scope that binds the name
 * decides, as in Python: its `name = …` values, plus keys added in that scope or beside the use.
 *
 * A function parameter (`**kwargs`, `params`) carries keys mendr cannot see, so it adds none of
 * its own. A key added to it there or beside the use (`kwargs.setdefault("max_tokens", 512)`,
 * `kwargs["temperature"] = 0`, `kwargs.update(top_p=1)`) is sent whatever the caller passed, so it
 * is read like a key added to any other dict.
 */
function pyNameKeys(name: string, use: PyNode, seen: Set<number>, depth: number): string[] {
  const index = pyNameIndex(use.tree);
  const scope = pyBindingScopeOf(use);
  // Nothing in this file binds it, or a comprehension variable does: no dict mendr can see.
  if (scope === undefined || (scope !== null && PY_COMPREHENSIONS.has(scope.type))) return [];
  const key = pyNameKey(name, scope);
  const useKey = pyNameKey(name, pyScopeOf(use));
  const keys: string[] = [];
  // A parameter that is never reassigned has no `name = …` value here.
  for (const value of index.values.get(key) ?? []) keys.push(...pyDictKeys(value, seen, depth));
  // Keys added where the dict is bound, and beside the call that unpacks it.
  for (const addKey of key === useKey ? [key] : [key, useKey]) {
    for (const add of index.added.get(addKey) ?? []) {
      keys.push(...add.keys);
      for (const f of add.from) keys.push(...pyDictKeys(f, seen, depth));
    }
  }
  return keys;
}

/** The parameter names a call passes: its keyword arguments, and the keys of each dict unpacked into it. */
function pyCallParamNames(call: PyNode): string[] {
  const args = call.childForFieldName('arguments');
  if (!args || args.type !== 'argument_list') return [];
  const names: string[] = [];
  const seen = new Set<number>();
  for (const a of args.namedChildren) {
    if (a?.type === 'keyword_argument') {
      const n = a.childForFieldName('name');
      if (n) names.push(n.text);
    } else if (a?.type === 'dictionary_splat' && a.namedChildren[0]) {
      names.push(...pyDictKeys(a.namedChildren[0], seen));
    }
  }
  return [...new Set(names)];
}

/** The requests a `model_arg` literal is the model of, each with the parameter names it passes. */
function pyRequestParams(literal: PyNode, ctx: PyGuardContext): PyRequestParams[] {
  let node: PyNode = literal;
  let parent = node.parent;
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.parent;
  }
  if (!parent) return [];
  // Written in the call: `create(model="…", max_tokens=20)`, or a factory's positional argument.
  if (parent.type === 'keyword_argument' && parent.parent?.type === 'argument_list' && parent.parent.parent?.type === 'call') {
    return [{ names: pyCallParamNames(parent.parent.parent) }];
  }
  if (parent.type === 'argument_list' && parent.parent?.type === 'call') return [{ names: pyCallParamNames(parent.parent) }];
  // Written in a dict passed to a call: the dict's own keys.
  if (parent.type === 'pair' && parent.parent?.type === 'dictionary') {
    return [{ names: [...new Set(pyDictKeys(parent.parent, new Set()))] }];
  }
  // Bound to a name the scanner traced into one or more calls. The trace keys a call by the last
  // name only and lets a module binding reach every function, so read only the calls whose model
  // is this same reference: `model=self.judge.model`, another function's own `model` parameter or
  // `args.model` does not take this value, and holding it there names the wrong call.
  const binding = pyBindingTargetOf(literal);
  if (!binding) return [];
  return inScopeSinkTargets(literal, ctx)
    .filter((t) => samePyReference(binding, t.value))
    .map((t) => ({
      names: pyCallParamNames(t.call),
      callLine: t.call.startPosition.row + 1,
    }));
}

/**
 * paramHoldReason over each request the model reaches, one request at a time; the first that holds
 * the call decides, so the sentence can name that call's line.
 */
function pyParamHoldReason(
  requests: readonly PyRequestParams[],
  deprecation: LlmModelIdDeprecation,
  registry: LlmRegistry,
): string | undefined {
  for (const r of requests) {
    const held = paramHoldReason([r.names], deprecation, registry);
    if (!held) continue;
    // The finding sits on the line the value is written on, so say where the call is.
    return r.callLine === undefined ? held : `the call on line ${r.callLine} of this file takes this value as its model; ${held}`;
  }
  return undefined;
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
  const entries = modelIdEntries(registry);
  const byValue = new Map<string, LlmModelIdDeprecation[]>();
  for (const dep of entries) {
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
      const { surface, via: surfaceVia } = explainPySurface(source.path, source.text);
      const guardCtx: PyGuardContext = { surface, surfaceVia, sinkTargets };
      // An examples/samples/demos/docs tree is informational by rule (C3).
      const example = isExamplePath(source.path);
      for (const node of tree.rootNode.descendantsOfType('string')) {
        const content = plainStringContent(node);
        if (!content) continue; // f-string / prefixed / concatenation fragment
        let deprecations = byValue.get(content.value);
        let prefixed = false;
        // `ft:gpt-4-0613:acme::abc123`: a fine-tuned model id, joined to the registry's row for
        // fine-tunes of its base (or its base model's row) by the usage audit's rule. The WHOLE
        // string must be a fine-tune id. The same rule as the TypeScript scan (scanLiterals.ts).
        let fineTuneOf: string | undefined;
        if (!deprecations) {
          const ft = resolveSourceFineTune(content.value, byValue, entries);
          deprecations = ft?.records;
          fineTuneOf = ft?.base;
        }
        if (!deprecations) {
          // `openai/gpt-5-nano` / `openai:gpt-5-mini`: a gateway or registry
          // selector carrying a registry id — real, never swap-eligible.
          const split = splitProviderPrefix(content.value);
          deprecations = split ? byValue.get(split.id) : undefined;
          if (split && !deprecations) {
            // `openai/ft:gpt-4-0613:acme::abc`: a fine-tune behind a gateway prefix.
            const ft = resolveSourceFineTune(split.id, byValue, entries);
            deprecations = ft?.records;
            fineTuneOf = ft?.base;
          }
          if (!deprecations) continue; // exact-value guard: no substring matching
          prefixed = true;
        }

        // Position/purpose belong to the CST node, not the registry entry, so
        // classify once and emit one match per matching record (multimap).
        let classification: { position: LiteralPosition; purpose?: DataPurpose; reason?: string } =
          classifyPyLiteral(node, sinkNames, guardCtx);
        // Rule C3, narrowed 2026-09-28 — the PYTHON half of the same change made in
        // scanLiterals.ts. An example tree is informational BY DEFAULT, and everything the
        // parser reads as data there still is. But a sample that actually reaches a provider
        // request is runnable and breaks at retirement, so it is reported and capped at review.
        //
        // This half is why langgraph still reported NO EXPOSURE IN COMPLETED SURFACES after
        // the TypeScript fix: its registered graph entrypoint, libs/cli/examples/graphs/
        // agent.py, is Python, and the TS change could not reach it. Fixing one language and
        // announcing the repository fixed is exactly the overclaim this codebase keeps
        // correcting, so it is recorded here rather than quietly patched.
        if (example) {
          classification =
            classification.position === 'data' || classification.position === 'usage_unverified'
              ? { position: 'data', purpose: 'example', reason: PY_EXAMPLE_REASON }
              : { position: 'surface_capped', reason: PY_EXAMPLE_CALL_REASON };
        }
        // A prefixed id is a gateway SELECTOR only where a plain id would have
        // been one; in a list or a catalog dict it is data like any other.
        if (prefixed && !example && classification.position !== 'data') {
          classification = { position: 'surface_capped', reason: PY_PREFIXED_REASON };
        }
        // A default that lives in a tokenizer / cost / pricing module or an
        // observability integration is a lookup key or a log field, not a selector.
        if (
          (classification.position === 'usage_unverified' || classification.position === 'surface_capped') &&
          !prefixed &&
          (NON_SELECTOR_FILE.test(source.path.replace(/\\/g, '/')) || isNonSelectorFunction(node))
        ) {
          classification = { position: 'data', purpose: 'generic', reason: PY_NON_SELECTOR_FUNCTION_REASON };
        }
        // THE PARAMETER GUARD, last, on a call every other rule left swap-eligible, as in
        // scanLiterals.ts. The request is read once per literal; whether it holds the call depends
        // on each record's replacement, so it is judged per record. A fine-tune is held for its own
        // reason below, before any parameter is read, as in the TypeScript scan.
        const requests =
          classification.position === 'model_arg' && fineTuneOf === undefined ? pyRequestParams(node, guardCtx) : [];
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;
        for (const deprecation of deprecations) {
          // A fine-tune is never swapped, whatever its record says: every replacement is a base
          // model, and swapping one in drops the customer's training. Wherever a plain id would be
          // a live or reviewable selector it is held for review with that sentence; in a data
          // position it stays data. The same rule as the TypeScript scan. Any other call is held
          // when the parameter guard holds it.
          const paramHeld = requests.length > 0 ? pyParamHoldReason(requests, deprecation, registry) : undefined;
          const held: { position: LiteralPosition; purpose?: DataPurpose; reason?: string } =
            fineTuneOf !== undefined && classification.position !== 'data'
              ? {
                  position: 'surface_capped',
                  purpose: undefined,
                  reason: fineTuneHoldReason(content.value, fineTuneOf, deprecation.replacement),
                }
              : paramHeld !== undefined
                ? { position: 'surface_capped', purpose: undefined, reason: paramHeld }
                : classification;
          out.push({
            file: source.path,
            value: content.value,
            contentStart: content.start,
            contentEnd: content.end,
            location: { file: source.path, line, column },
            deprecation,
            position: held.position,
            purpose: held.purpose,
            reason: held.reason,
            ...(fineTuneOf !== undefined ? { fineTuneOf } : {}),
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
 *
 * Only `usage_unverified`. This used to take `surface_capped` matches too, and fix-llm printed
 * every one of them under `usage_unverified` — "no supported SDK call or parameter sink was found
 * in this file" — beside a call that IS a supported SDK call, held for its client or its wrapper
 * (Open-Finance-Lab/AgenticTrading, 2026-10-09). audit had them as `surface_capped` all along.
 * A held call now has its own projection, toHeldCallMatches, shared with TypeScript.
 */
export function toPyUsageUnverifiedMatches(matches: PyLiteralMatch[]): UsageUnverifiedLocate[] {
  return matches
    .filter((m) => m.position === 'usage_unverified')
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
