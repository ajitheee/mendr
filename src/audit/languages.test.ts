import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unanalyzedCensus, unanalyzedLanguages } from './languages.js';

// M7 / m4 (external validation): SQL, Svelte and Vue files carrying real
// selectors were dropped from coverage silently; dot-directories were skipped so
// JavaScript was undercounted; documentation was never named.
const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-census-'));
  created.push(dir);
  const put = (rel: string): void => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), '// x\n');
  };
  for (let i = 0; i < 3; i++) put(`supabase/migrations/m${i}.sql`);
  for (let i = 0; i < 4; i++) put(`src/lib/C${i}.svelte`);
  for (let i = 0; i < 2; i++) put(`server/s${i}.js`);
  for (let i = 0; i < 40; i++) put(`.claude/skills/tooling/s${i}.js`); // dot-directory tooling: never product code
  for (let i = 0; i < 3; i++) put(`docs/d${i}.md`);
  put('src/app.ts');
  put('node_modules/x/index.js'); // excluded
  return dir;
}

describe('unanalyzed-language census', () => {
  it('names SQL and Svelte, ignores dot-directory tooling, and reports docs separately', () => {
    const c = unanalyzedCensus(repo());
    expect(c.languages).toContain('Svelte (4 files)');
    expect(c.languages).toContain('SQL (3 files)');
    // JavaScript is now an ANALYZED language, so it never appears as a gap.
    expect(c.languages.some((l) => l.startsWith('JavaScript'))).toBe(false);
    expect(c.languages).toContain('Markdown/docs (3 files)');
    expect(c.files).toBe(7); // 3 sql + 4 svelte; the 2 server .js are analyzed now; tooling/docs/node_modules excluded
    expect(c.docs).toBe(3);
  });

  it('does not count JavaScript as an unanalyzed gap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mendr-census-js-'));
    created.push(dir);
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, `s${i}.js`), '// x\n');
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `g${i}.go`), 'package g\n');
    const c = unanalyzedCensus(dir);
    expect(c.languages.some((l) => l.startsWith('JavaScript'))).toBe(false);
    expect(c.languages).toContain('Go (5 files)');
    expect(c.files).toBe(5); // only the Go files are an unanalyzed gap
  });
  it('keeps the legacy string list in sync with the census', () => {
    const dir = repo();
    expect(unanalyzedLanguages(dir)).toEqual(unanalyzedCensus(dir).languages);
  });
});
