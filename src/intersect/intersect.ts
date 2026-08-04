import type {
  AffectedSite,
  ApiChange,
  ChangeSet,
  SourceLocation,
  UsageMap,
} from '../types.js';
import { formatChange } from '../detect/changeModel.js';

// Phase 3: intersect a detected ChangeSet with a repo's UsageMap to keep only
// the changes that repo actually touches. This is the "noise-killer": a change
// to a field the repo never reads produces nothing, so the downstream fix
// engine only ever sees sites that genuinely exist.
//
// Matching is deliberately strict — exact dotted-path equality with one light
// normalization (a leading `Stripe.` root prefix is ignored on either side).
// We do NOT do fuzzy or suffix matching: a wrong match here would poison the
// fix engine, so we favour accuracy over recall.

/**
 * Strip a leading root-type prefix (`Stripe.`) so a change path like
 * `Stripe.Charge.card.name` and a usage key like `Charge.card.name` compare
 * equal. Only the well-known `Stripe.` root is normalized; deeper segments are
 * left untouched.
 */
export function normalizePath(path: string): string {
  return path.replace(/^Stripe\./i, '');
}

/**
 * The dotted path the downstream fix engine would key on for a change.
 *
 * Per the detector convention (see diffSpec.ts), a `field_rename` already
 * carries the OLD full path in `change.path` (with the old name in `from` and
 * the new name in `to`). The current fix code operates on that OLD name, so
 * intersection matches usage against the OLD path — which is `change.path` for
 * EVERY kind, rename included.
 */
function changePath(change: ApiChange): string {
  return change.path;
}

/** Intersect detected changes with repo usage to produce the affected sites. */
export function intersect(changes: ChangeSet, usage: UsageMap): AffectedSite[] {
  // Group usage locations by normalized key so a change matches whether or not
  // either side carries the `Stripe.` root prefix. Buckets merge locations from
  // both a bare and a `Stripe.`-prefixed spelling of the same path.
  const byNormalized = new Map<string, SourceLocation[]>();
  for (const [key, locs] of Object.entries(usage)) {
    const norm = normalizePath(key);
    const bucket = byNormalized.get(norm) ?? [];
    for (const loc of locs) bucket.push(loc);
    byNormalized.set(norm, bucket);
  }

  const sites: AffectedSite[] = [];
  for (const change of changes) {
    const target = normalizePath(changePath(change));
    const matched = byNormalized.get(target);
    // Noise-killer: a change the repo never uses is dropped entirely.
    if (!matched || matched.length === 0) continue;
    sites.push({ change, locations: dedupeLocations(matched) });
  }
  return sites;
}

/** Collapse exact-duplicate (file/line/column) locations, preserving order. */
function dedupeLocations(locs: SourceLocation[]): SourceLocation[] {
  const seen = new Set<string>();
  const out: SourceLocation[] = [];
  for (const l of locs) {
    const k = `${l.file}:${l.line}:${l.column}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * Pretty-print an intersection result for CLI output: a headline count, each
 * affected change with its concrete `file:line:column` sites, and a trailing
 * line noting how many changes were dropped as not used by the repo.
 */
export function formatAffectedSites(changes: ChangeSet, affected: AffectedSite[]): string {
  const total = changes.length;
  const hit = affected.length;
  const dropped = total - hit;

  const lines: string[] = [];
  lines.push(`${hit} of ${total} breaking change${total === 1 ? '' : 's'} affect this repo:`);

  if (hit === 0) {
    lines.push('');
    lines.push('  (none)');
  }

  for (const site of affected) {
    lines.push('');
    lines.push(formatChange(site.change));
    for (const loc of site.locations) {
      lines.push(`    ${loc.file}:${loc.line}:${loc.column}`);
    }
  }

  lines.push('');
  lines.push(
    `${dropped} change${dropped === 1 ? '' : 's'} dropped as not used by this repo.`,
  );

  return lines.join('\n');
}
