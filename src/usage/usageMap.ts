import type { Project } from 'ts-morph';
import type { SourceLocation, UsageMap } from '../types.js';
import { findStripeAccesses } from './resolveStripe.js';

// Phase 2: assemble a UsageMap (`Record<path, SourceLocation[]>`) from a loaded
// ts-morph Project, and format it for readable CLI output. Keys match the Phase
// 1 detector convention `<TypeName>.<prop>[.<subprop>...]` so Phase 3 can
// intersect a ChangeSet against the usage map by exact path.

/**
 * Add a source location under a Stripe API `path`, avoiding exact-duplicate
 * (file/line/column) entries. Mutates and returns the map.
 */
export function addUsage(map: UsageMap, path: string, location: SourceLocation): UsageMap {
  const list = (map[path] ??= []);
  const dup = list.some(
    (l) => l.file === location.file && l.line === location.line && l.column === location.column,
  );
  if (!dup) list.push(location);
  return map;
}

/**
 * Walk every non-declaration source file in the project, resolve each
 * property-access expression to its type-rooted path, and record the site.
 *
 * Nested chains yield an entry at every level: `charge.card.name` records both
 * `DemoCharge.card` (from the inner `charge.card` node) and `DemoCharge.card.name`
 * (from the outer node), so intersection works whatever depth a change lands at.
 */
export function buildUsageMap(project: Project): UsageMap {
  const map: UsageMap = {};
  for (const { path, location } of findStripeAccesses(project)) {
    addUsage(map, path, location);
  }
  return map;
}

/** Pretty-print a UsageMap for CLI output, grouped by API path (sorted). */
export function formatUsageMap(map: UsageMap): string {
  const paths = Object.keys(map).sort();
  if (paths.length === 0) return 'No Stripe API usage found.';

  const siteCount = paths.reduce((n, p) => n + map[p].length, 0);
  const lines: string[] = [];
  lines.push(
    `${paths.length} Stripe API path${paths.length === 1 ? '' : 's'} used ` +
      `(${siteCount} site${siteCount === 1 ? '' : 's'}):`,
  );

  for (const path of paths) {
    lines.push('');
    lines.push(`${path}:`);
    for (const loc of map[path]) {
      lines.push(`  ${loc.file}:${loc.line}:${loc.column}`);
    }
  }

  return lines.join('\n');
}
