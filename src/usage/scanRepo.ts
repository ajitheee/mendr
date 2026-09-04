import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  Project,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  ts,
} from 'ts-morph';
import type { LlmRegistry, UsageMap } from '../types.js';
import { modelIdEntries, paramEntries } from './llmRegistry.js';
import { isTestPath } from './scanLiterals.js';
import { buildUsageMap } from './usageMap.js';

// Phase 2: load a target TypeScript repo with ts-morph so its own installed
// types (its `stripe` package, local interfaces, etc.) resolve, then hand the
// loaded Project off to the usage-map builder.

/**
 * Load a ts-morph `Project` for the target repo.
 *
 * Preferred path: use the repo's own `tsconfig.json` so module resolution and
 * the repo's installed dependency types (its `stripe`) are exactly what the repo
 * itself sees. If no tsconfig is present we degrade gracefully to a glob load
 * with sensible NodeNext compiler options.
 */
export function loadProject(repoPath: string): Project {
  const abs = resolve(repoPath);
  const tsConfigFilePath = join(abs, 'tsconfig.json');

  if (existsSync(tsConfigFilePath)) {
    // ts-morph adds every source file referenced by the tsconfig `include`.
    const fromConfig = new Project({ tsConfigFilePath });
    // A solution-style tsconfig (only "references", no "include") loads ZERO
    // source files. Returning that empty project would read as "nothing to
    // scan", so fall through to the glob loader instead.
    if (countAnalyzableSourceFiles(fromConfig) > 0) {
      return fromConfig;
    }
  }

  // Fallback: no (usable) tsconfig. Add TS/TSX files by glob under sane defaults. We
  // include .tsx/.mts/.cts (not just .ts) because the LLM beachhead is full of
  // React/Next (.tsx) apps — scanning `.ts` only silently missed them. `jsx` is
  // set so .tsx parses without a spurious "Cannot use JSX" diagnostic.
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
  });
  project.addSourceFilesAtPaths([
    join(abs, '**/*.{ts,tsx,mts,cts}'),
    `!${join(abs, '**/node_modules/**')}`,
    `!${join(abs, '**/*.d.ts')}`,
  ]);
  return project;
}

// --- fix-llm pre-filter -----------------------------------------------------
//
// A full ts-morph load parses EVERY source file, but on a real repo only a
// handful of files even CONTAIN a registry token — LibreChat is ~900 files and
// two hits. So fix-llm walks the repo itself, text-tests each file against one
// compiled regex of every registry token, and builds its scan Project from the
// hit files ONLY. The literal scan matches EXACT registry values and the param
// scan needs a same-file resolvable model that starts with an `on_models`
// prefix, so a file with a finding almost always carries one of the regex's
// tokens VERBATIM in its raw text. A regex FALSE positive just means one extra
// file gets parsed.
//
// KNOWN LIMITATION (accepted, near-zero likelihood): findModelIdLiterals matches
// on the DECODED literal value (`node.getLiteralValue()`), but this pre-filter
// tests the RAW file bytes. A model id written with a string escape — e.g.
// `const m = "\x67pt-4"`, which decodes to "gpt-4" — matches the scan yet NOT
// the raw-text regex, so that file is skipped and the id is silently missed.
// Real code never hex/unicode-escapes a model id, and dropping the pre-filter to
// close the gap would reintroduce the multi-second / OOM full-parse it exists to
// avoid (that's the whole reason it's here), so we keep the filter and accept the
// gap. Python is NOT affected: scanPy matches on a raw slice of the file text
// (`plainStringContent`), so its matched value is a substring of the bytes this
// filter tests, by construction.

/**
 * Directory names the fix-llm walker never descends into: vendored code,
 * build output, and coverage artifacts. Test FILES are skipped via
 * `isTestPath` — the same rule the literal scan applies — so the walked total
 * and the scan agree on scope by construction.
 */
const SCAN_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
]);

/**
 * Every scannable {ts,tsx,mts,cts} file under `repoPath`: the ONE walker behind
 * the fix-llm scan scope, its "Scanned N source files" count, AND
 * `findUncoveredSourceFiles` — a single source of truth so the printed counts
 * can never disagree with what was actually visited.
 */
/**
 * How many {ts,tsx,mts,cts} files under `repoPath` the scan SKIPS as test
 * support. Disclosed in coverage: external validation found the skipped count
 * (LibreChat 1,219 of 3,568) was invisible, so "N files scanned" overstated reach.
 */
export function countTsTestFiles(repoPath: string): number {
  const abs = resolve(repoPath);
  let count = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        isTestPath(full)
      ) {
        count++;
      }
    }
  };
  walk(abs);
  return count;
}

export function collectTsSourceFiles(repoPath: string): string[] {
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
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !isTestPath(full)
      ) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

/**
 * One compiled regex matching every registry token that could possibly anchor
 * a finding: each `model_id` deprecated value, plus each param entry's
 * `on_models` prefix (a param site requires a same-file model literal that
 * equals or starts with one of those). Plain substring alternation — false
 * positives only cost a parse. Returns undefined for a token-less registry.
 */
export function buildRegistryPrefilter(registry: LlmRegistry): RegExp | undefined {
  const tokens = new Set<string>();
  for (const dep of modelIdEntries(registry)) tokens.add(dep.deprecated);
  for (const param of paramEntries(registry)) {
    for (const model of param.on_models) tokens.add(model);
  }
  if (tokens.size === 0) return undefined;
  const escaped = [...tokens].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'));
}

/** A pre-filtered fix-llm scan project plus the honest coverage counts. */
export interface PrefilteredScan {
  /** Project containing ONLY the files that matched the pre-filter. */
  project: Project;
  /** Total files the walker visited (the honest "Scanned N" number). */
  totalFiles: number;
  /** How many of those matched the registry pre-filter and were parsed. */
  matchedFiles: number;
}

/**
 * Build the fix-llm scan Project: walk the repo, keep only files whose TEXT
 * contains a registry token, and parse just those. The Stripe commands still
 * use {@link loadProject} — their locator is type-driven and needs the repo's
 * own tsconfig/module resolution; this pre-filter is value-driven like the
 * scan it feeds.
 */
export function loadPrefilteredProject(
  repoPath: string,
  prefilter: RegExp | undefined,
): PrefilteredScan {
  const files = collectTsSourceFiles(repoPath);
  const hits: string[] = [];
  if (prefilter) {
    for (const file of files) {
      try {
        if (prefilter.test(readFileSync(file, 'utf8'))) hits.push(file);
      } catch {
        // Unreadable file: counted as walked, cannot be scanned. Same
        // permissions edge case the Python reader tolerates.
      }
    }
  }
  // Same compiler options as the no-tsconfig fallback loader: the literal +
  // param locators are syntax-driven (no cross-file type resolution), so the
  // repo's own tsconfig adds nothing but load time here.
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
  });
  for (const file of hits) project.addSourceFileAtPath(file);
  return { project, totalFiles: files.length, matchedFiles: hits.length };
}

/**
 * Count the source files Mendr can actually analyze in a loaded project — real
 * source, not declaration files or anything under node_modules. Used to tell a
 * genuinely-clean repo apart from "we scanned nothing" (wrong path, JS-only
 * repo, a tsconfig whose `include` matched zero files).
 */
export function countAnalyzableSourceFiles(project: Project): number {
  return project
    .getSourceFiles()
    .filter(
      (sf) => !sf.isDeclarationFile() && !sf.getFilePath().includes('/node_modules/'),
    ).length;
}

/**
 * The {ts,tsx,mts,cts} files under `repoPath` that the loaded `project` does
 * NOT contain — real TypeScript source a tsconfig-driven load silently skips.
 * Returned repo-relative so a caller can print an honest coverage warning.
 *
 * Enumerates the disk through {@link collectTsSourceFiles} — the SAME walker
 * behind the fix-llm scan — so any coverage number derived here can never
 * disagree with the scan's own counts. (fix-llm itself no longer needs this
 * warning: its walker-driven pre-filter sees every file on disk by
 * construction; this remains for tsconfig-driven flows.)
 */
export function findUncoveredSourceFiles(project: Project, repoPath: string): string[] {
  const abs = resolve(repoPath);
  // Compare with forward slashes, case-insensitively: ts-morph standardizes its
  // paths, and Windows paths can differ in slash direction / drive-letter case.
  const canonical = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const covered = new Set(project.getSourceFiles().map((sf) => canonical(sf.getFilePath())));

  return collectTsSourceFiles(abs)
    .filter((full) => !covered.has(canonical(full)))
    .map((full) => relative(abs, full).replace(/\\/g, '/'));
}

/** Convenience: load a repo and build its Stripe usage map in one call. */
export function scanRepo(repoPath: string): UsageMap {
  return buildUsageMap(loadProject(repoPath));
}
