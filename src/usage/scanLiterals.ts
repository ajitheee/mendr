import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, NoSubstitutionTemplateLiteral, Project, StringLiteral } from 'ts-morph';
import type {
  LlmModelIdDeprecation,
  LlmRegistry,
  SourceLocation,
  VerificationStatus,
} from '../types.js';
import { isVerified, modelIdEntries } from './llmRegistry.js';

// LLM mode — locate.
//
// The Stripe mode resolves TYPED property accesses through the type checker
// (see resolveStripe.ts). LLM breakages have no such type anchor: a model id is
// just a bare string literal (`model: "gemini-2.0-flash"`). So this locator is
// value-driven — it finds every string/template literal whose VALUE EXACTLY
// equals a registry `model_id` `deprecated` token.
//
// Precision (accuracy over recall, matching the Stripe philosophy):
//   - EXACT value equality only, never substring. A longer literal like
//     "gemini-2.0-flash-notes" has a different value, so it does NOT match.
//   - Only string-literal kinds are visited (StringLiteral +
//     NoSubstitutionTemplateLiteral). Text inside a `// comment` is a trivia
//     token, not a literal node, so it is never scanned and never matched.
//   - Interpolated template literals (`\`...${x}...\``) are intentionally NOT
//     matched: their value is not a fixed compile-time string.
//
// KNOWN LIMITATION: this only sees literal model ids written inline. A model id
// read from an env var, a shared constant referenced by name, or built by
// string concatenation is invisible here (it is not a matching literal node).
// That is a deliberate accuracy-over-recall trade: we never guess through a
// value we cannot see verbatim.
//
// CALL-SITE AWARENESS (why a value match is not enough):
//   An exact value match tells us the STRING is a retired model id, but NOT that
//   the string is being used AS a live model argument. The very same literal is
//   routinely DATA: a pricing-table key, a tokenizer/encoding list entry, a
//   model-picker array element, a normalization-map key. Blindly swapping those
//   corrupts code (duplicate object keys) or semantics. So every match is
//   CLASSIFIED by its AST position (see `classifyLiteralPosition`): only literals
//   sitting in a genuine model-argument position are `model_arg` (safe to swap);
//   everything else is `data` (surfaced Tier C locate-only, never edited).

/** Where a matched model-id literal sits: a live model argument, or plain data. */
export type LiteralPosition = 'model_arg' | 'data';

/** A literal node whose value matches a registry `model_id` deprecation. */
export interface LiteralMatch {
  /** The matched string/template literal node (edited in place by the codemod). */
  node: StringLiteral | NoSubstitutionTemplateLiteral;
  /** The literal's exact (unquoted) value, e.g. `"gemini-2.0-flash"`. */
  value: string;
  /** Where the literal sits in source, anchored at the node start. */
  location: SourceLocation;
  /** The registry entry this literal matched. */
  deprecation: LlmModelIdDeprecation;
  /** AST-classified position: `model_arg` is swap-safe, `data` is locate-only. */
  position: LiteralPosition;
}

/** A matched-but-rejected literal (used as data), for Tier C locate-only reporting. */
export interface ModelIdDataLocate {
  /** The deprecated model-id value found in a data position. */
  value: string;
  /** The replacement it WOULD swap to, shown for context only (never applied). */
  replacement: string;
  /** Where the data literal sits in source. */
  location: SourceLocation;
  /** The registry entry's human note, if any. */
  note?: string;
}

/**
 * A deprecated model id found in a LIVE model-argument position whose registry
 * entry is NOT `verified` (stale/chained/unverifiable/unstamped). The engine
 * gate refuses to auto-swap these; they are surfaced Tier C locate-only.
 */
export interface BlockedModelLocate {
  /** The deprecated model-id value found in a live model-argument position. */
  value: string;
  /** The replacement the registry PROPOSES (withheld because it is not verified). */
  replacement: string;
  /** Why it was blocked: the entry's verification status, or `unstamped` if absent. */
  status: VerificationStatus | 'unstamped';
  /** Where the literal sits in source. */
  location: SourceLocation;
  /** The registry entry's human note, if any. */
  note?: string;
  /** The verification reasons behind the block, if the entry carries them. */
  reasons?: string[];
}

// --- Call-site classification ---------------------------------------------
//
// Mirrors paramFix.ts's discipline of resolving the MODEL POSITION at a call
// site rather than trusting a bare string. A literal is only swapped when it is
// provably in a model-argument slot; anything else is left byte-identical.

/**
 * Property-key / variable names that mark a value as a model argument. `/model/i`
 * covers `model`, `modelId`, `modelName`, `model_name`, `MODEL_NAME`,
 * `defaultModel`, etc.; the extra set covers the Azure-style names that do not
 * contain "model".
 */
const MODEL_KEY_EXTRA: ReadonlySet<string> = new Set(['deployment', 'deploymentName']);

/**
 * Callee last-identifier names that construct/select a model directly from a
 * bare string argument (e.g. `google("gemini-2.0-flash")`). Deliberately small
 * and curated — recall traded for precision, as everywhere else in this module.
 */
const MODEL_FACTORIES: ReadonlySet<string> = new Set([
  'google',
  'openai',
  'anthropic',
  'createOpenAI',
  'createAnthropic',
  'createGoogleGenerativeAI',
  'getGenerativeModel',
  'generativeModel',
  'languageModel',
  'chat',
]);

/** Is a property-key / declaration name a model-argument name? */
function isModelLikeName(name: string): boolean {
  return /model/i.test(name) || MODEL_KEY_EXTRA.has(name);
}

/**
 * Is `parent` a value-transparent wrapper around `child`, so that classifying
 * `parent`'s position is equivalent to classifying `child`'s? This lets a
 * literal inside a `||`/`??` fallback, a parenthesis, an `as` cast, or a
 * ternary branch still be seen as the value of its enclosing property/argument
 * (e.g. `model: opts.model || "claude-3-opus-20240229"`).
 */
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

/** The (unquoted) key name of a property assignment, or its raw text if computed. */
function propertyKeyName(nameNode: Node): string {
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.getLiteralValue();
  }
  return nameNode.getText();
}

/** The last identifier of a call's callee: `google` or, for `x.chat(...)`, `chat`. */
function calleeLastIdentifier(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

/**
 * Is the object literal that directly contains `prop` passed as an ARGUMENT to a
 * call, e.g. `create({ model: "…" })`? Only then is a model-keyed property a live
 * model argument we trust enough to swap. A model id in a STANDALONE object
 * literal (a `const X = { modelId: "…" }` catalog entry, a returned config, an
 * element of a definitions array) is left as data. Without seeing the object
 * flow into a call, a swap risks corrupting a catalog — the real chatbot-ui
 * failure, where `modelId` changed but the sibling `hostedId` and the
 * `modelName: "Claude 3 Opus"` label did not, leaving an incoherent entry.
 */
function isEnclosingObjectACallArgument(prop: Node): boolean {
  const obj = prop.getParent();
  if (!obj || !Node.isObjectLiteralExpression(obj)) return false;
  let node: Node = obj;
  let parent = node.getParent();
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.getParent();
  }
  return !!parent && Node.isCallExpression(parent) && parent.getArguments().includes(node);
}

/**
 * Classify a matched model-id literal by its AST position.
 *
 * ACCEPT (`model_arg`, swap) when the literal is any of:
 *   (a) the VALUE of a model-like property (`model`, `modelId`, `deployment`, …)
 *       OF AN OBJECT PASSED TO A CALL (`create({ model: "…" })`), including inside
 *       a `||`/`??` fallback — a model id in a standalone/catalog object is data;
 *   (b) the initializer of a variable/property whose NAME is model-like
 *       (`const MODEL_NAME = "…"`, `defaultModel: "…"`);
 *   (c) a direct string argument to a known model-factory call
 *       (`google("…")`, `getGenerativeModel("…")`, `provider.chat("…")`).
 *
 * REJECT (`data`, locate-only) otherwise — a property KEY, an array element, or
 * any position not matching an ACCEPT rule.
 */
export function classifyLiteralPosition(
  literal: StringLiteral | NoSubstitutionTemplateLiteral,
): LiteralPosition {
  // Climb through value-transparent wrappers so a literal inside a fallback /
  // parenthesis / cast / ternary is judged by its real enclosing position.
  let node: Node = literal;
  let parent = node.getParent();
  while (parent && isValueTransparent(parent, node)) {
    node = parent;
    parent = node.getParent();
  }
  if (!parent) return 'data';

  // (a) value side of a model-like property — but ONLY when the enclosing object
  // literal is actually passed to a call (`create({ model: "…" })`). A model id
  // in a standalone object (a catalog entry, a returned config) is left as data:
  // we will not risk a catalog-corrupting swap on an object we can't see used.
  if (Node.isPropertyAssignment(parent)) {
    if (
      parent.getInitializer() === node &&
      isModelLikeName(propertyKeyName(parent.getNameNode())) &&
      isEnclosingObjectACallArgument(parent)
    ) {
      return 'model_arg';
    }
    return 'data'; // KEY position, or a standalone / catalog object -> never swap
  }

  // (b) variable form: `const modelName = "…"`.
  if (Node.isVariableDeclaration(parent)) {
    if (parent.getInitializer() === node && isModelLikeName(parent.getName())) {
      return 'model_arg';
    }
    return 'data';
  }

  // (b) class-property form: `defaultModel = "…"`.
  if (Node.isPropertyDeclaration(parent)) {
    if (parent.getInitializer() === node && isModelLikeName(parent.getName())) {
      return 'model_arg';
    }
    return 'data';
  }

  // (c) direct string argument to a known model factory.
  if (Node.isCallExpression(parent)) {
    if (parent.getArguments().includes(node)) {
      const factory = calleeLastIdentifier(parent);
      if (factory && MODEL_FACTORIES.has(factory)) return 'model_arg';
    }
    return 'data';
  }

  return 'data';
}

/**
 * Test-support files whose model ids are fixtures/mocks, not live app calls.
 * Skipped by default: rewriting a project's test model ids is never a change
 * worth proposing (noise at best, breaks their suite at worst — the Continue
 * scan wanted to swap 29 ids, every one in a `*.test.ts` or a mock class).
 */
export function isTestPath(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return (
    /\.(test|spec|vitest|e2e)\.[mc]?[jt]sx?$/.test(f) ||
    /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|test-helpers?|test-utils|testing|mocks?|fixtures?|e2e)\//.test(f) ||
    /(^|\/)mock[-.][^/]*$|[-.]mocks?\.[mc]?[jt]sx?$/.test(f)
  );
}

/**
 * Find every string/template literal in `project` whose value EXACTLY equals a
 * registry `model_id` deprecated token. Declaration files, `node_modules`, and
 * test-support files are skipped, mirroring the Stripe locator.
 *
 * Only `kind: "model_id"` entries participate — `param_rename` is not a literal
 * match (see TODO in modelId.ts).
 */
export function findModelIdLiterals(project: Project, registry: LlmRegistry): LiteralMatch[] {
  // Index model-id deprecations by their exact `deprecated` value for O(1)
  // lookup. A value maps to the FIRST entry that declares it.
  const byValue = new Map<string, LlmModelIdDeprecation>();
  for (const dep of modelIdEntries(registry)) {
    if (!byValue.has(dep.deprecated)) byValue.set(dep.deprecated, dep);
  }
  if (byValue.size === 0) return [];

  const out: LiteralMatch[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const file = sf.getFilePath();
    if (file.includes('/node_modules/')) continue;
    if (isTestPath(file)) continue;

    const literals = [
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];

    for (const node of literals) {
      const value = node.getLiteralValue();
      const deprecation = byValue.get(value);
      if (!deprecation) continue; // exact-value guard: no substring matching

      const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
      out.push({
        node,
        value,
        location: { file, line, column },
        deprecation,
        position: classifyLiteralPosition(node),
      });
    }
  }

  return out;
}

/**
 * The matched-but-rejected literals (deprecated ids used as DATA), captured as
 * plain snapshots for Tier C locate-only reporting. Call this against the
 * pre-edit project so line/column anchor the original source; the codemod never
 * touches these positions, so their coordinates stay valid.
 */
export function findModelIdDataMatches(
  project: Project,
  registry: LlmRegistry,
): ModelIdDataLocate[] {
  return findModelIdLiterals(project, registry)
    .filter((m) => m.position === 'data')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
    }));
}

/**
 * The deprecated ids sitting in LIVE model-argument positions whose entry is NOT
 * `verified` — i.e. matches the engine gate REFUSES to swap. Call this against
 * the pre-edit project so coordinates anchor the original source (the codemod
 * never touches these positions). This is the Tier C "found, but replacement is
 * unverified/stale — review manually" surface.
 */
export function findBlockedModelArgMatches(
  project: Project,
  registry: LlmRegistry,
): BlockedModelLocate[] {
  return findModelIdLiterals(project, registry)
    .filter((m) => m.position === 'model_arg' && !isVerified(m.deprecation))
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      status: m.deprecation.verification?.status ?? 'unstamped',
      location: m.location,
      note: m.deprecation.note,
      reasons: m.deprecation.verification?.reasons,
    }));
}
