import type { AuditReport } from './validate.js';

// The scanner reports which deprecation registry it joined against and how
// RECENT it was (coverage.registry, written by src/registry/freshRegistry.ts in
// the CLI). The App stores `coverage` opaquely; this is the one typed, defensive
// read of it, so the run page and the check run can say
// "registry: snapshot 2026-09-05 · fresh (2 d)" — or explain why a zero-finding
// scan came back inconclusive. A report from a scanner older than freshness
// reporting reads as `unknown`, never as fresh.

export interface RegistryFreshnessView {
  freshness: 'fresh' | 'stale' | 'unknown';
  source: string | null;
  publishedAt: string | null;
  ageDays: number | null;
  maxAgeDays: number | null;
  version: string | null;
  reason: string | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function registryFreshnessOf(report: AuditReport): RegistryFreshnessView {
  const r = rec(rec(report.coverage)?.registry);
  const f = r?.freshness;
  return {
    freshness: f === 'fresh' ? 'fresh' : f === 'stale' ? 'stale' : 'unknown',
    source: str(r?.source),
    publishedAt: str(r?.publishedAt),
    ageDays: num(r?.ageDays),
    maxAgeDays: num(r?.maxAgeDays),
    version: str(r?.version),
    reason: str(r?.reason),
  };
}

/** One line for humans: `snapshot 2026-09-05 · fresh (2 d)` / `bundled 2026-08-01 · STALE (36 d, max 14)`. */
export function registryFreshnessLine(v: RegistryFreshnessView): string {
  if (v.freshness === 'unknown') return 'registry freshness unknown (the scanner predates freshness reporting)';
  const when = v.publishedAt ? v.publishedAt.slice(0, 10) : 'undated';
  const age = v.ageDays === null ? 'age unknown' : `${Math.floor(v.ageDays)} d`;
  const src = v.source ?? 'registry';
  return v.freshness === 'fresh' ? `${src} ${when} · fresh (${age})` : `${src} ${when} · STALE (${age}, max ${v.maxAgeDays ?? '?'})`;
}
