// Tri-state requirement extraction — the recommend-only axis.
//
// Given a live model argument (a `model_arg` literal), what does the SURROUNDING
// call require of any replacement? Read only what the code proves; default to
// `unknown` on anything not fully visible (accuracy over recall). This axis is
// orthogonal to A/B/C tiering — it never passes through classifyOccurrenceTier
// and never emits a TierBReason.
//
// M1 extracts fully for TypeScript (ts-morph gives us the live node). Python
// occurrences are surfaced with all-`unknown` requirements: honest ("we found
// the call but cannot see its options yet"), so a Python usage flags for review
// rather than being mis-analyzed. Full Python extraction is a follow-up.

import { Node, SyntaxKind } from 'ts-morph';
import type {
  CallExpression,
  NoSubstitutionTemplateLiteral,
  ObjectLiteralExpression,
  StringLiteral,
} from 'ts-morph';
import type {
  EndpointFamily,
  ExtractedRequirement,
  RequirementKey,
  RequirementState,
} from './types.js';
import { REQUIREMENT_KEYS } from './types.js';

type ModelLiteral = StringLiteral | NoSubstitutionTemplateLiteral;

/** Is `parent` a value-transparent wrapper around `child`? (mirrors scanLiterals) */
function isValueTransparent(parent: Node, child: Node): boolean {
  if (Node.isParenthesizedExpression(parent)) return true;
  if (Node.isAsExpression(parent)) return true;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    return op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken;
  }
  if (Node.isConditionalExpression(parent)) {
    return parent.getWhenTrue() === child || parent.getWhenFalse() === child;
  }
  return false;
}

/** Climb value-transparent wrappers, returning the highest equivalent-value node. */
function climbTransparent(node: Node): Node {
  let cur = node;
  let parent = cur.getParent();
  while (parent && isValueTransparent(parent, cur)) {
    cur = parent;
    parent = cur.getParent();
  }
  return cur;
}

/**
 * The request-options object literal + enclosing call for a `model_arg` literal
 * of form (a): `create({ model: "…", tools: [...] })`. Undefined for the factory
 * / variable forms, where the request options are not visible at this site.
 */
function enclosingCallArgObject(
  literal: ModelLiteral,
): { object: ObjectLiteralExpression; call: CallExpression } | undefined {
  const climbed = climbTransparent(literal);
  const prop = climbed.getParent();
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const obj = prop.getParent();
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  // Climb the object through value-transparent wrappers to its enclosing call.
  const objClimbed = climbTransparent(obj);
  const parent = objClimbed.getParent();
  if (parent && Node.isCallExpression(parent) && parent.getArguments().includes(objClimbed)) {
    return { object: obj, call: parent };
  }
  return undefined;
}

/** The initializer node of the first property on `obj` whose key is in `names`. */
function propInitializer(obj: ObjectLiteralExpression, names: readonly string[]): Node | undefined {
  for (const name of names) {
    const prop = obj.getProperty(name);
    if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
    if (prop && Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  }
  return undefined;
}

/** Does `obj` carry any property whose key is in `names`? */
function hasProp(obj: ObjectLiteralExpression, names: readonly string[]): boolean {
  return names.some((n) => obj.getProperty(n) !== undefined);
}

/** The last identifier chain of a call's callee, e.g. `client.chat.completions.create`. */
function calleeText(call: CallExpression): string {
  return call.getExpression().getText();
}

/** Resolve the endpoint FAMILY from the call's method chain, or undefined if unrecognized. */
function resolveEndpointFamily(call: CallExpression): EndpointFamily | undefined {
  const text = calleeText(call);
  if (/\.chat\.completions\.create$/.test(text)) return 'chat_completions';
  if (/\.responses\.create$/.test(text)) return 'responses';
  if (/\.messages\.create$/.test(text)) return 'messages';
  if (/generateContent(Stream)?$/.test(text)) return 'gemini_generate';
  return undefined;
}

/** The (unquoted) key name of a property assignment. */
function keyName(pa: import('ts-morph').PropertyAssignment): string {
  const nameNode = pa.getNameNode();
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.getLiteralValue();
  }
  return nameNode.getText();
}

const IMAGE_KEYS = new Set(['image_url', 'input_image', 'inline_data', 'inlineData']);

/**
 * Does the call STRUCTURALLY construct an image content block? Checks property
 * KEYS (and a `type: 'image'` literal), NOT raw source text — so a prompt string
 * that merely mentions `image_url` never forces vision (which would wrongly and
 * silently eliminate text-only candidates). Accuracy over recall: prove it or
 * leave vision `not_observed`.
 */
function hasImageContent(call: CallExpression): boolean {
  for (const pa of call.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = keyName(pa);
    if (IMAGE_KEYS.has(name)) return true;
    if (name === 'type') {
      const init = pa.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        const v = init.getLiteralValue();
        if (v === 'image' || v === 'input_image' || v === 'image_url') return true;
      }
    }
  }
  return false;
}

const req = (
  key: RequirementKey,
  state: RequirementState,
  evidence: string | null,
  extra?: Partial<ExtractedRequirement>,
): ExtractedRequirement => ({ key, state, evidence, ...extra });

/**
 * Extract the tri-state requirement profile for a TypeScript `model_arg` literal.
 * `at` is a "file:line" anchor used in evidence strings.
 */
export function extractRequirementsTs(literal: ModelLiteral, at: string): ExtractedRequirement[] {
  const ctx = enclosingCallArgObject(literal);
  if (!ctx) {
    // Factory/variable form: we see the model but not the request options.
    return unknownRequirements(`${at} — model argument not in a visible request-options object`);
  }
  const { object: obj, call } = ctx;
  const out: ExtractedRequirement[] = [];

  // tools
  out.push(
    hasProp(obj, ['tools'])
      ? req('tools', 'required', `${at} — tools[] passed`)
      : req('tools', 'not_observed', null),
  );

  // vision — STRUCTURAL image-block detection (property keys), never text.
  out.push(
    hasImageContent(call)
      ? req('vision', 'required', `${at} — image content block constructed`)
      : req('vision', 'not_observed', null),
  );

  // jsonStrict
  out.push(
    hasProp(obj, ['response_format', 'responseSchema', 'responseMimeType'])
      ? req('jsonStrict', 'required', `${at} — structured-output param set`)
      : req('jsonStrict', 'not_observed', null),
  );

  // streaming — presence + literal truthiness
  {
    const init = propInitializer(obj, ['stream']);
    if (!init) out.push(req('streaming', 'not_observed', null));
    else if (init.getKind() === SyntaxKind.TrueKeyword) out.push(req('streaming', 'required', `${at} — stream: true`));
    else if (init.getKind() === SyntaxKind.FalseKeyword) out.push(req('streaming', 'not_observed', null));
    else out.push(req('streaming', 'unknown', `${at} — stream set to a non-literal value`));
  }

  // reasoning
  out.push(
    hasProp(obj, ['reasoning_effort', 'reasoning', 'thinking'])
      ? req('reasoning', 'required', `${at} — reasoning/thinking param set`)
      : req('reasoning', 'not_observed', null),
  );

  // minOutputTokens — present + statically-resolvable number
  {
    const init = propInitializer(obj, [
      'max_tokens',
      'max_completion_tokens',
      'maxOutputTokens',
      'max_output_tokens',
      'maxTokens',
    ]);
    if (!init) {
      out.push(req('minOutputTokens', 'not_observed', null));
    } else if (Node.isNumericLiteral(init)) {
      out.push(req('minOutputTokens', 'required', `${at} — output cap ${init.getLiteralValue()}`, { min: init.getLiteralValue() }));
    } else {
      out.push(req('minOutputTokens', 'unknown', `${at} — output cap set to a non-literal value`));
    }
  }

  // endpoint — resolved family from the SDK method
  {
    const family = resolveEndpointFamily(call);
    if (family) out.push(req('endpoint', 'required', `${at} — ${family} call`, { endpointFamily: family }));
    else out.push(req('endpoint', 'unknown', `${at} — endpoint family not resolvable from the call`));
  }

  return out;
}

/** All seven requirements as `unknown` — the honest default for what we cannot see. */
export function unknownRequirements(evidence: string | null): ExtractedRequirement[] {
  return REQUIREMENT_KEYS.map((key) => req(key, 'unknown', evidence));
}

const STRENGTH: Record<RequirementState, number> = { required: 2, unknown: 1, not_observed: 0 };

/**
 * Merge per-occurrence profiles into one, taking the STRONGEST state per key
 * (required > unknown > not_observed): a replacement must satisfy the union of
 * every site's requirements. `min` takes the max floor; a conflicting endpoint
 * family downgrades that requirement to `unknown` (no single family fits).
 */
export function mergeRequirements(perOccurrence: ExtractedRequirement[][]): ExtractedRequirement[] {
  return REQUIREMENT_KEYS.map((key) => {
    const all = perOccurrence.map((occ) => occ.find((r) => r.key === key)).filter((r): r is ExtractedRequirement => !!r);
    if (all.length === 0) return req(key, 'not_observed', null);

    let best = all[0];
    for (const r of all) if (STRENGTH[r.state] > STRENGTH[best.state]) best = r;

    if (best.state !== 'required') return req(key, best.state, best.evidence);

    // For the VALUE-carrying keys, `required` does NOT subsume `unknown`: an
    // occurrence whose floor / endpoint family could not be resolved must keep
    // the merged requirement `unknown` (raise review), or adding an unanalyzable
    // call site would perversely LOWER the safety signal.
    const anyUnknown = all.some((r) => r.state === 'unknown');

    if (key === 'minOutputTokens') {
      if (anyUnknown) {
        return req(key, 'unknown', `${best.evidence} — another call site's output cap could not be resolved`);
      }
      const mins = all.filter((r) => r.state === 'required' && typeof r.min === 'number').map((r) => r.min as number);
      const min = mins.length ? Math.max(...mins) : undefined;
      return req(key, min === undefined ? 'unknown' : 'required', best.evidence, min === undefined ? undefined : { min });
    }
    if (key === 'endpoint') {
      if (anyUnknown) {
        return req(key, 'unknown', `${best.evidence} — another call site's endpoint family could not be resolved`);
      }
      const families = new Set(
        all.filter((r) => r.state === 'required' && r.endpointFamily).map((r) => r.endpointFamily as EndpointFamily),
      );
      if (families.size === 1) return req(key, 'required', best.evidence, { endpointFamily: [...families][0] });
      // Conflicting families across sites: no single family satisfies both.
      return req(key, 'unknown', `${best.evidence} — multiple endpoint families across call sites`);
    }
    // Boolean keys (tools/vision/…): a capability-present candidate safely
    // subsumes an unknown site, so `required` may stand.
    return req(key, 'required', best.evidence);
  });
}
