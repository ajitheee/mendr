import type { AuditLogInput } from './types.js';

// The audit log must never carry findings, secrets or source code. This keeps
// `detail` to primitives only (numbers, booleans, short strings) and drops
// anything else, so a careless caller cannot leak content into the log. It is a
// belt-and-suspenders guard on top of every call site already passing scalars.

const MAX_STR = 200;

export function sanitizeDetail(detail: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
    // objects/arrays are dropped: they could carry findings or code.
  }
  return out;
}

export function sanitizeEntry(entry: AuditLogInput): AuditLogInput {
  return {
    event: entry.event,
    installationId: entry.installationId,
    repo: entry.repo ? entry.repo.slice(0, MAX_STR) : null,
    actor: entry.actor ? entry.actor.slice(0, MAX_STR) : null,
    detail: sanitizeDetail(entry.detail),
  };
}
