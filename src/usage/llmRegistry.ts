import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EvidenceRef,
  LlmDeprecation,
  LlmDeprecationKind,
  LlmModelIdDeprecation,
  LlmParamDeprecation,
  LlmRegistry,
  ModelLifecycle,
  VerificationInfo,
  VerificationStatus,
} from '../types.js';
import { EVIDENCE_EXCERPT_MAX_CHARS } from '../types.js';

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

/** `sha256:` + 64 lowercase hex. Anything else is not a hash we produced. */
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * The date the shipped registry was last verified against the public oracles
 * (`mendr verify-registry --write` stamps per-entry `verification.checkedAt`;
 * this constant is the human headline for the CLI's report footer). Update it
 * whenever a re-verification is stamped into the registry JSON.
 */
export const REGISTRY_VERIFIED_AT = '2026-08-18';
const VALID_KINDS: ReadonlySet<LlmDeprecationKind> = new Set([
  'model_id',
  'param_rename',
  'param_removal',
]);

/**
 * Walk up from this module's directory to find a shipped `registries/` asset.
 * Shared by every registry-adjacent data file (the active registry, the
 * candidate queue, the evidence snapshot directory) so they are all discovered
 * by the SAME rule under both `src/` (tsx) and `dist/` (built).
 */
export function resolveRegistryAsset(relative: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(
    `could not locate ${relative} by walking up from ${dirname(fileURLToPath(import.meta.url))}`,
  );
}

/** Walk up from this module's directory to find the registry JSON on disk. */
export function resolveRegistryPath(): string {
  return resolveRegistryAsset(REGISTRY_RELATIVE);
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

const VALID_STATUSES: ReadonlySet<VerificationStatus> = new Set([
  'verified',
  'unverified',
  'unverifiable',
]);

/**
 * Parse the optional `verification` block on a `model_id` entry. Absent is fine
 * (treated as unverified by the gate). A present-but-malformed block is a hard
 * error — a bad status must never be silently read as `verified`.
 */
function parseVerification(
  e: Record<string, unknown>,
  index: number,
): VerificationInfo | undefined {
  const v = e.verification;
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null) {
    throw new Error(`llm registry entry #${index} has a non-object "verification"`);
  }
  const vo = v as Record<string, unknown>;
  if (!VALID_STATUSES.has(vo.status as VerificationStatus)) {
    throw new Error(
      `llm registry entry #${index} has an invalid verification.status: ${String(vo.status)}`,
    );
  }
  const info: VerificationInfo = { status: vo.status as VerificationStatus };
  if (vo.checkedAt !== undefined) {
    if (typeof vo.checkedAt !== 'string') {
      throw new Error(`llm registry entry #${index} has a non-string verification.checkedAt`);
    }
    info.checkedAt = vo.checkedAt;
  }
  for (const field of ['sources', 'reasons'] as const) {
    if (vo[field] === undefined) continue;
    if (!Array.isArray(vo[field]) || !(vo[field] as unknown[]).every((s) => typeof s === 'string')) {
      throw new Error(`llm registry entry #${index} has a non-string[] verification.${field}`);
    }
    info[field] = vo[field] as string[];
  }
  return info;
}

/**
 * Parse the optional `evidence` array on a `model_id` entry.
 *
 * Same posture as {@link parseVerification}: absent is fine (hand-seeded entry,
 * no proof attached), but present-and-malformed is a HARD error. Evidence is
 * the audit trail a reviewer trusts; a half-parsed EvidenceRef would let a
 * broken hash or a truncated url read as provenance. `[]` is rejected too — it
 * claims evidence and carries none.
 */
function parseEvidence(e: Record<string, unknown>, index: number): EvidenceRef[] | undefined {
  const raw = e.evidence;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`llm registry entry #${index} has a non-array "evidence"`);
  }
  if (raw.length === 0) {
    throw new Error(`llm registry entry #${index} has an empty "evidence" array`);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`llm registry entry #${index} evidence[${i}] is not an object`);
    }
    const ev = item as Record<string, unknown>;
    for (const field of ['sourceUrl', 'contentHash', 'retrievedAt'] as const) {
      if (typeof ev[field] !== 'string' || (ev[field] as string).length === 0) {
        throw new Error(
          `llm registry entry #${index} evidence[${i}] has a missing/invalid "${field}"`,
        );
      }
    }
    if (!CONTENT_HASH_RE.test(ev.contentHash as string)) {
      throw new Error(
        `llm registry entry #${index} evidence[${i}] has a malformed contentHash ` +
          `(expected "sha256:<64 hex>"): ${String(ev.contentHash)}`,
      );
    }
    const ref: EvidenceRef = {
      sourceUrl: ev.sourceUrl as string,
      contentHash: ev.contentHash as string,
      retrievedAt: ev.retrievedAt as string,
    };
    if (ev.excerpt !== undefined) {
      if (typeof ev.excerpt !== 'string') {
        throw new Error(`llm registry entry #${index} evidence[${i}] has a non-string "excerpt"`);
      }
      if (ev.excerpt.length > EVIDENCE_EXCERPT_MAX_CHARS) {
        throw new Error(
          `llm registry entry #${index} evidence[${i}] has an excerpt of ${ev.excerpt.length} ` +
            `chars (max ${EVIDENCE_EXCERPT_MAX_CHARS}) -- an excerpt is a quote, not a copy of the page`,
        );
      }
      ref.excerpt = ev.excerpt;
    }
    return ref;
  });
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
export function assertDeprecation(entry: unknown, index: number): LlmDeprecation {
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
    // Optional lifecycle fields (from the provider's own deprecation pages).
    // A present-but-malformed value is a hard error, same posture as the
    // verification block — bad data must never be silently read as trusted.
    if (e.status !== undefined && e.status !== 'retired' && e.status !== 'deprecated') {
      throw new Error(`llm registry entry #${index} has an invalid "status": ${String(e.status)}`);
    }
    for (const field of ['shutdownDate', 'sourceUrl'] as const) {
      if (e[field] !== undefined && e[field] !== null && typeof e[field] !== 'string') {
        throw new Error(`llm registry entry #${index} has a non-string "${field}"`);
      }
    }
    return {
      provider,
      kind,
      deprecated: requireString(e, 'deprecated', index),
      replacement: requireString(e, 'replacement', index),
      status: (e.status ?? undefined) as ModelLifecycle | undefined,
      shutdownDate: (e.shutdownDate ?? undefined) as string | undefined,
      sourceUrl: (e.sourceUrl ?? undefined) as string | undefined,
      note,
      verification: parseVerification(e, index),
      evidence: parseEvidence(e, index),
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

/**
 * The ENGINE GATE predicate: is a model-id entry trustworthy enough to
 * AUTO-APPLY? True iff it carries a `verification.status === 'verified'` stamp.
 * A missing stamp (`unstamped`), `unverified`, or `unverifiable` all return
 * false — the codemod must never swap on the strength of an unproven mapping.
 */
export function isVerified(entry: LlmModelIdDeprecation): boolean {
  return entry.verification?.status === 'verified';
}

/** Days after which the registry's newest verification stamp counts as stale. */
export const REGISTRY_STALE_DAYS = 30;

/**
 * Freshness guard: model catalogs churn monthly, so a registry whose NEWEST
 * `verification.checkedAt` is more than {@link REGISTRY_STALE_DAYS} days old
 * may be recommending replacements that have themselves moved on. Returns the
 * one-line warning to print, or undefined when the registry is fresh (or
 * carries no stamps at all — the per-entry engine gate already blocks those).
 */
export function staleRegistryWarning(
  registry: LlmRegistry,
  now = new Date(),
): string | undefined {
  let newest: string | undefined;
  for (const entry of modelIdEntries(registry)) {
    const checkedAt = entry.verification?.checkedAt;
    // ISO yyyy-mm-dd dates order correctly as strings.
    if (checkedAt && (!newest || checkedAt > newest)) newest = checkedAt;
  }
  if (!newest) return undefined;
  const ageMs = now.getTime() - new Date(`${newest}T00:00:00Z`).getTime();
  if (Number.isNaN(ageMs) || ageMs <= REGISTRY_STALE_DAYS * 24 * 60 * 60 * 1000) {
    return undefined;
  }
  return `warning: registry last verified ${newest} -- run mendr verify-registry for current data.`;
}
