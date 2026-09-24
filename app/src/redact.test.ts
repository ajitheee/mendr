import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The PATTERNS array, verbatim, from either copy.
 *
 * This used to compare whole function bodies, which broke the moment the CLI
 * moved its implementation into src/redact/sanitize.ts — the test was pinned to
 * a shape rather than to the thing that matters. What matters is the rule list:
 * if the CLI learns to redact a new credential format, the App must learn it in
 * the same commit, or a report the CLI never saw can still land one in the
 * database.
 */
function patternBlock(raw: string): string {
  const source = raw.replace(/\r\n/g, '\n');
  const start = source.indexOf('const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n];\n', start);
  expect(end).toBeGreaterThan(start);
  // Compare the RULES, not the prose. The CLI's copy explains each pattern to
  // whoever edits it next; the App's does not need those paragraphs, and a test
  // that forced it to carry them would be pinning the wrong thing — and would
  // be "fixed" by deleting the explanation.
  return source
    .slice(start, end + 4)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .join('\n');
}

describe('the App redacts exactly what the CLI redacts', () => {
  it('mirrors the CLI pattern list', () => {
    const cli = readFileSync(join(here, '..', '..', 'src', 'redact', 'sanitize.ts'), 'utf8');
    const app = readFileSync(join(here, 'redact.ts'), 'utf8');
    expect(patternBlock(app)).toBe(patternBlock(cli));
  });

  it('redacts the shapes the trust statement lists', () => {
    const out = redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 AKIAABCDEFGHIJKLMNOP');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(out).toContain('REDACTED');
  });

  // The categories added when the migrate leak was closed. A report reaching
  // the App from a customer's CI can carry any of these.
  it('redacts the categories added with the central sanitizer', () => {
    const cases = [
      'https://user:hunter2hunter2@github.com/o/r.git',
      'Authorization: Bearer abcdefghijklmnop',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'hf_abcdefghijklmnopqrstuvwxyz',
      'gsk_abcdefghijklmnopqrstuvwxyz0123456789',
    ];
    for (const c of cases) {
      expect(redactSecrets(c)).toContain('REDACTED');
    }
  });
});
