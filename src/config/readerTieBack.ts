import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { PySource } from '../python/scanPy.js';
import { collectPythonFiles, readPythonSources } from '../python/scanPy.js';
import { collectTsSourceFiles, fallbackCompilerOptions, scriptLanguageOf } from '../usage/scanRepo.js';

// READER TIE-BACK (config → code).
//
// A config match like `OPENAI_MODEL: gpt-4` is, on its own, only a CANDIDATE:
// mendr has found a retiring id sitting in configuration, but not shown that any
// code path actually reads it. This module supplies the missing evidence for the
// one case it can prove SOUNDLY: an environment-variable selector whose exact
// name is read in code — `process.env.OPENAI_MODEL`, `os.getenv("OPENAI_MODEL")`,
// and the small set of equivalents. When such a read exists, the config location
// is no longer a bare candidate: code demonstrably reads that variable.
//
// Deliberately CONSERVATIVE:
//   * Only UPPER_SNAKE_CASE keys with an underscore are treated as env vars, so a
//     generic YAML `model:` key never triggers a `process.env.model` hunt.
//   * A proven reader adds EVIDENCE and flips readerTieBackProven; it does NOT
//     promote the finding to auto-fixable. Config is never patched, and "read by
//     code" is still not "called in production" (that needs runtime evidence).
//   * TS/JS reads are matched on the SYNTAX TREE (never inside a comment or an
//     unrelated string). Python reads are matched on the require-a-call-shape
//     text patterns (os.getenv/os.environ), which do not match a bare mention.

/** One place code reads an environment variable that a config selector defines. */
export interface EnvReader {
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  /** The exact accessor, e.g. `process.env.OPENAI_MODEL` or `os.getenv("OPENAI_MODEL")`. */
  via: string;
}

/** Reader evidence attached to a config location: whether a reader was found, and where. */
export interface ReaderTieBack {
  proven: boolean;
  readers: EnvReader[];
}

const MAX_READERS_PER_NAME = 25;

/**
 * A config key that is plausibly an environment variable: UPPER_SNAKE_CASE with
 * at least one underscore. `OPENAI_MODEL`, `LLM_MODEL`, `GEMINI_SUMMARIZE_MODEL`
 * qualify; a lowercase `model` or a bare `MODEL` (too generic) do not.
 */
export function looksLikeEnvVar(key: string | null | undefined): key is string {
  return !!key && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(key);
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME`, `Deno.env.get("NAME")`. */
function tsEnvReadName(node: Node): string | null {
  if (Node.isPropertyAccessExpression(node)) {
    const container = node.getExpression().getText();
    if (container === 'process.env' || container === 'import.meta.env') return node.getName();
    return null;
  }
  if (Node.isElementAccessExpression(node)) {
    const container = node.getExpression().getText();
    if (container !== 'process.env' && container !== 'import.meta.env') return null;
    const arg = node.getArgumentExpression();
    return arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : null;
  }
  if (Node.isCallExpression(node)) {
    // Deno.env.get("NAME")
    if (node.getExpression().getText() !== 'Deno.env.get') return null;
    const arg = node.getArguments()[0];
    return arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : null;
  }
  return null;
}

function pushReader(out: Map<string, EnvReader[]>, name: string, reader: EnvReader): void {
  const list = out.get(name);
  if (!list) {
    out.set(name, [reader]);
  } else if (list.length < MAX_READERS_PER_NAME) {
    list.push(reader);
  }
}

/**
 * Find, for each env-var name in `keys`, every code location that reads it.
 * `keys` is the set of config selector keys; non-env-var-shaped keys are ignored.
 * Returns an empty map when nothing qualifies (the common case), so the caller
 * pays almost nothing on a repo with no env selectors.
 */
export function findConfigReaders(repoPath: string, keys: Iterable<string | null>): Map<string, EnvReader[]> {
  const names = new Set<string>();
  for (const k of keys) if (looksLikeEnvVar(k)) names.add(k);
  const out = new Map<string, EnvReader[]>();
  if (names.size === 0) return out;

  const prefilter = new RegExp([...names].map(esc).join('|'));
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');

  // --- TS / JS: syntax-tree match (never a comment or unrelated string) ---
  const hits: string[] = [];
  for (const file of collectTsSourceFiles(repoPath)) {
    if (scriptLanguageOf(file) === null) continue;
    try {
      if (prefilter.test(readFileSync(file, 'utf8'))) hits.push(file);
    } catch {
      // unreadable file: cannot contribute evidence
    }
  }
  if (hits.length > 0) {
    const project = new Project({ compilerOptions: fallbackCompilerOptions() });
    for (const file of hits) project.addSourceFileAtPath(file);
    for (const sf of project.getSourceFiles()) {
      const file = rel(sf.getFilePath());
      for (const node of [
        ...sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
        ...sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
        ...sf.getDescendantsOfKind(SyntaxKind.CallExpression),
      ]) {
        const name = tsEnvReadName(node);
        if (name && names.has(name)) {
          pushReader(out, name, { file, line: node.getStartLineNumber(), via: node.getText().slice(0, 80) });
        }
      }
    }
  }

  // --- Python: require the call/subscript shape, so a bare mention never matches ---
  const pyReaders = pythonEnvReaders(repoPath, names);
  for (const [name, readers] of pyReaders) for (const r of readers) pushReader(out, name, r);

  return out;
}

function pythonEnvReaders(repoPath: string, names: ReadonlySet<string>): Map<string, EnvReader[]> {
  const out = new Map<string, EnvReader[]>();
  let sources: PySource[];
  try {
    sources = readPythonSources(collectPythonFiles(repoPath));
  } catch {
    return out;
  }
  const alt = [...names].map(esc).join('|');
  if (!alt) return out;
  // os.getenv("NAME") | os.environ.get("NAME") | getenv("NAME") | environ.get("NAME") | os.environ["NAME"] | environ["NAME"]
  const call = new RegExp(`(?:os\\.)?(?:getenv|environ\\.get)\\(\\s*["'](${alt})["']`, 'g');
  const sub = new RegExp(`(?:os\\.)?environ\\[\\s*["'](${alt})["']\\s*\\]`, 'g');
  for (const src of sources) {
    const lines = src.text.split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const re of [call, sub]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const name = m[1]!;
          pushReader(out, name, { file: src.path.replace(/\\/g, '/'), line: i + 1, via: m[0].slice(0, 80) });
        }
      }
    });
  }
  return out;
}
