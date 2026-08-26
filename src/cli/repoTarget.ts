// Repo-target helpers, shared by every command that takes a repoPath-or-URL.
//
// These were module-private inside cli.ts; recommend needs them too, so they are
// hoisted here and EXPORTED. Behaviour is byte-identical to the originals —
// fix-llm and watch import them from here unchanged (pinned by the recommend
// non-regression test).

import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';

/** Is the target a remote git URL (GitHub link etc.) rather than a local path? */
export function isRemoteRepoUrl(target: string): boolean {
  return /^(https?:\/\/|git@)/i.test(target);
}

/**
 * A URL is shallow-cloned into a throwaway temp dir and analyzed there — the real
 * repo is never touched. --write is refused for URLs, since it would only edit
 * the temp copy.
 */
export async function cloneRemoteOrExit(url: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), 'mendr-clone-'));
  // Progress goes to STDERR: with --json, stdout must carry only the report.
  console.error(`Cloning ${url} (shallow, read-only copy)...`);
  try {
    await simpleGit().clone(url, dest, ['--depth', '1']);
  } catch (err) {
    console.error(
      `mendr: could not clone ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  return dest;
}

/** Resolve a repo path, exiting non-zero if it is missing or not a directory. */
export function resolveRepoOrExit(repoPath: string): string {
  const resolved = resolve(repoPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`mendr: path not found or not a directory: ${repoPath}`);
    process.exit(2);
  }
  return resolved;
}

/**
 * Guard the dangerous FALSE-CLEAN case: a mistyped path, an unreadable language,
 * or a tsconfig whose `include` matched nothing loads 0 analyzable files, which
 * a user cannot tell apart from a genuinely clean repo. Fail loudly — but only
 * when BOTH languages come up empty (a pure-Python repo has 0 TS files).
 */
export function assertAnalyzable(tsFileCount: number, pyFileCount: number, resolved: string): void {
  if (tsFileCount === 0 && pyFileCount === 0) {
    console.error(
      `mendr: found no analyzable source files under ${resolved}.\n` +
        `mendr can read TypeScript (.ts/.tsx/.mts/.cts) and Python (.py) — is this the repo root?`,
    );
    process.exit(2);
  }
}
