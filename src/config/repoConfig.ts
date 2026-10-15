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
  /**
   * A cases file (mendr-eval-cases/v1) that mendr runs itself, on the old and the new model, with
   * the team's own API key (gates/evalCases.ts). The alternative to a command: set one or the other.
   */
  cases?: string;
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
  /**
   * The customer-facing features ("workflows") a migration can touch, and what "still working"
   * means for each after a deploy. mendr does not guess either: the team names the files a feature
   * lives in and the signals that prove it healthy. See assurance/rollout.ts.
   */
  workflows?: WorkflowConfig[];
}

/**
 * How far a signal may move after a deploy before the rollout check calls it a regression.
 * Every field is optional; an absent one takes the default in assurance/rollout.ts.
 */
export interface WorkflowSignals {
  /** Largest acceptable rise in error rate, as a fraction (0.005 = half a percentage point). */
  errorRateMaxIncrease?: number;
  /** Largest acceptable rise in p95 latency, in percent. */
  latencyP95MaxIncreasePct?: number;
  /** Largest acceptable rise in cost per 1,000 calls, in percent. */
  costPer1kMaxIncreasePct?: number;
  /** True when the team's own quality check must be reported for the rollout to count as verified. */
  qualityRequired?: boolean;
}

/** One customer-facing feature: its name, where its code lives, and what healthy means. */
export interface WorkflowConfig {
  /** What the team calls it, e.g. "Answer a support question". */
  name: string;
  /** Repo-relative paths or globs (`src/support/**`) whose code belongs to this feature. */
  paths: string[];
  /** Thresholds for the rollout check. Absent = the defaults. */
  signals?: WorkflowSignals;
  /** Fewest calls after the deploy for a verdict; fewer is inconclusive. Absent = the default. */
  minCalls?: number;
  /**
   * How to find this feature's calls in a telemetry export (`mendr rollout --from`): its service
   * name, and any other fields that must match exactly (a route, an operation name).
   */
  telemetry?: { service?: string; match?: Record<string, string> };
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

  if (raw.workflows !== undefined) {
    config.workflows = parseWorkflows(raw.workflows, path);
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

const SIGNAL_FIELDS = ['errorRateMaxIncrease', 'latencyP95MaxIncreasePct', 'costPer1kMaxIncreasePct', 'qualityRequired'] as const;

/**
 * Parse the `workflows` list. Like `gates`, unknown keys throw: a misspelled threshold would
 * leave a team believing a limit is enforced when the default is being used instead.
 */
function parseWorkflows(value: unknown, path: string): WorkflowConfig[] {
  const example = '{ "workflows": [{ "name": "Answer a support question", "paths": ["src/support/**"] }] }';
  if (!Array.isArray(value)) {
    throw new Error(`${path}: "workflows" must be a list, for example ${example}`);
  }
  const names = new Set<string>();
  return value.map((entry, i) => {
    const at = `${path}: workflow ${i + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be an object with a "name" and "paths", for example ${example}`);
    }
    const w = entry as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!['name', 'paths', 'signals', 'minCalls', 'telemetry'].includes(key)) {
        throw new Error(`${at} has an unknown field "${key}" (allowed: name, paths, signals, minCalls, telemetry)`);
      }
    }
    if (typeof w.name !== 'string' || w.name.trim().length === 0) {
      throw new Error(`${at} needs a "name": what your team calls this feature`);
    }
    const name = w.name.trim();
    if (names.has(name)) throw new Error(`${path}: two workflows are both named "${name}"; each name must be unique`);
    names.add(name);
    if (!Array.isArray(w.paths) || w.paths.length === 0 || w.paths.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
      throw new Error(`${at} ("${name}") needs "paths": a list of the files or globs its code lives in, such as ["src/support/**"]`);
    }
    const out: WorkflowConfig = { name, paths: (w.paths as string[]).map((p) => p.trim()) };
    if (w.minCalls !== undefined) {
      if (typeof w.minCalls !== 'number' || !Number.isInteger(w.minCalls) || w.minCalls < 1) {
        throw new Error(`${at} ("${name}"): "minCalls" must be a whole number of calls, 1 or more, got ${JSON.stringify(w.minCalls)}`);
      }
      out.minCalls = w.minCalls;
    }
    if (w.telemetry !== undefined) {
      const t = w.telemetry as Record<string, unknown>;
      const bad = (): never => {
        throw new Error(
          `${at} ("${name}"): "telemetry" must look like { "service": "support-api", "match": { "http.route": "/answer" } }, with text values`,
        );
      };
      if (typeof t !== 'object' || t === null || Array.isArray(t)) bad();
      for (const k of Object.keys(t)) if (k !== 'service' && k !== 'match') bad();
      if (t.service !== undefined && (typeof t.service !== 'string' || !t.service.trim())) bad();
      if (t.match !== undefined) {
        if (typeof t.match !== 'object' || t.match === null || Array.isArray(t.match)) bad();
        if (Object.values(t.match as Record<string, unknown>).some((v) => typeof v !== 'string')) bad();
      }
      out.telemetry = {
        ...(typeof t.service === 'string' ? { service: t.service.trim() } : {}),
        ...(t.match ? { match: t.match as Record<string, string> } : {}),
      };
    }
    if (w.signals !== undefined) {
      if (typeof w.signals !== 'object' || w.signals === null || Array.isArray(w.signals)) {
        throw new Error(`${at} ("${name}"): "signals" must be an object, such as { "latencyP95MaxIncreasePct": 25 }`);
      }
      const signals: WorkflowSignals = {};
      for (const [field, v] of Object.entries(w.signals as Record<string, unknown>)) {
        if (!(SIGNAL_FIELDS as readonly string[]).includes(field)) {
          throw new Error(`${at} ("${name}"): unknown signal "${field}" (allowed: ${SIGNAL_FIELDS.join(', ')})`);
        }
        if (field === 'qualityRequired') {
          if (typeof v !== 'boolean') throw new Error(`${at} ("${name}"): "signals.qualityRequired" must be true or false`);
          signals.qualityRequired = v;
        } else {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new Error(`${at} ("${name}"): "signals.${field}" must be a number, 0 or more, got ${JSON.stringify(v)}`);
          }
          (signals as Record<string, number>)[field] = v;
        }
      }
      out.signals = signals;
    }
    return out;
  });
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
      } else if (field === 'cases' && name === 'eval') {
        if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
          throw new Error(
            `${path}: "gates.eval.cases" must be the path of your cases file, such as "mendr/eval-cases.json", got ${JSON.stringify(fieldValue)}`,
          );
        }
        parsed.cases = fieldValue.trim();
      } else {
        throw new Error(
          `${path}: unknown field "gates.${name}.${field}" (allowed: ` +
            `${name === 'eval' ? 'required, command, cases' : 'required'})`,
        );
      }
    }
    if (parsed.command && parsed.cases) {
      throw new Error(
        `${path}: "gates.eval" sets both "command" and "cases" -- set one of them (your own eval command, or a cases file mendr runs)`,
      );
    }
    gates[name as GateName] = parsed;
  }
  return gates;
}
