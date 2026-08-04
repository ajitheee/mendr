import type { ApiChange, ChangeSet } from '../types.js';

// Shared helpers for normalizing schema nodes and formatting a ChangeSet for
// human-readable CLI output.

type SchemaObject = Record<string, any>;

/**
 * Normalize a schema node's `type` into a comparable string. OpenAPI 3.1 allows
 * `type` to be an array; we sort + join those so order does not matter. A node
 * with no `type` but with `properties` is treated as an `object`.
 */
export function normalizeType(node: SchemaObject | undefined): string {
  if (!node || typeof node !== 'object') return '';
  const t = node.type;
  if (Array.isArray(t)) return [...t].map(String).sort().join('|');
  if (typeof t === 'string') return t;
  if (node.properties != null) return 'object';
  return '';
}

/** Render an enum array as a readable, stable string like `[a, b, c]`. */
export function formatEnum(values: unknown): string {
  if (!Array.isArray(values)) return '[]';
  return `[${values.map((v) => String(v)).join(', ')}]`;
}

/**
 * True when two enum arrays differ (a value added, removed, or renamed).
 * Comparison is order-independent. If neither side has an enum, they do not
 * differ; if exactly one side has an enum, they do.
 */
export function enumsDiffer(a: unknown, b: unknown): boolean {
  const hasA = Array.isArray(a);
  const hasB = Array.isArray(b);
  if (!hasA && !hasB) return false;
  if (hasA !== hasB) return true;
  const sa = [...(a as unknown[])].map(String).sort();
  const sb = [...(b as unknown[])].map(String).sort();
  if (sa.length !== sb.length) return true;
  return sa.some((v, i) => v !== sb[i]);
}

/** One human-readable line for a single change. */
export function formatChange(c: ApiChange): string {
  switch (c.kind) {
    case 'field_rename':
      return `  ${c.path}  renamed to  ${c.to}`;
    case 'field_removed':
      return `  ${c.path}  removed`;
    case 'type_change':
      return `  ${c.path}  type ${c.from} -> ${c.to}`;
    case 'enum_value_change':
      return `  ${c.path}  enum ${c.from} -> ${c.to}`;
    default:
      return `  ${(c as ApiChange).path}  ${(c as ApiChange).kind}`;
  }
}

const KIND_LABELS: Record<ApiChange['kind'], string> = {
  field_rename: 'Renamed fields',
  field_removed: 'Removed fields',
  type_change: 'Type changes',
  enum_value_change: 'Enum changes',
};

/** Pretty-print a ChangeSet for CLI output, grouped by change kind. */
export function formatChangeSet(cs: ChangeSet): string {
  if (cs.length === 0) return 'No breaking changes detected.';

  const order: ApiChange['kind'][] = [
    'field_rename',
    'field_removed',
    'type_change',
    'enum_value_change',
  ];

  const lines: string[] = [];
  const count = cs.length;
  lines.push(`${count} breaking change${count === 1 ? '' : 's'} detected:`);

  for (const kind of order) {
    const group = cs.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${KIND_LABELS[kind]}:`);
    for (const c of group) lines.push(formatChange(c));
  }

  return lines.join('\n');
}
