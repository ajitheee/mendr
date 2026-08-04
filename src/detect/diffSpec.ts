import type { ApiChange, ChangeSet } from '../types.js';
import type { OpenApiSpec } from './fetchSpec.js';
import { normalizeType, formatEnum, enumsDiffer } from './changeModel.js';

// A focused OpenAPI schema differ, scoped to `components.schemas`. We compare
// each schema present in BOTH specs property-by-property and emit the breaking
// changes as a normalized ChangeSet.
//
// NOTE: a future version could cross-check these results against the `oasdiff`
// Go binary, but Phase 1 intentionally implements the diff in-process so there
// is no external binary dependency.
//
// Conventions for the emitted ApiChange:
//   - field_removed:     path = full dotted path of the removed property.
//   - type_change:       path = property path; from = old type; to = new type.
//   - enum_value_change: path = property path; from/to = readable enum lists.
//   - field_rename:      path = OLD full property path (e.g. `Charge.card.name`);
//                        from = old property name; to = new property name.

/** Maximum object nesting depth we recurse into (bounded to avoid runaway). */
const MAX_DEPTH = 3;

type SchemaObject = Record<string, any>;

/** Diff two OpenAPI specs and return the set of breaking changes. */
export function diffSpecs(a: OpenApiSpec, b: OpenApiSpec): ChangeSet {
  const changes: ChangeSet = [];
  const schemasA = a.components?.schemas ?? {};
  const schemasB = b.components?.schemas ?? {};

  // Only schemas present in BOTH specs are compared. A schema that only exists
  // in one side is out of scope for property-level breaking-change detection.
  for (const name of Object.keys(schemasA)) {
    if (!(name in schemasB)) continue;
    diffSchema(schemasA[name], schemasB[name], name, changes, 0);
  }

  return changes;
}

/**
 * Compare the `properties` of two schema/object nodes rooted at `pathPrefix`
 * and push any detected changes.
 */
function diffSchema(
  a: SchemaObject,
  b: SchemaObject,
  pathPrefix: string,
  changes: ApiChange[],
  depth: number,
): void {
  const propsA: Record<string, SchemaObject> = a?.properties ?? {};
  const propsB: Record<string, SchemaObject> = b?.properties ?? {};

  const removed = Object.keys(propsA).filter((k) => !(k in propsB));
  const added = Object.keys(propsB).filter((k) => !(k in propsA));

  // Rename inference: within the SAME object, if exactly one property was
  // removed and exactly one added, and their types are compatible, treat it as
  // a rename rather than a separate remove + add. This is a heuristic and can
  // false-positive when two unrelated same-typed fields are swapped in one edit.
  let renameConsumed = false;
  if (removed.length === 1 && added.length === 1) {
    const oldName = removed[0];
    const newName = added[0];
    if (normalizeType(propsA[oldName]) === normalizeType(propsB[newName])) {
      changes.push({
        kind: 'field_rename',
        path: `${pathPrefix}.${oldName}`,
        from: oldName,
        to: newName,
      });
      renameConsumed = true;
    }
  }

  if (!renameConsumed) {
    for (const name of removed) {
      changes.push({ kind: 'field_removed', path: `${pathPrefix}.${name}` });
    }
    // Added-only properties are additive, not breaking, so we do not report them.
  }

  // Compare properties present in both sides.
  for (const name of Object.keys(propsA)) {
    if (!(name in propsB)) continue;
    const pa = propsA[name];
    const pb = propsB[name];
    const childPath = `${pathPrefix}.${name}`;

    const typeA = normalizeType(pa);
    const typeB = normalizeType(pb);
    if (typeA && typeB && typeA !== typeB) {
      changes.push({ kind: 'type_change', path: childPath, from: typeA, to: typeB });
    }

    if (enumsDiffer(pa?.enum, pb?.enum)) {
      changes.push({
        kind: 'enum_value_change',
        path: childPath,
        from: formatEnum(pa?.enum),
        to: formatEnum(pb?.enum),
      });
    }

    // Recurse into nested inline object properties, bounded by MAX_DEPTH.
    if (depth + 1 < MAX_DEPTH && isObjectNode(pa) && isObjectNode(pb)) {
      diffSchema(pa, pb, childPath, changes, depth + 1);
    }
  }
}

/** True when a schema node is an inline object with its own properties. */
function isObjectNode(node: SchemaObject | undefined): boolean {
  return !!node && typeof node === 'object' && node.properties != null;
}
