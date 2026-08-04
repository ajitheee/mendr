import { Node, SyntaxKind } from 'ts-morph';
import type { PropertyAccessExpression, Project, Symbol as MorphSymbol, Type } from 'ts-morph';
import type { SourceLocation } from '../types.js';

// Phase 2 core: resolve a property-access expression to a dotted usage path
// keyed by the *type* it is rooted in, matching the Phase 1 detector convention
// of `<StripeTypeName>.<prop>[.<subprop>...]` (e.g. `Charge.card.name`).
//
// The type name is derived from the TYPE of the leftmost base expression via the
// ts-morph type checker (`Type#getSymbol().getName()`), NOT from the variable
// name. So `charge.card.name` where `charge: DemoCharge` becomes
// `DemoCharge.card.name`.
//
// Philosophy: accuracy over recall. If the base type cannot be resolved to a
// named, Stripe-like type (e.g. it is `any`, `unknown`, or an anonymous object
// literal) we SKIP the access rather than guess.

/** Heuristic: a type NAME that looks like a Stripe resource ("charge-like"). */
const STRIPE_TYPE_HINT =
  /(charge|customer|invoice|paymentintent|payment_intent|payout|refund|subscription|balance|dispute|card|source|token|coupon|price|product|checkout|session|setupintent|mandate|payment_method|paymentmethod)/i;

/** Symbol names ts-morph uses for anonymous object/type literals. */
const ANONYMOUS_NAMES = new Set(['__type', '__object', '']);

/**
 * Resolve the named Stripe-like type for a given type, or `null` if it is not a
 * usable named type. Handles unions (e.g. `DemoCharge | null`) by probing each
 * constituent and returning the first Stripe-like hit.
 */
export function resolveStripeTypeName(type: Type): string | null {
  // `any`/`unknown` carry no reliable structure — never guess through them.
  if (type.isAny() || type.isUnknown()) return null;

  // Peel unions like `DemoCharge | null | undefined` down to a named member.
  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (member.isNull() || member.isUndefined()) continue;
      const name = resolveStripeTypeName(member);
      if (name) return name;
    }
    return null;
  }

  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (!symbol) return null;

  const name = symbol.getName();
  if (ANONYMOUS_NAMES.has(name)) return null;

  if (STRIPE_TYPE_HINT.test(name) || isDeclaredInStripePackage(symbol)) return name;
  return null;
}

/** True when any declaration of `symbol` lives inside the `stripe` package. */
function isDeclaredInStripePackage(symbol: MorphSymbol): boolean {
  return symbol.getDeclarations().some((d) => {
    const fp = d.getSourceFile().getFilePath();
    return /[\\/]node_modules[\\/](@types[\\/])?stripe[\\/]/.test(fp);
  });
}

/**
 * Given a property-access node, walk the full chain down to its leftmost base,
 * resolve that base's TYPE name, and return the dotted path
 * `<TypeName>.<prop>[.<subprop>...]`. Returns `null` when the base type is not a
 * resolvable named Stripe-like type (the false-positive guard).
 */
export function resolveAccessPath(node: PropertyAccessExpression): string | null {
  // Collect property names from this node inward, then flip so they read
  // root -> leaf.
  const props: string[] = [];
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    props.unshift(current.getName());
    current = current.getExpression();
  }

  // `current` is now the leftmost base expression (an identifier, call, `this`,
  // etc.). Its resolved type provides the leading `<TypeName>` segment.
  const typeName = resolveStripeTypeName(current.getType());
  if (!typeName) return null;

  return [typeName, ...props].join('.');
}

/**
 * A resolved Stripe property access: the ts-morph node itself, its type-rooted
 * dotted `path`, and the `SourceLocation` anchored at the accessed property-name
 * token. This is the single source of truth shared by the Phase-2 usage-map
 * builder and the Phase-4 rename codemod, so a fix targets EXACTLY the nodes the
 * usage map found — no separate node-finding pass that could drift.
 */
export interface StripeAccess {
  node: PropertyAccessExpression;
  path: string;
  location: SourceLocation;
}

/**
 * Walk every non-declaration, non-`node_modules` source file in the project and
 * return every property-access expression that resolves to a named Stripe-like
 * type, paired with its dotted path and source location. Accesses whose base
 * type is not a resolvable named Stripe-like type are skipped (the same
 * accuracy-over-recall guard `resolveAccessPath` enforces).
 */
export function findStripeAccesses(project: Project): StripeAccess[] {
  const out: StripeAccess[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const file = sf.getFilePath();
    if (file.includes('/node_modules/')) continue;

    for (const access of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const path = resolveAccessPath(access);
      if (!path) continue;

      // Anchor the location at the accessed property-name token.
      const { line, column } = sf.getLineAndColumnAtPos(access.getNameNode().getStart());
      out.push({ node: access, path, location: { file, line, column } });
    }
  }

  return out;
}
