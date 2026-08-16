// Registry verification — normalization & matching.
//
// This is ~90% of the risk in verifying a deprecated -> replacement mapping
// against public model catalogs: the same model wears many spellings across the
// registry, OpenRouter, and models.dev. All comparison in verify.ts flows
// through the helpers here so the rules are applied identically to BOTH sides.
//
// Spellings we reconcile (learned from the registry-verify spike):
//   - provider namespace       `anthropic/claude-sonnet-4.6`  (OpenRouter)
//   - alias marker             `~openai/gpt-4o`               (OpenRouter "~")
//   - variant suffixes         `…:batch`, `…:free`, `…:thinking`
//   - version separators       `claude-sonnet-4.6` vs `claude-sonnet-4-6`
//   - bare alias <-> dated     `claude-haiku-4-5` vs `claude-haiku-4-5-20251001`
//   - out-of-class ids         `text-moderation-latest` (catalogs don't list it)

/** A coarse model-capability class, inferred from an id's spelling. */
export type ModelClass = 'chat' | 'moderation' | 'image' | 'audio' | 'tts' | 'embedding';

/**
 * Classes that public model catalogs (models.dev, OpenRouter) DO NOT enumerate,
 * so a replacement in one of these classes cannot be catalog-verified. A miss is
 * therefore "unverifiable", never "wrong".
 */
const OUT_OF_CLASS: ReadonlySet<ModelClass> = new Set<ModelClass>([
  'moderation',
  'image',
  'audio',
  'tts',
]);

/**
 * Canonicalize a raw model id to the single spelling everything compares against:
 *   lowercase/trim -> drop `~` alias marker -> drop `:suffix` variant ->
 *   drop `provider/` namespace -> replace `.` with `-`.
 *
 * Applied to BOTH the registry ids AND the oracle ids, so the canonical form is
 * internally consistent even if it is not any provider's "official" spelling.
 */
export function canonicalizeId(rawId: string): string {
  let s = String(rawId).trim().toLowerCase();
  if (s.startsWith('~')) s = s.slice(1); // OpenRouter alias marker
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon); // :batch / :free / :thinking
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1); // provider namespace
  return s.replace(/\./g, '-').trim(); // unify version separators
}

/**
 * The FAMILY of an id: its canonical form with a trailing dated-snapshot segment
 * removed (`-YYYYMMDD` or `-YYYY-MM-DD`). This is what lets a bare alias match a
 * dated snapshot of the same model — `claude-haiku-4-5` and
 * `claude-haiku-4-5-20251001` share the family `claude-haiku-4-5`.
 *
 * Only an 8-digit or ISO date suffix is stripped; short `-0613`-style MMDD tags
 * are deliberately left intact (too ambiguous to collapse safely).
 */
export function familyOf(id: string): string {
  return canonicalizeId(id)
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

/** Exact canonical equality (identity check — used for "is this THE recommended id"). */
export function idsEqual(a: string, b: string): boolean {
  return canonicalizeId(a) === canonicalizeId(b);
}

/** Family-level equality (bare alias <-> dated snapshot of the same model). */
export function idsFamilyMatch(a: string, b: string): boolean {
  return familyOf(a) === familyOf(b);
}

/**
 * Is `id` present in a set of live catalog ids? The set is expected to hold BOTH
 * the canonical form AND the family form of every catalog id (see
 * oracles.ts#addLiveId), so a bare-vs-dated difference on either side still
 * resolves to a hit via a plain set membership test.
 */
export function isLiveId(id: string, liveIds: ReadonlySet<string>): boolean {
  return liveIds.has(canonicalizeId(id)) || liveIds.has(familyOf(id));
}

/**
 * Infer a model's capability class from its id. Curated substrings, precision
 * over recall: `vision` is intentionally NOT treated as image (it is multimodal
 * chat, which catalogs DO list, e.g. `gpt-4o`). Unknown spellings default to
 * `chat` — the verifiable class — so we only ever mark something unverifiable on
 * a POSITIVE out-of-class signal.
 */
export function inferModelClass(id: string): ModelClass {
  const c = canonicalizeId(id);
  if (/moderation/.test(c)) return 'moderation';
  if (/embedding|(^|-)embed(-|$)/.test(c)) return 'embedding';
  if (/(^|-)tts(-|$)|text-to-speech/.test(c)) return 'tts';
  if (/whisper|transcribe|(^|-)audio(-|$)|speech-to-text/.test(c)) return 'audio';
  if (/dall-e|dalle|imagen|stable-diffusion|sdxl|gpt-image|(^|-)image(-|$)/.test(c)) return 'image';
  return 'chat';
}

/** Can a model of this class be verified against public catalogs at all? */
export function isCatalogVerifiableClass(cls: ModelClass): boolean {
  return !OUT_OF_CLASS.has(cls);
}
