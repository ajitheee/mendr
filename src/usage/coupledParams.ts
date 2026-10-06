import type { LlmParamDeprecation, LlmRegistry } from '../types.js';

// COUPLED PARAMETERS — why a verified model-id replacement is not yet a safe patch.
//
// A `model_id` entry says "this id dies, put that one there". It says nothing about the
// REQUEST around the id, and swapping a model can change which parameters the request may
// carry. OpenAI's reasoning families are the live example: `gpt-5.6-terra` is the provider's
// own recommended replacement for `gpt-3.5-turbo`, and it rejects `temperature` outright
// ("Only the default (1) value is supported") while requiring `max_completion_tokens` in
// place of `max_tokens`.
//
// The registry carries authoritative rules for SOME of that — `param_rename` and
// `param_removal`, each naming the `on_models` it applies to — and the fix pass applies them
// after the id swap, which is correct. The defect this module closes is the other half:
// where NO rule covers a parameter, the scanner treated that silence as compatibility and
// still called the swap "safe automatic patch". Absence of a rule is not evidence.
//
// The test is deliberately driven by the registry rather than by a hand-kept list of model
// families, so it cannot drift from the data:
//
//   1. Does the REPLACEMENT belong to a family any param rule constrains? (`on_models`)
//      If no rule anywhere mentions a family this replacement is in, nothing is known to be
//      constrained about it and this module says nothing. That is what keeps the guard from
//      firing on every call site that happens to set `temperature`.
//   2. If it does, every model-dependent parameter present at the call site must be covered
//      by an actual rule for that provider and that model. Any that is not is reported by
//      name, and the finding drops to review.
//
// Scope, stated plainly: this is the TypeScript/JavaScript half. `src/python/scanPy.ts` has
// the same blind spot and is not fixed here — see MEASUREMENT / the regression case.

/**
 * Request parameters whose acceptance depends on WHICH model serves the request, rather than
 * on the endpoint. These are the sampling and length controls that OpenAI's reasoning models
 * reject or rename; a key outside this set (`messages`, `stream`, `user`, `metadata`, a
 * tool definition) is not model-dependent in a way that a model swap changes.
 *
 * Kept narrow and evidence-led on purpose. Every entry here is a parameter reported in the
 * wild as rejected or renamed on the gpt-5 / o-series families. Adding a key that is actually
 * portable would push real migrations into the review queue for no reason, which is the
 * failure mode on the other side of this guard.
 */
export const MODEL_DEPENDENT_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'max_tokens',
  'n',
]);

/**
 * The distinctive phrase every coupled-parameter reason carries, so the tier classifier can
 * recognise one without a second channel. A test asserts the generated sentence contains it,
 * so the two cannot drift apart silently.
 */
export const COUPLED_PARAM_SIGNATURE = 'no migration rule covers';

/**
 * The signature of the second case: a rule DOES cover the parameter, but only from the
 * replacement on, so applying it changes what the request does. Its own Tier B reason
 * (`param_behaviour_change`), because "no migration rule covers it" would be false here.
 */
export const PARAM_BEHAVIOUR_SIGNATURE = 'changes what this call asks for';

/** Was this review reason produced by the coupled-parameter guard (no rule covers a parameter)? */
export function isCoupledParamReason(reason: string | undefined): boolean {
  return !!reason && reason.includes(COUPLED_PARAM_SIGNATURE);
}

/** Was this review reason produced because a covering rule changes what the call asks for? */
export function isParamBehaviourReason(reason: string | undefined): boolean {
  return !!reason && reason.includes(PARAM_BEHAVIOUR_SIGNATURE);
}

/** The review reason, as a sentence that names the parameter and points at it. */
export const TS_COUPLED_PARAM_REASON = (replacement: string, params: readonly string[]): string =>
  `the replacement ${replacement} may not accept ${params.length === 1 ? 'the parameter' : 'the parameters'} ${params
    .map((p) => `\`${p}\``)
    .join(', ')} that this call passes, and no migration rule covers ${params.length === 1 ? 'it' : 'them'}: swapping the model id alone could leave a request the provider rejects, so this needs review rather than an automatic patch`;

/** Does `model` fall under one of `on_models`? Exact id or dotted-family prefix. */
function modelInFamily(model: string, onModels: readonly string[]): boolean {
  return onModels.some((f) => model === f || model.startsWith(`${f}-`) || model.startsWith(`${f}.`));
}

/**
 * The param rules that can actually be evaluated: kind matches AND `on_models` is a real list.
 *
 * The `on_models` guard is not defensive decoration. The type declares the field required, but a
 * registry is DATA — hand-authored, operator-supplied via `MENDR_REGISTRY_FILE`, or downloaded —
 * and an entry missing it reached this code and threw `Cannot read properties of undefined`,
 * taking the whole literal scan down with it. In the scanner a throw is the worst available
 * outcome: `audit` exits 1 as a scanner FAILURE, which the CLI documents as the thing never to
 * mistake for clean. A rule with no model scope also cannot be reasoned about — we would not know
 * which models it constrains — so ignoring it is both the safe and the honest answer.
 */
function paramEntries(registry: LlmRegistry): LlmParamDeprecation[] {
  return registry.filter(
    (e): e is LlmParamDeprecation =>
      (e.kind === 'param_rename' || e.kind === 'param_removal') &&
      Array.isArray((e as LlmParamDeprecation).on_models),
  );
}

/**
 * The model-dependent parameters present at this call site that NO registry rule covers for
 * `replacement`, given that `replacement` belongs to a family some rule constrains.
 *
 * Empty result means one of two things, and both are "say nothing": either the replacement's
 * family is not known to constrain any parameter, or every model-dependent parameter at the
 * site already has an authoritative rule that the fix pass will apply after the swap.
 */
export function unresolvedCoupledParams(
  siblingKeys: readonly string[],
  provider: string,
  replacement: string,
  registry: LlmRegistry,
): string[] {
  const params = paramEntries(registry).filter((e) => e.provider === provider);
  // (1) Is anything known to be constrained about this replacement at all?
  const constrainsThisReplacement = params.some((e) => modelInFamily(replacement, e.on_models));
  if (!constrainsThisReplacement) return [];

  // (2) Every model-dependent key at the site needs a rule naming that param AND this model.
  const covered = new Set(
    params.filter((e) => modelInFamily(replacement, e.on_models)).map((e) => e.param),
  );
  return siblingKeys.filter((k) => MODEL_DEPENDENT_PARAMS.has(k) && !covered.has(k));
}

/**
 * The parameter rules a swap from `source` to `replacement` STARTS applying, for parameters this
 * call passes.
 *
 * A covering rule is not the end of the question. One that also covered the source changes
 * nothing about the request. One that covers ONLY the replacement changes what the call asks for,
 * and the providers say so in their own words: OpenAI's `max_completion_tokens` is "An upper bound
 * for the number of tokens that can be generated for a completion, including visible output tokens
 * and reasoning tokens", so `max_tokens: 20` carried onto a reasoning model can come back empty;
 * Anthropic's rule drops a `temperature` the old model honoured. The fix pass still writes the
 * edit, because the request would otherwise be rejected. The swap goes to a person, who can see
 * the value and decide.
 *
 * Found 2026-10-05: before this, `create({ model: 'gpt-3.5-turbo', max_tokens: 20 })` was a Tier A
 * patch to gpt-5.6-terra, verified by tests that mock the API and so cannot see an empty answer.
 */
export function paramRulesStartingAt(
  siblingKeys: readonly string[],
  provider: string,
  source: string,
  replacement: string,
  registry: LlmRegistry,
): LlmParamDeprecation[] {
  return paramEntries(registry).filter(
    (e) =>
      e.provider === provider &&
      siblingKeys.includes(e.param) &&
      modelInFamily(replacement, e.on_models) &&
      !modelInFamily(source, e.on_models),
  );
}

/** The sentence a rule's behaviour change is explained by: its `behaviour` quote, else its `rule` quote. */
function explainingQuote(rule: LlmParamDeprecation): string | undefined {
  const quotes = rule.quotes ?? [];
  return (quotes.find((q) => q.about === 'behaviour') ?? quotes.find((q) => q.about === 'rule'))?.text;
}

/** The review reason for a swap that starts applying parameter rules, quoting the provider. */
export const TS_PARAM_BEHAVIOUR_REASON = (
  source: string,
  replacement: string,
  rules: readonly LlmParamDeprecation[],
): string => {
  const parts = rules.map((rule) => {
    const change =
      rule.kind === 'param_rename'
        ? `\`${rule.param}\` becomes \`${rule.replacement}\``
        : `\`${rule.param}\` is removed`;
    const quote = explainingQuote(rule);
    return quote ? `${change} (${rule.provider}: "${quote}")` : change;
  });
  return (
    `moving from ${source} to ${replacement} ${PARAM_BEHAVIOUR_SIGNATURE}: ${parts.join('; ')}. ` +
    'The value this call sets may no longer do what it did, so a person should check it rather than ' +
    'take an automatic patch'
  );
};
