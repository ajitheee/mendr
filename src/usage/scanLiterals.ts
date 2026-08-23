import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, NoSubstitutionTemplateLiteral, Project, StringLiteral } from 'ts-morph';
import type { LlmModelIdDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import {
  effectiveVerificationState,
  isVerified,
  modelIdEntries,
  type EffectiveVerificationState,
} from './llmRegistry.js';

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

/**
 * Where a matched model-id literal sits: a live model argument, plain data,
 * under an Azure deployment key (a deployment ALIAS, not a model id — its own
 * locate surface, never swap-eligible), or a model-like assignment whose
 * USAGE could not be verified (`usage_unverified`, produced by the Python
 * scanner's sink rule only — see src/python/scanPy.ts). A usage-unverified
 * candidate is never auto-applied and never included in --write.
 */
export type LiteralPosition = 'model_arg' | 'data' | 'azure_deployment' | 'usage_unverified';

/**
 * WHY a data-position literal is data — the purpose-aware refinement of the old
 * flat "used as DATA" label. Classified only where the AST makes it CHEAP and
 * unambiguous (accuracy over recall, as everywhere in this module); anything
 * not provably one of the specific purposes stays `generic`.
 */
export type DataPurpose =
  | 'comparison' // `m == "gpt-4"` / `===` — may gate runtime logic
  | 'lookup_key' // object/dict key (pricing table, normalization map)
  | 'list_entry' // array element (model-picker list)
  | 'catalog_entry' // value in a standalone object (config/catalog shape)
  | 'generic'; // data, but no cheap structural story

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
  /** For `data` positions: WHY it is data (purpose-aware Tier C language). */
  purpose?: DataPurpose;
  /** A per-match override of the generic review advice (e.g. the cast guard). */
  reason?: string;
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
  /** WHY the literal is data, when the AST made that cheap to see. */
  purpose?: DataPurpose;
  /** A per-match override of the generic review advice (e.g. the cast guard). */
  reason?: string;
}

/**
 * A deprecated model id sitting under an Azure deployment key. Reported like a
 * blocked match (with {@link AZURE_DEPLOYMENT_REASON}) but NEVER swap-eligible:
 * the value is a deployment alias, and the fix is provisioning, not a codemod.
 */
export interface AzureDeploymentLocate {
  /** The deprecated-looking value found under a deployment key. */
  value: string;
  /** The replacement the registry WOULD propose, shown for context only. */
  replacement: string;
  /** Where the literal sits in source. */
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
  /**
   * Why it was blocked: the record's verification status (`quarantined`,
   * `unverified`, `unverifiable`), `unstamped` if the block is absent, or
   * `withheld` when the stamp reads `verified` but one of the structured safety
   * switches is off (see effectiveVerificationState).
   */
  status: EffectiveVerificationState;
  /** Where the literal sits in source. */
  location: SourceLocation;
  /** The registry entry's human note, if any. */
  note?: string;
  /** The verification reasons behind the block, if the entry carries them. */
  reasons?: string[];
}

/**
 * A model-like ASSIGNMENT of a deprecated id with NO in-file sink usage
 * (Python's sink rule; see src/python/scanPy.ts): `model = "gpt-4"` where the
 * name is never later passed as a model kwarg / sink argument in the same
 * file. The VALUE is a known deprecated id and the replacement is known, but
 * the assignment may be event/log/fixture data wearing a model-like name (the
 * simulator failure) — so it is surfaced for manual review, never auto-applied.
 */
export interface UsageUnverifiedLocate {
  /** The deprecated model-id value found in the unproven assignment. */
  value: string;
  /** The replacement the registry WOULD apply, shown for context only. */
  replacement: string;
  /** Where the literal sits in source. */
  location: SourceLocation;
  /** The registry entry's human note, if any. */
  note?: string;
  /** The fixed usage-unverified explanation ({@link USAGE_UNVERIFIED_REASON}). */
  reason: string;
}

/** The fixed explanation printed with every usage-unverified candidate. */
export const USAGE_UNVERIFIED_REASON =
  'model-like data assignment, replacement known, usage purpose uncertain, manual review required';

// --- File-level magic comments ---------------------------------------------
//
// A repo can annotate its OWN files so Mendr stops reporting known content as
// debt. The annotation must sit alone on one of the FIRST FIVE lines:
//   `// mendr: model-catalog` (or `# mendr: model-catalog`) — the file IS a
//     deliberate migration catalog / knowledge base of deprecated ids: its
//     matches collapse to one "known migration catalog" line and nothing in it
//     is ever swapped (Mendr's own src/registry/oracles.ts carries this).
//   `// mendr: ignore-file` (or `# mendr: ignore-file`) — the file is skipped
//     entirely; the report carries only a count of skipped files.

/** The two file-level mendr annotations. */
export type MendrFileAnnotation = 'model-catalog' | 'ignore-file';

const ANNOTATION_RE = /^\s*(?:\/\/|#)\s*mendr:\s*(model-catalog|ignore-file)\s*$/;
const ANNOTATION_MAX_LINES = 5;

/** The file-level mendr annotation in `text`'s first five lines, if any. */
export function fileAnnotation(text: string): MendrFileAnnotation | undefined {
  for (const line of text.split(/\r?\n/, ANNOTATION_MAX_LINES)) {
    const m = ANNOTATION_RE.exec(line);
    if (m) return m[1] as MendrFileAnnotation;
  }
  return undefined;
}

/**
 * The distinct registry `deprecated` ids present in `text` as quoted string
 * content — the honest "N deprecated ids" count for a `model-catalog` file.
 * Text-level on purpose: a catalog file's ids are expected registry content,
 * so a cheap quote-delimited containment check is exact enough, and it keeps
 * the count identical across the TS and Python scanners.
 */
export function catalogIdsInText(text: string, registry: LlmRegistry): string[] {
  const seen = new Set<string>();
  for (const dep of modelIdEntries(registry)) {
    if (seen.has(dep.deprecated)) continue;
    if (
      text.includes(`"${dep.deprecated}"`) ||
      text.includes(`'${dep.deprecated}'`) ||
      text.includes(`\`${dep.deprecated}\``)
    ) {
      seen.add(dep.deprecated);
    }
  }
  return [...seen];
}

/** One annotated `model-catalog` file and the deprecated ids it carries. */
export interface CatalogFileReport {
  file: string;
  ids: string[];
}

/** The annotation surfaces of one scan: catalog files + ignored files. */
export interface AnnotationScan {
  catalogs: CatalogFileReport[];
  ignoredFiles: string[];
}

/**
 * Collect the annotated files of a project (same scope rules as the literal
 * scan: no declaration files, no node_modules, no test-support files), so the
 * CLI can report catalogs as expected content and ignored files as a count.
 */
export function scanProjectAnnotations(project: Project, registry: LlmRegistry): AnnotationScan {
  const catalogs: CatalogFileReport[] = [];
  const ignoredFiles: string[] = [];
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const file = sf.getFilePath();
    if (file.includes('/node_modules/')) continue;
    if (isTestPath(file)) continue;
    const annotation = fileAnnotation(sf.getFullText());
    if (annotation === 'ignore-file') {
      ignoredFiles.push(file);
    } else if (annotation === 'model-catalog') {
      catalogs.push({ file, ids: catalogIdsInText(sf.getFullText(), registry) });
    }
  }
  return { catalogs, ignoredFiles };
}

// --- Call-site classification ---------------------------------------------
//
// Mirrors paramFix.ts's discipline of resolving the MODEL POSITION at a call
// site rather than trusting a bare string. A literal is only swapped when it is
// provably in a model-argument slot; anything else is left byte-identical.

/**
 * Azure-style deployment keys. These USED to be swap-eligible model-key names,
 * which was wrong twice over: an Azure deployment name is a user-chosen alias
 * for a provisioned deployment, NOT a model id (it merely often LOOKS like
 * one), and swapping it points the code at a deployment that does not exist —
 * fixing nothing and breaking a working call. Matches under these keys are
 * therefore a dedicated locate-only surface (never auto-swapped): the honest
 * fix is provisioning a new deployment, which no codemod can do.
 */
const AZURE_DEPLOYMENT_KEYS: ReadonlySet<string> = new Set([
  'deployment',
  'deploymentName',
  'deployment_name',
]);

/** The fixed explanation printed with every azure-deployment locate finding. */
export const AZURE_DEPLOYMENT_REASON =
  'azure deployment alias -- a deployment name is not a model id; swapping requires provisioning. never auto-swapped';

/**
 * The cast-guard explanation: a non-string `as` cast means the repo maintains
 * its OWN model-id union/registry that a raw string swap would silently bypass
 * (the chatbot-ui failure: `model: ("gpt-4" as LLMID)` swapped to an id the
 * repo's LLMID union had never heard of).
 */
export const TYPE_CAST_REASON =
  "type-cast masks the model-id union -- swap could bypass the repo's own type registry; review manually";

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

/**
 * Is a property-key / declaration name a model-argument name? Exported so the
 * Python scanner (src/python/scanPy.ts) applies the IDENTICAL rule — one source
 * of truth for what counts as "model-like" across both languages. Azure
 * deployment keys are deliberately NOT model-like: they route to their own
 * locate surface via {@link isAzureDeploymentName}.
 */
export function isModelLikeName(name: string): boolean {
  return /model/i.test(name);
}

/**
 * Is a property-key / declaration name an Azure deployment alias? Exported so
 * the Python scanner routes `deployment_name=` etc. to the same locate surface.
 */
export function isAzureDeploymentName(name: string): boolean {
  return AZURE_DEPLOYMENT_KEYS.has(name);
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

/** The full classification of a matched literal: position + (for data) purpose. */
export interface LiteralClassification {
  position: LiteralPosition;
  /** Present for `data` positions: the cheapest honest story for WHY. */
  purpose?: DataPurpose;
  /** Present when a specific guard (not just position) forced `data`. */
  reason?: string;
}

/** Is a binary-operator token an equality comparison (`==`/`===`/`!=`/`!==`)? */
function isEqualityOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.EqualsEqualsToken ||
    kind === SyntaxKind.EqualsEqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsEqualsToken
  );
}

/**
 * Classify a matched model-id literal by its AST position.
 *
 * ACCEPT (`model_arg`, swap) when the literal is any of:
 *   (a) the VALUE of a model-like property (`model`, `modelId`, …)
 *       OF AN OBJECT PASSED TO A CALL (`create({ model: "…" })`), including inside
 *       a `||`/`??` fallback — a model id in a standalone/catalog object is data;
 *   (b) the initializer of a variable/property whose NAME is model-like
 *       (`const MODEL_NAME = "…"`, `defaultModel: "…"`);
 *   (c) a direct string argument to a known model-factory call
 *       (`google("…")`, `getGenerativeModel("…")`, `provider.chat("…")`).
 *
 * REJECT (`data`, locate-only) otherwise — a property KEY (`lookup_key`), an
 * array element (`list_entry`), an equality operand (`comparison`), a value in
 * a standalone object (`catalog_entry`), or any position not matching an ACCEPT
 * rule (`generic`). The purpose rides along so the CLI's Tier C language can
 * say WHY instead of a flat "used as data".
 *
 * Two guards OVERRIDE an accept:
 *   - AZURE (`azure_deployment`): a value under a deployment key is an alias
 *     for a provisioned deployment, not a model id — its own locate surface.
 *   - CAST BLINDNESS: an `as` cast to a NON-string-keyword type between the
 *     literal and its enclosing property/call (`model: ("gpt-4" as LLMID)`)
 *     means the repo keeps its own model-id union; a raw string swap would
 *     silently bypass it, so the match is demoted to data with a reason.
 *     `as string` and `as const` mask nothing and stay swap-transparent.
 */
export function classifyLiteral(
  literal: StringLiteral | NoSubstitutionTemplateLiteral,
): LiteralClassification {
  // Climb through value-transparent wrappers so a literal inside a fallback /
  // parenthesis / cast / ternary is judged by its real enclosing position —
  // remembering any union-masking `as` cast passed on the way up.
  let maskingCast = false;
  let node: Node = literal;
  let parent = node.getParent();
  while (parent && isValueTransparent(parent, node)) {
    if (Node.isAsExpression(parent)) {
      const typeText = parent.getTypeNode()?.getText().trim();
      if (typeText && typeText !== 'string' && typeText !== 'const') maskingCast = true;
    }
    node = parent;
    parent = node.getParent();
  }

  const base = classifyByEnclosure(node, parent);
  if (base.position === 'model_arg' && maskingCast) {
    return { position: 'data', purpose: 'generic', reason: TYPE_CAST_REASON };
  }
  return base;
}

/** The position/purpose earned by the (climbed-to) enclosing construct alone. */
function classifyByEnclosure(node: Node, parent: Node | undefined): LiteralClassification {
  if (!parent) return { position: 'data', purpose: 'generic' };

  // (a) value side of a model-like property — but ONLY when the enclosing object
  // literal is actually passed to a call (`create({ model: "…" })`). A model id
  // in a standalone object (a catalog entry, a returned config) is left as data:
  // we will not risk a catalog-corrupting swap on an object we can't see used.
  if (Node.isPropertyAssignment(parent)) {
    if (parent.getNameNode() === node) {
      // KEY position (pricing table, normalization map) -> never swap:
      // rewriting a key risks duplicate-key corruption.
      return { position: 'data', purpose: 'lookup_key' };
    }
    if (parent.getInitializer() === node) {
      const keyName = propertyKeyName(parent.getNameNode());
      if (isAzureDeploymentName(keyName)) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeName(keyName) && isEnclosingObjectACallArgument(parent)) {
        return { position: 'model_arg' };
      }
      // A property VALUE that is not a proven live model argument sits in a
      // standalone / catalog-shaped object (the chatbot-ui failure mode).
      return { position: 'data', purpose: 'catalog_entry' };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (b) variable form: `const modelName = "…"`.
  if (Node.isVariableDeclaration(parent)) {
    if (parent.getInitializer() === node) {
      if (isAzureDeploymentName(parent.getName())) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeName(parent.getName())) return { position: 'model_arg' };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (b) class-property form: `defaultModel = "…"`.
  if (Node.isPropertyDeclaration(parent)) {
    if (parent.getInitializer() === node) {
      if (isAzureDeploymentName(parent.getName())) {
        return { position: 'azure_deployment', reason: AZURE_DEPLOYMENT_REASON };
      }
      if (isModelLikeName(parent.getName())) return { position: 'model_arg' };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // (c) direct string argument to a known model factory.
  if (Node.isCallExpression(parent)) {
    if (parent.getArguments().includes(node)) {
      const factory = calleeLastIdentifier(parent);
      if (factory && MODEL_FACTORIES.has(factory)) return { position: 'model_arg' };
    }
    return { position: 'data', purpose: 'generic' };
  }

  // Array element: a model-picker / allow-list entry.
  if (Node.isArrayLiteralExpression(parent)) {
    return { position: 'data', purpose: 'list_entry' };
  }

  // Equality operand: `m == "gpt-4"` may gate runtime logic — worth flagging
  // as a comparison rather than burying it under generic data.
  if (Node.isBinaryExpression(parent) && isEqualityOperator(parent.getOperatorToken().getKind())) {
    return { position: 'data', purpose: 'comparison' };
  }

  return { position: 'data', purpose: 'generic' };
}

/** Position-only view of {@link classifyLiteral} (kept for call-site brevity). */
export function classifyLiteralPosition(
  literal: StringLiteral | NoSubstitutionTemplateLiteral,
): LiteralPosition {
  return classifyLiteral(literal).position;
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
  // lookup. A value maps to EVERY entry that declares it — a MULTIMAP, not a
  // first-wins single: the registry may legitimately carry two records for one
  // id (two providers, or two retirement waves — distinct entryIds, which
  // validateRegistry permits and registry/entryId.ts is built for). A first-wins
  // index silently dropped the second record's retirement deadline everywhere
  // downstream, the `mendr watch` exposure most of all (foldExposure groups by
  // entryId but only ever saw the first). So one match is emitted PER MATCHING
  // ENTRY below, so every entryId reaches the consumers; the fix path collapses
  // those back to one edit per physical literal (see applyModelIdFixes).
  const byValue = new Map<string, LlmModelIdDeprecation[]>();
  for (const dep of modelIdEntries(registry)) {
    const list = byValue.get(dep.deprecated);
    if (list) list.push(dep);
    else byValue.set(dep.deprecated, [dep]);
  }
  if (byValue.size === 0) return [];

  const out: LiteralMatch[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const file = sf.getFilePath();
    if (file.includes('/node_modules/')) continue;
    if (isTestPath(file)) continue;
    // Annotated files never yield matches: a `model-catalog` file's ids are
    // expected registry content (own one-line surface), an `ignore-file` is
    // skipped outright. Both are surfaced via scanProjectAnnotations instead.
    if (fileAnnotation(sf.getFullText()) !== undefined) continue;

    const literals = [
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];

    for (const node of literals) {
      const value = node.getLiteralValue();
      const deprecations = byValue.get(value);
      if (!deprecations) continue; // exact-value guard: no substring matching

      // Position/purpose are properties of the AST NODE, not of the registry
      // entry, so classify ONCE and share the verdict across every matching
      // record — then emit one match per record so each entryId flows through.
      const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
      const classification = classifyLiteral(node);
      for (const deprecation of deprecations) {
        out.push({
          node,
          value,
          location: { file, line, column },
          deprecation,
          position: classification.position,
          purpose: classification.purpose,
          reason: classification.reason,
        });
      }
    }
  }

  return out;
}

/**
 * Project a pre-computed literal scan down to its DATA-position matches, as
 * plain snapshots for Tier C locate-only reporting. Extracted so a caller that
 * already holds a `findModelIdLiterals` result can derive this view without
 * paying for a second full scan.
 */
export function toModelIdDataMatches(matches: LiteralMatch[]): ModelIdDataLocate[] {
  return matches
    .filter((m) => m.position === 'data')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
      purpose: m.purpose,
      reason: m.reason,
    }));
}

/**
 * Project a pre-computed literal scan down to its BLOCKED matches: deprecated
 * ids sitting in LIVE model-argument positions whose entry is NOT `verified` —
 * i.e. matches the engine gate REFUSES to swap. Extracted for the same
 * single-scan reuse as {@link toModelIdDataMatches}.
 */
export function toBlockedModelArgMatches(matches: LiteralMatch[]): BlockedModelLocate[] {
  return matches
    .filter((m) => m.position === 'model_arg' && !isVerified(m.deprecation))
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      status: effectiveVerificationState(m.deprecation),
      location: m.location,
      note: m.deprecation.note,
      reasons: m.deprecation.verification?.reasons,
    }));
}

/**
 * Project a pre-computed literal scan down to its AZURE-DEPLOYMENT matches:
 * deprecated-looking values under a deployment key. Reported like blocked
 * matches (with {@link AZURE_DEPLOYMENT_REASON}) and NEVER swapped — the value
 * is a deployment alias, and the fix is provisioning, not a codemod.
 */
export function toAzureDeploymentMatches(matches: LiteralMatch[]): AzureDeploymentLocate[] {
  return matches
    .filter((m) => m.position === 'azure_deployment')
    .map((m) => ({
      value: m.value,
      replacement: m.deprecation.replacement,
      location: m.location,
      note: m.deprecation.note,
    }));
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
  return toModelIdDataMatches(findModelIdLiterals(project, registry));
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
  return toBlockedModelArgMatches(findModelIdLiterals(project, registry));
}
