import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// DATA INVENTORY, enforced in code (TRUST.md "What the App stores").
// The App stores no access tokens or credentials of any kind. These tests fail
// if a future migration adds a credential-shaped column or table, so the
// inventory can never silently drift.

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = readFileSync(join(APP_ROOT, 'schema.sql'), 'utf8');

describe('stored-data inventory', () => {
  it('defines exactly the documented tables (three data tables + the audit log)', () => {
    const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(['audit_log', 'installations', 'repos', 'runs']);
  });

  it('has NO column that could hold a token, secret or private key', () => {
    // Column definitions are `<name> <TYPE> …` at the start of a line.
    const columns = [...schema.matchAll(/^\s*([a-z_]+)\s+(BIGINT|TEXT|JSONB|TIMESTAMPTZ|BOOLEAN|INTEGER|BIGSERIAL)/gim)].map((m) => m[1]!.toLowerCase());
    const forbidden = /(^|_)(token|secret|password|pem|priv|credential|apikey|api_key)($|_)/;
    const offenders = columns.filter((c) => forbidden.test(c));
    expect(offenders).toEqual([]);
  });

  it('the run record type carries no credential field', async () => {
    const types = readFileSync(join(APP_ROOT, 'src', 'store', 'types.ts'), 'utf8');
    // The RunRecord/RunSummary interfaces must not name a token/secret field.
    const runBlock = types.slice(types.indexOf('interface RunSummary'), types.indexOf('export type RunInput'));
    expect(runBlock).not.toMatch(/\b(token|secret|password|pem|credential)\b/i);
  });
});
