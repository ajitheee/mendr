import type { Project, PropertyAccessExpression } from 'ts-morph';
import type { AffectedSite } from '../types.js';
import { findStripeAccesses } from '../usage/resolveStripe.js';
import { normalizePath } from '../intersect/intersect.js';

// Phase 4a: the field-rename codemod.
//
// This is the single most safety-critical operation in the tool. A rename of
// the WRONG `.name` breaks the customer's code, so precision is absolute:
//
//   1. We reuse the Phase-2 resolver (`findStripeAccesses`) to enumerate the
//      exact same type-rooted property accesses the usage map was built from.
//      There is no second, looser node-finding pass that could drift.
//   2. We rename ONLY accesses whose resolved dotted path equals the change's
//      OLD path (e.g. `DemoCharge.card.name`) AND whose trailing property name
//      equals `change.from`. A `.name` on any other type/path is left untouched.
//   3. We edit ONLY the trailing name token (`node.getNameNode()`), never a
//      project-wide rename refactor (which would be far too broad).
//
// The edits are made in-memory on the passed `Project`; this function never
// saves. `apply.ts` is responsible for diffing the in-memory result against the
// on-disk original.

/**
 * Rename the field described by a `field_rename` AffectedSite at every matching
 * source site in `project`. Returns the accesses that were edited (useful for a
 * site count). A non-rename or malformed change is a no-op.
 *
 * The project is mutated in place but NOT saved.
 */
export function applyRename(project: Project, site: AffectedSite): PropertyAccessExpression[] {
  const change = site.change;
  if (change.kind !== 'field_rename' || !change.from || !change.to) return [];

  const target = normalizePath(change.path);
  const from = change.from;
  const to = change.to;
  const edited: PropertyAccessExpression[] = [];

  // Re-scan after each edit. Renaming a site changes its trailing token (and
  // thus its resolved path), so it can never re-match; the loop terminates once
  // no unedited site remains. Re-scanning also sidesteps stale/forgotten
  // ts-morph node references after a text manipulation shifts positions.
  //
  // Precision guard is the two-part predicate: resolved path === OLD path AND
  // trailing name === `from`. Both must hold, so a decoy `.name` on a different
  // type (different resolved path) is never touched.
  for (;;) {
    const next = findStripeAccesses(project).find(
      (a) => normalizePath(a.path) === target && a.node.getNameNode().getText() === from,
    );
    if (!next) break;

    next.node.getNameNode().replaceWithText(to);
    edited.push(next.node);
  }

  return edited;
}
