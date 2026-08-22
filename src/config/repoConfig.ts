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
// The same file also carries the GATE POLICY (`gates`): which of mendr's own
// gates must PASS before a fix may be called Tier A. That is a policy question
// — a fresh CI clone usually cannot run the target repo's tests, while a repo
// that CAN run them may reasonably insist on it — and mendr should not answer
// it with a hardcoded lenience. See gates/policy.ts for the semantics.
//
// Every field is optional: a repo with no mendr.config.json is the normal case
// and behaves exactly as before. A MALFORMED one, however, is a hard error
// naming the file — silently ignoring a config the user wrote (and believes is
// running their eval) would let mendr print "code verified" while the eval they
// configured never executed.

/**
 * One gate's policy. `required` is the only knob most gates have, and it means
 * exactly one thing: this gate must return `pass` before mendr will call a fix
 * Tier A. See gates/policy.ts for what a non-pass then does.
 */
export interface GateConfig {
  /**
   * Must this gate PASS for Tier A? Absent = the built-in default for that
   * gate (see DEFAULT_GATE_REQUIRED in gates/policy.ts), never `false`.
   */
  required?: boolean;
}

/** The eval gate additionally carries the command it runs. */
export interface EvalGateConfig extends GateConfig {
  /**
   * Shell command mendr runs against the PATCHED copy of the repo. Exit 0 =
   * the team's own evaluation passed. Same field as the legacy top-level
   * `evalCommand`, which maps onto this one.
   */
  command?: string;
}

/** The per-gate policy block: `{ "gates": { "tests": { "required": true } } }`. */
export interface GatesConfig {
  typecheck?: GateConfig;
  tests?: GateConfig;
  eval?: EvalGateConfig;
}

/** The `mendr.config.json` a target repo may place at its root. */
export interface RepoConfig {
  /**
   * LEGACY top-level eval command, kept working forever: it predates the
   * `gates` block and CI jobs in the wild set it. It maps onto
   * `gates.eval.command`; setting BOTH to different strings is an error rather
   * than a precedence puzzle nobody can read off the file.
   */
  evalCommand?: string;
  /** Wall-clock budget for the eval command, in milliseconds. */
  evalTimeoutMs?: number;
  /** Per-gate policy. Absent = every gate keeps its built-in default. */
  gates?: GatesConfig;
}

/** The gates a repo may configure. Anything else under `gates` is an error. */
export const CONFIGURABLE_GATES = ['typecheck', 'tests', 'eval'] as const;

/** A gate name a repo may configure. */
export type GateName = (typeof CONFIGURABLE_GATES)[number];

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

  if (raw.gates !== undefined) {
    config.gates = parseGates(raw.gates, path);
  }

  // BOTH spellings of the eval command, disagreeing. Picking a winner silently
  // means one of the two commands the file names never runs, and the reader
  // cannot tell which from the file — so mendr refuses rather than choose.
  const legacy = config.evalCommand;
  const modern = config.gates?.eval?.command;
  if (legacy && modern && legacy !== modern) {
    throw new Error(
      `${path}: "evalCommand" (${JSON.stringify(legacy)}) and "gates.eval.command" ` +
        `(${JSON.stringify(modern)}) disagree -- set one of them (they are the same setting)`,
    );
  }

  return config;
}

/**
 * Parse the `gates` block.
 *
 * UNKNOWN KEYS THROW HERE, unlike at the top level. That asymmetry is
 * deliberate: an unrecognized top-level field is inert forward-compat, but a
 * misspelled gate name (or a misspelled `required`) leaves the user believing a
 * gate is mandatory when mendr is not enforcing it. A policy that silently does
 * not apply is the exact failure this block exists to prevent, so it is louder
 * than the surrounding file.
 */
function parseGates(value: unknown, path: string): GatesConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `${path}: "gates" must be a JSON object (e.g. { "gates": { "tests": { "required": true } } })`,
    );
  }
  const gates: GatesConfig = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(CONFIGURABLE_GATES as readonly string[]).includes(name)) {
      throw new Error(
        `${path}: unknown gate "gates.${name}" (mendr gates: ${CONFIGURABLE_GATES.join(', ')})`,
      );
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${path}: "gates.${name}" must be a JSON object (e.g. { "required": true })`,
      );
    }
    const parsed: EvalGateConfig = {};
    for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      if (field === 'required') {
        if (typeof fieldValue !== 'boolean') {
          throw new Error(
            `${path}: "gates.${name}.required" must be true or false, got ${JSON.stringify(fieldValue)}`,
          );
        }
        parsed.required = fieldValue;
      } else if (field === 'command') {
        // Only the eval gate runs a command the repo supplies. `typecheck` and
        // `tests` are mendr's own; accepting a command there would read as a
        // way to override them and would do nothing.
        if (name !== 'eval') {
          throw new Error(
            `${path}: "gates.${name}.command" is not supported -- only "gates.eval" takes a command`,
          );
        }
        if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
          throw new Error(
            `${path}: "gates.eval.command" must be a non-empty string (e.g. "npm run eval"), got ${JSON.stringify(fieldValue)}`,
          );
        }
        parsed.command = fieldValue.trim();
      } else {
        throw new Error(
          `${path}: unknown field "gates.${name}.${field}" (allowed: ` +
            `${name === 'eval' ? 'required, command' : 'required'})`,
        );
      }
    }
    gates[name as GateName] = parsed;
  }
  return gates;
}
