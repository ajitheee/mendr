import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LlmDeprecation,
  LlmDeprecationKind,
  LlmModelIdDeprecation,
  LlmParamDeprecation,
  LlmRegistry,
} from '../types.js';

// LLM mode: load the hand-maintained deprecations registry that drives literal
// detection. Unlike the Stripe mode (which diffs two live spec snapshots), the
// LLM surface is small and irregular, so a curated JSON registry is the source
// of truth.
//
// The registry ships as `registries/llm-deprecations.json` at the repo root —
// a data asset that `tsc` does NOT copy into `dist/`. Both the dev entrypoint
// (`src/usage/llmRegistry.ts` via tsx) and the built entrypoint
// (`dist/usage/llmRegistry.js`) therefore resolve it by walking UP from this
// module's own directory until a `registries/llm-deprecations.json` is found.
// That is robust to the module living under either `src/` or `dist/`.

const REGISTRY_RELATIVE = join('registries', 'llm-deprecations.json');
const VALID_KINDS: ReadonlySet<LlmDeprecationKind> = new Set([
  'model_id',
  'param_rename',
  'param_removal',
]);

/** Walk up from this module's directory to find the registry JSON on disk. */
function resolveRegistryPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, REGISTRY_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(
    `could not locate ${REGISTRY_RELATIVE} by walking up from ${dirname(fileURLToPath(import.meta.url))}`,
  );
}

/** Require `e[field]` to be a non-empty string; throw a located error if not. */
function requireString(e: Record<string, unknown>, field: string, index: number): string {
  if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
    throw new Error(`llm registry entry #${index} has a missing/invalid "${field}"`);
  }
  return e[field] as string;
}

/** Require `e[field]` to be a non-empty array of non-empty strings. */
function requireStringArray(e: Record<string, unknown>, field: string, index: number): string[] {
  const value = e[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`llm registry entry #${index} has a missing/empty "${field}" array`);
  }
  if (!value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new Error(`llm registry entry #${index} has a non-string value in "${field}"`);
  }
  return value as string[];
}

/**
 * Runtime shape guard: reject a malformed entry rather than mis-fix silently.
 *
 * Validation is per-kind because the three kinds carry different fields:
 * `model_id` needs `deprecated`/`replacement`; the model-coupled param kinds
 * need `param` + `on_models` (and `param_rename` additionally needs
 * `replacement`). A `model_id`-shaped entry lacking `on_models` is fine; a
 * `param_removal` lacking `on_models` is rejected.
 */
function assertDeprecation(entry: unknown, index: number): LlmDeprecation {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`llm registry entry #${index} is not an object`);
  }
  const e = entry as Record<string, unknown>;
  const provider = requireString(e, 'provider', index);
  if (typeof e.kind !== 'string' || !VALID_KINDS.has(e.kind as LlmDeprecationKind)) {
    throw new Error(`llm registry entry #${index} has an invalid "kind": ${String(e.kind)}`);
  }
  if (e.note !== undefined && typeof e.note !== 'string') {
    throw new Error(`llm registry entry #${index} has a non-string "note"`);
  }
  const note = e.note as string | undefined;
  const kind = e.kind as LlmDeprecationKind;

  if (kind === 'model_id') {
    return {
      provider,
      kind,
      deprecated: requireString(e, 'deprecated', index),
      replacement: requireString(e, 'replacement', index),
      note,
    };
  }

  // Both param kinds: `param` + `on_models`. `param_rename` also needs
  // `replacement`; `param_removal` must NOT depend on one.
  const param = requireString(e, 'param', index);
  const on_models = requireStringArray(e, 'on_models', index);
  if (kind === 'param_rename') {
    return {
      provider,
      kind,
      param,
      replacement: requireString(e, 'replacement', index),
      on_models,
      note,
    };
  }
  return { provider, kind, param, on_models, note };
}

/**
 * Load and validate the LLM deprecations registry.
 *
 * @param explicitPath override the on-disk location (used by tests); when
 *        omitted, the registry is discovered relative to this module.
 */
export function loadLlmRegistry(explicitPath?: string): LlmRegistry {
  const path = explicitPath ?? resolveRegistryPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read/parse llm registry at ${path}: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`llm registry at ${path} must be a JSON array`);
  }
  return parsed.map(assertDeprecation);
}

/** The model-id swap entries (value-driven literal replacement). */
export function modelIdEntries(registry: LlmRegistry): LlmModelIdDeprecation[] {
  return registry.filter((d): d is LlmModelIdDeprecation => d.kind === 'model_id');
}

/** The model-coupled param-transform entries (rename + removal). */
export function paramEntries(registry: LlmRegistry): LlmParamDeprecation[] {
  return registry.filter(
    (d): d is LlmParamDeprecation => d.kind === 'param_rename' || d.kind === 'param_removal',
  );
}

/**
 * Does a concrete model id match one of an entry's `on_models` values?
 *
 * A value matches iff the model EQUALS it or STARTS WITH `value + "-"`, so a
 * family token like `"o1"` covers `"o1"`, `"o1-mini"`, and `"o1-2024-12-17"`
 * while never bleeding into an unrelated `"o10"`. Matching is exact-segment,
 * never a loose substring.
 */
export function modelMatches(model: string, onModels: readonly string[]): boolean {
  return onModels.some((value) => model === value || model.startsWith(`${value}-`));
}
