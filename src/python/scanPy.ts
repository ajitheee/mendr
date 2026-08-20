import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node as PyNode, type Tree } from 'web-tree-sitter';
import type { LlmModelIdDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { isVerified, modelIdEntries } from '../usage/llmRegistry.js';
import {
  isModelLikeName,
  type BlockedModelLocate,
  type LiteralPosition,
  type ModelIdDataLocate,
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
 *       model-like function parameter (`def ask(prompt, model="…")`) — the
 *       parameter default is Python's everyday spelling of the same intent;
 *   (d) a direct string argument to a known model-factory call
 *       (`genai.GenerativeModel("…")`, `ChatOpenAI("…")`).
 *
 * REJECT (`data`, locate-only) otherwise — a dict KEY, a list/tuple/set
 * element, a comparison operand (`m == "…"`, `m in ("…",)`), a standalone dict
 * value, or any position not matching an ACCEPT rule.
 */
export function classifyPyLiteralPosition(literal: PyNode): LiteralPosition {
  // Climb through value-transparent wrappers so a literal inside a fallback /
  // parenthesis / conditional branch is judged by its real enclosing position.
  let node: PyNode = literal;
  let parent = node.parent;
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.parent;
  }
  if (!parent) return 'data';

  // (a) model-like keyword argument, in ANY call. Unlike a dict pair there is
  // no call-flow question to settle — a keyword argument IS a call argument.
  if (parent.type === 'keyword_argument') {
    const name = parent.childForFieldName('name');
    const value = parent.childForFieldName('value');
    if (name && value?.equals(node) && isModelLikeName(name.text)) return 'model_arg';
    return 'data';
  }

  // (b) value side of a model-like string key — ONLY when the enclosing dict is
  // actually passed to a call. A KEY position, or a standalone/catalog dict
  // value, is never swapped (duplicate-key / catalog-corruption risk).
  if (parent.type === 'pair') {
    const key = parent.childForFieldName('key');
    const value = parent.childForFieldName('value');
    if (
      key &&
      value?.equals(node) &&
      isModelLikeStringKey(key) &&
      isEnclosingDictACallArgument(parent)
    ) {
      return 'model_arg';
    }
    return 'data';
  }

  // (c) assignment to a model-like name: `MODEL = "…"` / `self.model = "…"`.
  // Covers annotated assignments too (`model: str = "…"` is the same node).
  if (parent.type === 'assignment') {
    const left = parent.childForFieldName('left');
    const right = parent.childForFieldName('right');
    if (left && right?.equals(node)) {
      if (left.type === 'identifier' && isModelLikeName(left.text)) return 'model_arg';
      if (left.type === 'attribute') {
        const attr = left.childForFieldName('attribute');
        if (attr && isModelLikeName(attr.text)) return 'model_arg';
      }
    }
    return 'data';
  }

  // (c) parameter-default form: `def ask(prompt, model="…")` — with or without
  // a type annotation (typed_default_parameter).
  if (parent.type === 'default_parameter' || parent.type === 'typed_default_parameter') {
    const name = parent.childForFieldName('name');
    const value = parent.childForFieldName('value');
    if (name && value?.equals(node) && isModelLikeName(name.text)) return 'model_arg';
    return 'data';
  }

  // (d) direct positional argument to a known model factory.
  if (parent.type === 'argument_list' && parent.parent?.type === 'call') {
    const factory = calleeLastIdentifier(parent.parent);
    if (factory && PY_MODEL_FACTORIES.has(factory)) return 'model_arg';
    return 'data';
  }

  return 'data';
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
  // Index model-id deprecations by exact `deprecated` value for O(1) lookup.
  // A value maps to the FIRST entry that declares it (same as the TS scan).
  const byValue = new Map<string, LlmModelIdDeprecation>();
  for (const dep of modelIdEntries(registry)) {
    if (!byValue.has(dep.deprecated)) byValue.set(dep.deprecated, dep);
  }
  if (byValue.size === 0) return [];

  const out: PyLiteralMatch[] = [];

  for (const source of sources) {
    if (isPyTestPath(source.path)) continue;

    const tree = await parsePython(source.text);
    try {
      for (const node of tree.rootNode.descendantsOfType('string')) {
        const content = plainStringContent(node);
        if (!content) continue; // f-string / prefixed / concatenation fragment
        const deprecation = byValue.get(content.value);
        if (!deprecation) continue; // exact-value guard: no substring matching

        out.push({
          file: source.path,
          value: content.value,
          contentStart: content.start,
          contentEnd: content.end,
          location: {
            file: source.path,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
          },
          deprecation,
          position: classifyPyLiteralPosition(node),
        });
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
    }));
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
      status: m.deprecation.verification?.status ?? 'unstamped',
      location: m.location,
      note: m.deprecation.note,
      reasons: m.deprecation.verification?.reasons,
    }));
}

/** Repo-relative display path with forward slashes (diff headers, messages). */
export function displayPath(rootDir: string | undefined, file: string): string {
  return (rootDir ? relative(rootDir, file) : file).replace(/\\/g, '/');
}
