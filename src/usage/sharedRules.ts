/**
 * Is a property-key / declaration name a model-argument name? One definition for
 * the TypeScript, Python and config scanners. Azure deployment keys are
 * deliberately NOT model-like: they route to their own locate surface.
 */
export function isModelLikeName(name: string): boolean {
  return /model/i.test(name);
}

// Rules shared by the TypeScript, Python and config scanners — one source of
// truth so the three languages cannot drift on what is informational and what
// a provider-prefixed selector looks like.

/**
 * Example / sample / demo / documentation trees are INFORMATIONAL. A runnable
 * sample that calls a provider is syntactically real, but it is not a dependency
 * of the shipped product, and rewriting it is never a change worth proposing
 * unattended. External validation (vercel/ai, 2026-09-03): 183 of 186 Tier-A
 * locations were `examples/**` sample apps and the audit concluded
 * "17 retiring AI dependencies" for a package whose product had none.
 *
 * The config scanner already applied this rule; the source scanners did not.
 */
export function isExamplePath(file: string): boolean {
  const p = file.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(examples?|samples?|demos?|docs?|playground|cookbook|tutorials?|__snapshots__)(\/)/.test(p);
}

/** Providers whose `provider/model` and `provider:model` spellings we recognize. */
const PROVIDER_PREFIX =
  /^(openai|anthropic|google|gemini|vertex|vertex_ai|vertexai|azure|azure_openai|bedrock|openrouter|litellm|gateway)[/:](.+)$/i;

/**
 * Split a gateway / registry style selector — `openai/gpt-5-nano`,
 * `google/gemini-2.0-flash`, `openai:gpt-5-mini` — into its provider prefix and
 * the bare model id. The bare id is what the registry knows; the prefix says
 * the request goes through a gateway or a provider registry, which caps the
 * tier at review (the swap target may need a different prefix, and the gateway
 * may not accept the successor).
 *
 * Returns undefined for anything else, so exact-value matching stays exact.
 */
export function splitProviderPrefix(value: string): { prefix: string; id: string } | undefined {
  const m = PROVIDER_PREFIX.exec(value);
  if (!m) return undefined;
  return { prefix: m[1].toLowerCase(), id: m[2] };
}
