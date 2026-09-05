import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { modelIdEntries } from '../usage/llmRegistry.js';
import { buildRegistryPrefilter, collectTestSourceFiles, fallbackCompilerOptions } from '../usage/scanRepo.js';
import { collectPythonFiles, isPyTestPath, readPythonSources } from '../python/scanPy.js';
import { usageVerdictState } from '../report/tiers.js';
import type { ExposureMatch } from '../watch/exposure.js';

// TEST-ONLY REFERENCES.
//
// The core scanners deliberately SKIP test/spec/fixture files: a model id in a
// test is not a production dependency, and rewriting one would break the suite.
// But "skipped" left them invisible. This pass surfaces them — a retired id in a
// test will break that test too, so it is worth knowing about — while keeping
// the hard safety line: every reference here is forced to Tier C and flagged
// `testFile`, and the fix-llm/migrate SWAP SCOPE never includes test files
// (they stay outside collectTsSourceFiles), so nothing can ever rewrite them.
//
// This is a lightweight literal scan, NOT the full classifier: since every hit
// is informational by construction, there is nothing to classify — only to
// locate. That also means it cannot manufacture a selector out of a test file.

/** A registry id keyed for lookup, plus a suffix form (`provider/id`, `models/id`). */
function idMap(registry: LlmRegistry): Map<string, LlmModelIdDeprecation> {
  const m = new Map<string, LlmModelIdDeprecation>();
  for (const entry of modelIdEntries(registry)) m.set(entry.deprecated, entry);
  return m;
}

/** Exact match, or a `<prefix>/<id>` / `<prefix>:<id>` form (openai/gpt-4, models/gemini-…). */
function lookup(map: Map<string, LlmModelIdDeprecation>, value: string): LlmModelIdDeprecation | undefined {
  const direct = map.get(value);
  if (direct) return direct;
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  const cut = Math.max(slash, colon);
  return cut >= 0 ? map.get(value.slice(cut + 1)) : undefined;
}

function toTestMatch(entry: LlmModelIdDeprecation, value: string, file: string, line: number, column: number): ExposureMatch {
  return { value, entry, file, line, column, tier: 'C', usageVerdict: usageVerdictState('C'), testFile: true };
}

/**
 * Every retiring model id that appears in a TEST/spec/fixture file, as a Tier-C
 * `testFile` reference. TS/JS via the syntax tree (real string literals only —
 * never a comment); Python via a quoted-literal text scan.
 */
export function findTestReferences(repoPath: string, registry: LlmRegistry): ExposureMatch[] {
  const map = idMap(registry);
  if (map.size === 0) return [];
  const prefilter = buildRegistryPrefilter(registry);
  const rel = (file: string): string => relative(repoPath, file).replace(/\\/g, '/');
  const out: ExposureMatch[] = [];

  // --- TS / JS test files (AST: real string literals, never comments) ---
  const tsTestFiles = collectTestSourceFiles(repoPath);
  const project = new Project({ compilerOptions: fallbackCompilerOptions() });
  for (const file of tsTestFiles) {
    try {
      if (!prefilter || prefilter.test(readOr(file))) project.addSourceFileAtPath(file);
    } catch {
      // unreadable: skip
    }
  }
  for (const sf of project.getSourceFiles()) {
    const file = rel(sf.getFilePath());
    for (const node of [
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ]) {
      const value = Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralValue() : '';
      const entry = value ? lookup(map, value) : undefined;
      if (!entry) continue;
      const start = sf.getLineAndColumnAtPos(node.getStart());
      out.push(toTestMatch(entry, value, file, start.line, start.column));
    }
  }

  // --- Python test files (quoted-literal text scan) ---
  const pyTestFiles = collectPythonFiles(repoPath).filter(isPyTestPath);
  for (const src of readPythonSources(pyTestFiles)) {
    if (prefilter && !prefilter.test(src.text)) continue;
    src.text.split(/\r?\n/).forEach((text, i) => {
      for (const [id, entry] of map) {
        // A quoted string literal equal to the id: "gpt-4" / 'gpt-4'.
        const re = new RegExp(`["'](${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})["']`, 'g');
        let mch: RegExpExecArray | null;
        while ((mch = re.exec(text)) !== null) {
          out.push(toTestMatch(entry, id, src.path.replace(/\\/g, '/'), i + 1, mch.index + 2));
        }
      }
    });
  }

  return out;
}

/** Read a file for the pre-filter text test; unreadable files read as empty. */
function readOr(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
