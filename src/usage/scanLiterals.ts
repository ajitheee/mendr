import { SyntaxKind } from 'ts-morph';
import type { NoSubstitutionTemplateLiteral, Project, StringLiteral } from 'ts-morph';
import type { LlmModelIdDeprecation, LlmRegistry, SourceLocation } from '../types.js';
import { modelIdEntries } from './llmRegistry.js';

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
}

/**
 * Find every string/template literal in `project` whose value EXACTLY equals a
 * registry `model_id` deprecated token. Declaration files and `node_modules`
 * are skipped, mirroring the Stripe locator.
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

    const literals = [
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];

    for (const node of literals) {
      const value = node.getLiteralValue();
      const deprecation = byValue.get(value);
      if (!deprecation) continue; // exact-value guard: no substring matching

      const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
      out.push({ node, value, location: { file, line, column }, deprecation });
    }
  }

  return out;
}
