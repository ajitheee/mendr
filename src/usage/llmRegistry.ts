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
  'quarantined',
  'unverified',
  'unverifiable',
]);

/**
 * Read one of the three safety switches out of raw JSON.
 *
 * FAIL CLOSED ON SILENCE. A present-but-non-boolean value is a hard error (bad
 * data must never be read as trust), and an ABSENT value is `false` — an older
 * or hand-written registry that predates these fields is treated as having
 * proven nothing, which downgrades it to review-only rather than auto-applying
 * on the strength of a field nobody wrote.
 */
function parseSwitch(vo: Record<string, unknown>, field: string, index: number): boolean {
  const raw = vo[field];
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `llm registry entry #${index} has a non-boolean verification.${field}: ${String(raw)}`,
    );
  }
  return raw;
}

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
  const status = vo.status as VerificationStatus;
  if (vo.quarantineReason !== undefined && vo.quarantineReason !== null) {
    if (typeof vo.quarantineReason !== 'string') {
      throw new Error(
        `llm registry entry #${index} has a non-string verification.quarantineReason`,
      );
    }
  }
  const quarantineReason =
    typeof vo.quarantineReason === 'string' && vo.quarantineReason.trim().length > 0
      ? vo.quarantineReason
      : null;
  // A quarantine with no stated cause is an entry nobody can act on: the
  // reviewer cannot tell what to go resolve, and the report has nothing to
  // print under the finding. Rejected at load, not merely flagged in CI.
  if (status === 'quarantined' && quarantineReason === null) {
    throw new Error(
      `llm registry entry #${index} is quarantined with no verification.quarantineReason ` +
        `-- a quarantine must say what has to be resolved`,
    );
  }
  const info: VerificationInfo = {
    status,
    officialSourceConfirmed: parseSwitch(vo, 'officialSourceConfirmed', index),
    replacementConfirmed: parseSwitch(vo, 'replacementConfirmed', index),
    autoApplyAllowed: parseSwitch(vo, 'autoApplyAllowed', index),
    quarantineReason,
  };
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
    // `entryId` is optional (an unstamped entry derives one), but an EMPTY or
    // non-string id is malformed data, not an absent field: it would print as a
    // blank `registry entry:` row and be copied into a command that finds
    // nothing.
    if (e.entryId !== undefined && e.entryId !== null) {
      if (typeof e.entryId !== 'string' || e.entryId.length === 0) {
        throw new Error(`llm registry entry #${index} has a missing/invalid "entryId"`);
      }
    }
    return {
      entryId: (e.entryId ?? undefined) as string | undefined,
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

// --- the prose lint (CI ONLY — never the gate) ------------------------------
//
// HOW THIS USED TO WORK, AND WHY IT DOESN'T ANY MORE. Twelve shipped entries
// carried `verification.status: "verified"` while their OWN
// `verification.reasons` said the opposite -- the worst of them reading,
// verbatim, "Status unknown; likely retired given the rest of the 2.0 line but
// unverified -- DO NOT AUTO-APPLY." The fail-safe was to REGEX THE REASONS at
// gate time and hold the entry back when a marker matched.
//
// That fixed the twelve entries and left the mechanism broken. A safety
// decision computed from English prose is a safety decision that changes when
// someone rewords a sentence, translates it, tidies "unverified" out of a
// caveat, or writes the same warning in words nobody thought to list here. The
// gate now reads STRUCTURED FIELDS only (see isVerified below), and the twelve
// entries are `status: "quarantined"` in the data itself.
//
// The markers survive for ONE job: linting. `mendr validate-registry` fails the
// build when a caveat like this appears in `reasons` on an entry that is
// nonetheless `autoApplyAllowed`. That is a MIGRATION and REVIEW check —
// "somebody wrote a warning and flipped the switch anyway" — and it runs in CI,
// where a false positive costs a human two minutes. It must never be called
// from the fix engine again.

/**
 * Phrases that, appearing anywhere in an entry's own `verification.reasons`,
 * contradict an auto-apply switch. Matched case-insensitively as substrings, so
 * "DO NOT AUTO-APPLY" and "do not auto-apply until verified" both fire.
 *
 * Deliberately blunt: this is a lint, and a false positive costs one entry a
 * manual review. The classifier's own verdicts never trip these — a genuinely
 * verified re-stamp produces only "…is live in a public catalog" / "matches the
 * provider's officially-recommended replacement …" — so every hit is a HUMAN
 * caveat that was written down and then switched on over.
 */
export const SELF_CONTRADICTION_MARKERS: readonly string[] = [
  'do not auto-apply',
  'unverified',
  'status unknown',
  'itself deprecated',
  'not the currently-recommended',
  'stale',
];

/** Which markers (if any) appear in a set of recorded reasons. Pure over text. */
export function selfContradictionMarkersIn(reasons: readonly string[] | undefined): string[] {
  if (!reasons || reasons.length === 0) return [];
  const haystack = reasons.join('\n').toLowerCase();
  return SELF_CONTRADICTION_MARKERS.filter((marker) => haystack.includes(marker));
}

/**
 * Does this entry's recorded reasoning contain a caveat marker?
 *
 * CONSTRAINT: CI/migration use only — {@link validateRegistry} is the sole
 * production caller. The engine gate does not read prose; see isVerified().
 */
export function hasSelfContradictingReasons(entry: LlmModelIdDeprecation): boolean {
  return selfContradictionMarkersIn(entry.verification?.reasons).length > 0;
}

// --- the engine gate (structured fields only) -------------------------------

/**
 * The ENGINE GATE predicate: is a model-id entry trustworthy enough to
 * AUTO-APPLY? The FULL conjunction, and nothing else:
 *
 *   status === 'verified'      the stamped verdict
 *   officialSourceConfirmed    the provider's own docs confirm the deprecation
 *   replacementConfirmed       the replacement is live + uncontradicted
 *   autoApplyAllowed           the switch a human or the stamper may withhold
 *
 * Every clause is a boolean sitting in the registry JSON. No sentence is read,
 * so no rewording can move an entry into or out of Tier A. A missing
 * `verification` block, any other status, or any switch left false (which is
 * what an ABSENT switch parses to — see parseSwitch) all return false.
 */
export function isVerified(entry: LlmModelIdDeprecation): boolean {
  const v = entry.verification;
  return (
    v !== undefined &&
    v.status === 'verified' &&
    v.officialSourceConfirmed &&
    v.replacementConfirmed &&
    v.autoApplyAllowed
  );
}

/**
 * The state the ENGINE acts on, which is not always the state the file claims:
 * the stamp, unless the stamp says `verified` while one of the switches is off,
 * in which case `withheld`.
 *
 * `withheld` should never appear on the shipped registry — the CI validator
 * rejects `verified` over a false switch outright — but the report must be able
 * to NAME the state rather than quietly printing `unverified` over a file that
 * says `verified`. A reader sent to `mendr evidence <id>` by a finding must
 * find the same words there that the finding used.
 */
export function effectiveVerificationState(
  entry: LlmModelIdDeprecation,
): EffectiveVerificationState {
  const stamped = entry.verification?.status ?? 'unstamped';
  if (stamped !== 'verified') return stamped;
  return isVerified(entry) ? 'verified' : 'withheld';
}

/**
 * The switches that are OFF on an entry stamped `verified`, named as fields.
 * What a `withheld` finding prints instead of the old marker list — three field
 * names a reader can go look up beat a quoted fragment of a sentence.
 */
export function withheldSwitches(entry: LlmModelIdDeprecation): string[] {
  const v = entry.verification;
  if (!v) return [];
  return [
    ...(v.officialSourceConfirmed ? [] : ['officialSourceConfirmed']),
    ...(v.replacementConfirmed ? [] : ['replacementConfirmed']),
    ...(v.autoApplyAllowed ? [] : ['autoApplyAllowed']),
  ];
}

/**
 * A fully-populated `verified` block with every switch ON — for FIXTURES and
 * migrations, never for production data.
 *
 * It exists because {@link isVerified} is a four-field conjunction: a test that
 * means "this entry is auto-appliable" has to state all four, and spelling them
 * out at three dozen fixture sites is exactly how one of them gets quietly
 * dropped and a suite starts asserting the wrong tier.
 */
export function autoApplyVerification(
  overrides: Partial<VerificationInfo> = {},
): VerificationInfo {
  return {
    status: 'verified',
    officialSourceConfirmed: true,
    replacementConfirmed: true,
    autoApplyAllowed: true,
    quarantineReason: null,
    ...overrides,
  };
}

/**
 * A `verification` block that is NOT auto-appliable: the given status with
 * every switch off. The counterpart to {@link autoApplyVerification}, so a
 * fixture states its intent in one word instead of four booleans.
 */
export function withheldVerification(
  status: Exclude<VerificationStatus, 'verified'>,
  overrides: Partial<VerificationInfo> = {},
): VerificationInfo {
  return {
    status,
    officialSourceConfirmed: false,
    replacementConfirmed: false,
    autoApplyAllowed: false,
    quarantineReason: status === 'quarantined' ? 'fixture: quarantined' : null,
    ...overrides,
  };
}

// --- provenance (what the footer is allowed to claim) ----------------------
//
// The footer has now been wrong in two different ways, and the second is the
// interesting one:
//   1. `registry: 106 entries, verified 2026-08-18` read as "all 106
//      replacements were fully verified that day" — one date standing in for a
//      verdict it never produced.
//   2. The replacement said `entry verification: 98 verified, ...` and put the
//      12 held-back entries on a separate "held at review" line. Arithmetically
//      true, practically misleading: the number a reader takes away is the one
//      next to the word "verified", and 98 was never the number of things mendr
//      would auto-fix.
// So the footer now leads with the ONE number that matters — how many entries
// can actually be auto-fixed, computed through the same isVerified() the engine
// uses — and puts everything else under `review-only`, broken out by state.
// Every number is COMPUTED from the loaded registry: no constant to forget.

/** Every verdict an entry can carry, including "carries no verdict at all". */
export type EntryVerificationState = VerificationStatus | 'unstamped';

/**
 * What the ENGINE concluded about an entry: its stamp, or `withheld` when the
 * stamp says `verified` and one of the structured switches is off (see
 * {@link effectiveVerificationState}). The extra state exists so a held-back
 * entry is never reported under a word that misdescribes the file.
 */
export type EffectiveVerificationState = EntryVerificationState | 'withheld';

/** What the loaded registry actually says about itself. All counts, no claims. */
export interface RegistryProvenance {
  /** Active `model_id` records — the ones the fix engine can match. */
  activeEntries: number;
  /**
   * Records that clear the FULL engine gate (see {@link isVerified}) and can
   * therefore be auto-fixed. This is the footer's headline number, and it is
   * computed through the very predicate the codemod calls — the count and the
   * behaviour cannot drift apart.
   */
  autoFixEligible: number;
  /**
   * Per-state counts over the records that are NOT auto-fix eligible. Sums to
   * `activeEntries - autoFixEligible` by construction, so the footer's parts
   * always add up to its whole.
   */
  reviewOnlyCounts: Record<EffectiveVerificationState, number>;
  /** Oldest `verification.checkedAt` across stamped entries, if any. */
  oldestCheckedAt?: string;
  /** Newest `verification.checkedAt` across stamped entries, if any. */
  newestCheckedAt?: string;
  /** Entries carrying no recheck date at all — the gap the dates cannot cover. */
  undatedEntries: number;
}

/** The order footer/report surfaces list review-only states in. */
export const REVIEW_ONLY_STATES: readonly EffectiveVerificationState[] = [
  'quarantined',
  'unverified',
  'unverifiable',
  'unstamped',
  // Should never be non-zero on a registry that passed `validate-registry`;
  // listed last so that if it ever is, it prints somewhere defined.
  'withheld',
];

/**
 * Compute the registry's own provenance from the loaded entries. Pure over the
 * registry it is handed, so a test can drive it with a three-entry fixture and
 * get the same arithmetic the shipped 106-record registry gets.
 */
export function registryProvenance(registry: LlmRegistry): RegistryProvenance {
  const entries = modelIdEntries(registry);
  const reviewOnlyCounts: Record<EffectiveVerificationState, number> = {
    verified: 0,
    quarantined: 0,
    unverified: 0,
    unverifiable: 0,
    unstamped: 0,
    withheld: 0,
  };
  let oldest: string | undefined;
  let newest: string | undefined;
  let undated = 0;
  let eligible = 0;
  for (const entry of entries) {
    if (isVerified(entry)) eligible++;
    else reviewOnlyCounts[effectiveVerificationState(entry)]++;
    const checkedAt = entry.verification?.checkedAt;
    // ISO yyyy-mm-dd dates order correctly as strings.
    if (!checkedAt) {
      undated++;
      continue;
    }
    if (!oldest || checkedAt < oldest) oldest = checkedAt;
    if (!newest || checkedAt > newest) newest = checkedAt;
  }
  return {
    activeEntries: entries.length,
    autoFixEligible: eligible,
    reviewOnlyCounts,
    oldestCheckedAt: oldest,
    newestCheckedAt: newest,
    undatedEntries: undated,
  };
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
  // "rechecked", not "verified": this date is the newest CATALOG RECHECK stamp,
  // and says nothing about how many entries came back verified — the same
  // conflation the report footer used to make (see RegistryProvenance).
  return `warning: registry last rechecked ${newest} -- run mendr verify-registry for current data.`;
}
