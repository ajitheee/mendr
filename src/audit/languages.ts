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
]);

/** Extensions mendr actually analyzes. */
const ANALYZED: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.py']);

/** Extensions that carry LLM call sites we cannot read yet, and their language. */
const UNANALYZED: Record<string, string> = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.go': 'Go', '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.php': 'PHP', '.rs': 'Rust', '.swift': 'Swift', '.scala': 'Scala',
  '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart', '.c': 'C', '.cpp': 'C++',
};

/** How many files must exist before a language is worth naming as a gap. */
const MIN_FILES = 3;

/**
 * Languages present in the repo that mendr does not analyze, most-common first.
 * Bounded: stops after `limit` files so a huge monorepo cannot stall the audit.
 */
export function unanalyzedLanguages(repoPath: string, limit = 20_000): string[] {
  const counts = new Map<string, number>();
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
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      const ext = extname(entry.name).toLowerCase();
      if (ANALYZED.has(ext)) continue;
      const lang = UNANALYZED[ext];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  };
  walk(resolve(repoPath));
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_FILES)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `${lang} (${n} files)`)
    .slice(0, 6);
}
