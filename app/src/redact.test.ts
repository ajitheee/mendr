import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

const here = dirname(fileURLToPath(import.meta.url));

function functionBody(raw: string): string {
  const source = raw.replace(/\r\n/g, '\n');
  const start = source.indexOf('export function redactSecrets(text: string): string {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

describe('redactSecrets stays identical to the CLI', () => {
  it('has the same function body as src/audit/issueReport.ts', () => {
    const cli = readFileSync(join(here, '..', '..', 'src', 'audit', 'issueReport.ts'), 'utf8');
    const app = readFileSync(join(here, 'redact.ts'), 'utf8');
    expect(functionBody(app)).toBe(functionBody(cli));
  });

  it('redacts the shapes the trust statement lists', () => {
    const out = redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 AKIAABCDEFGHIJKLMNOP');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(out).toContain('REDACTED');
  });
});
