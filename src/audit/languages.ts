// Which source languages are PRESENT but not analyzed.
//
// mendr reads TypeScript, TSX and Python. A repository that is 1% TypeScript and
// 99% Go is not a covered repository, and reporting "every required surface
// completed" over it is the quiet kind of dishonesty that loses a customer's
// trust the first time a Go call site retires. So we count what we cannot read
// and name it in the coverage report.

import { readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage',
  '.venv', 'venv', '__pycache__', 'vendor', 'target', 'bin', 'obj',
  '.cache', '.turbo', '.yarn', '.pnpm-store', '.mypy_cache', '.pytest_cache', '.tox', '.nuxt', '.svelte-kit',
]);

/** Extensions mendr actually analyzes. */
const ANALYZED: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.py']);

/** Extensions that carry LLM call sites we cannot read yet, and their language. */
const UNANALYZED: Record<string, string> = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.go': 'Go', '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.php': 'PHP', '.rs': 'Rust', '.swift': 'Swift', '.scala': 'Scala',
  '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart', '.c': 'C', '.cpp': 'C++', '.cc': 'C++', '.h': 'C/C++ headers', '.hpp': 'C++',
  // External validation (2026-09-03): these carried real selectors and were dropped silently.
  '.sql': 'SQL', '.svelte': 'Svelte', '.vue': 'Vue', '.ipynb': 'Jupyter notebooks',
  '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.lua': 'Lua',
};

/** Documentation formats: not code, but a model id written there is still a fact worth disclosing. */
const DOCS: ReadonlySet<string> = new Set(['.md', '.mdx', '.rst', '.txt']);

/** How many files must exist before a language is worth naming as a gap. */
const MIN_FILES = 3;

/**
 * Languages present in the repo that mendr does not analyze, most-common first.
 * Bounded: stops after `limit` files so a huge monorepo cannot stall the audit.
 */
export function unanalyzedLanguages(repoPath: string, limit = 20_000): string[] {
  return unanalyzedCensus(repoPath, limit).languages;
}

/** The census behind the coverage report: named gaps plus the counts the conclusion rule needs. */
export interface UnanalyzedCensus {
  /** "JavaScript (677 files)" … most-common first, at most 8, at least MIN_FILES each. */
  languages: string[];
  /** Unanalyzed CODE files in total (documentation excluded). */
  files: number;
  /** Documentation files (Markdown/MDX/RST/TXT). */
  docs: number;
}

export function unanalyzedCensus(repoPath: string, limit = 50_000): UnanalyzedCensus {
  const counts = new Map<string, number>();
  let files = 0;
  let docs = 0;
  let seen = 0;
  const walk = (dir: string): void => {
    if (seen >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // Dot-directories are NOT walked. They hold tooling — `.claude/`,
        // `.cursor/`, `.github/skills/`, `.agents/` — not the product: on mendr's
        // own repo, 220 vendored skill scripts under `.claude/` flipped the
        // conclusion to "inconclusive". The cost is a small undercount of real
        // code kept under `.github/` (lobe-chat: 23 of 79 JavaScript files).
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      const ext = extname(entry.name).toLowerCase();
      if (ANALYZED.has(ext)) continue;
      if (DOCS.has(ext)) {
        docs++;
        counts.set('Markdown/docs', (counts.get('Markdown/docs') ?? 0) + 1);
        continue;
      }
      const lang = UNANALYZED[ext];
      if (lang) {
        files++;
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  };
  walk(resolve(repoPath));
  const languages = [...counts.entries()]
    .filter(([, n]) => n >= MIN_FILES)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `${lang} (${n} files)`)
    .slice(0, 8);
  return { languages, files, docs };
}
