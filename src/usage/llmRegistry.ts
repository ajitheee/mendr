import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmDeprecation, LlmDeprecationKind, LlmRegistry } from '../types.js';

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
const VALID_KINDS: ReadonlySet<LlmDeprecationKind> = new Set(['model_id', 'param_rename']);

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

/** Runtime shape guard: reject a malformed entry rather than mis-fix silently. */
function assertDeprecation(entry: unknown, index: number): LlmDeprecation {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`llm registry entry #${index} is not an object`);
  }
  const e = entry as Record<string, unknown>;
  for (const field of ['provider', 'deprecated', 'replacement'] as const) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      throw new Error(`llm registry entry #${index} has a missing/invalid "${field}"`);
    }
  }
  if (typeof e.kind !== 'string' || !VALID_KINDS.has(e.kind as LlmDeprecationKind)) {
    throw new Error(`llm registry entry #${index} has an invalid "kind": ${String(e.kind)}`);
  }
  if (e.note !== undefined && typeof e.note !== 'string') {
    throw new Error(`llm registry entry #${index} has a non-string "note"`);
  }
  return {
    provider: e.provider as string,
    kind: e.kind as LlmDeprecationKind,
    deprecated: e.deprecated as string,
    replacement: e.replacement as string,
    note: e.note as string | undefined,
  };
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

/** The subset of the registry Mendr can auto-fix today (model-id swaps). */
export function modelIdEntries(registry: LlmRegistry): LlmDeprecation[] {
  return registry.filter((d) => d.kind === 'model_id');
}
