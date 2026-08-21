import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The TARGET repo's own mendr config — not mendr's.
//
// WHY THIS FILE EXISTS: every gate mendr ships judges CODE (it compiles, it
// parses, your tests pass). None of them can judge whether the REPLACEMENT
// MODEL behaves like the one it replaced, and mendr must not invent a quality
// metric to pretend otherwise. The only party who knows what "still behaves"
// means for a given product is the team that owns it — so mendr does not
// define the check, it RUNS THEIRS. This config is where they name it.
//
// Every field is optional: a repo with no mendr.config.json is the normal case
// and behaves exactly as before. A MALFORMED one, however, is a hard error
// naming the file — silently ignoring a config the user wrote (and believes is
// running their eval) would let mendr print "code verified" while the eval they
// configured never executed.

/** The `mendr.config.json` a target repo may place at its root. */
export interface RepoConfig {
  /**
   * Shell command mendr runs against the PATCHED copy of the repo, in a
   * throwaway workspace. Exit 0 = the team's own evaluation passed.
   */
  evalCommand?: string;
  /** Wall-clock budget for `evalCommand`, in milliseconds. */
  evalTimeoutMs?: number;
}

/** The filename read from the target repo root. */
export const REPO_CONFIG_FILENAME = 'mendr.config.json';

/**
 * Default eval budget: 10 minutes. Evals are not unit tests — a real one calls
 * a live model over a fixture set, so the test gate's 2-minute budget would
 * time out honest runs.
 */
export const DEFAULT_EVAL_TIMEOUT_MS = 600_000;

/** Where loadRepoConfig() looks for the config in a given repo. */
export function repoConfigPath(repoPath: string): string {
  return join(repoPath, REPO_CONFIG_FILENAME);
}

/**
 * Load and validate `<repoPath>/mendr.config.json`.
 *
 * Returns `{}` when the file does not exist (the common case). THROWS with the
 * full path when the file exists but is unreadable, is not JSON, is not a JSON
 * object, or carries a field of the wrong type — see the file header for why a
 * broken config is never silently ignored.
 */
export function loadRepoConfig(repoPath: string): RepoConfig {
  const path = repoConfigPath(repoPath);
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object (e.g. { "evalCommand": "npm run eval" })`);
  }

  const raw = parsed as Record<string, unknown>;
  const config: RepoConfig = {};

  if (raw.evalCommand !== undefined) {
    if (typeof raw.evalCommand !== 'string' || raw.evalCommand.trim().length === 0) {
      throw new Error(
        `${path}: "evalCommand" must be a non-empty string (e.g. "npm run eval"), got ${JSON.stringify(raw.evalCommand)}`,
      );
    }
    config.evalCommand = raw.evalCommand.trim();
  }

  if (raw.evalTimeoutMs !== undefined) {
    // A zero/negative/NaN timeout would either kill the eval instantly or run
    // it unbounded — both are worse than telling the author the value is wrong.
    if (
      typeof raw.evalTimeoutMs !== 'number' ||
      !Number.isFinite(raw.evalTimeoutMs) ||
      raw.evalTimeoutMs <= 0
    ) {
      throw new Error(
        `${path}: "evalTimeoutMs" must be a positive number of milliseconds, got ${JSON.stringify(raw.evalTimeoutMs)}`,
      );
    }
    config.evalTimeoutMs = raw.evalTimeoutMs;
  }

  return config;
}
