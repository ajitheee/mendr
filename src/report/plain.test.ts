import { describe, expect, it } from 'vitest';
import { shouldPrintProgress, shouldUsePlain, toPlain, toPlainLines } from './plain.js';

// Windows output (partner audits, 2026-09-04): `Γ£ô` for `✓`, `ΓÇö` for `—`,
// and a NativeCommandError for every progress line once output was piped.
describe('plain ASCII rendering', () => {
  it('spells every glyph in ASCII without losing meaning', () => {
    expect(toPlain('✓ Source code:  12 files — scanned…')).toBe('[x] Source code:  12 files - scanned...');
    expect(toPlain('○ Runtime usage: not measured • optional')).toBe('[ ] Runtime usage: not measured * optional');
    expect(toPlain('✗ Configuration: scan FAILED · see above → fix')).toBe('[!] Configuration: scan FAILED - see above -> fix');
    expect(toPlainLines(['a — b', 'c'])).toEqual(['a - b', 'c']);
  });
  it('leaves ASCII untouched', () => {
    expect(toPlain('Decision: PATCH ELIGIBLE')).toBe('Decision: PATCH ELIGIBLE');
  });
});

describe('when to use plain output', () => {
  const win = (over: Partial<{ stdoutIsTTY: boolean; env: NodeJS.ProcessEnv }> = {}) => ({
    platform: 'win32', stdoutIsTTY: true, env: {}, ...over,
  });
  it('--plain always wins', () => {
    expect(shouldUsePlain(true, { platform: 'linux', stdoutIsTTY: true, env: {} })).toBe(true);
  });
  it('MENDR_UNICODE=1 forces glyphs even on a Windows pipe', () => {
    expect(shouldUsePlain(false, win({ stdoutIsTTY: false, env: { MENDR_UNICODE: '1' } }))).toBe(false);
  });
  it('a Windows pipe or capture (Tee-Object, a file, a variable) is plain', () => {
    expect(shouldUsePlain(false, win({ stdoutIsTTY: false }))).toBe(true);
  });
  it('a Windows terminal known to be UTF-8 keeps glyphs; an unknown one does not', () => {
    expect(shouldUsePlain(false, win({ env: { WT_SESSION: 'x' } }))).toBe(false);
    expect(shouldUsePlain(false, win({ env: { TERM_PROGRAM: 'vscode' } }))).toBe(false);
    expect(shouldUsePlain(false, win({ env: {} }))).toBe(true);
  });
  it('non-Windows keeps glyphs', () => {
    expect(shouldUsePlain(false, { platform: 'darwin', stdoutIsTTY: false, env: {} })).toBe(false);
  });
});

describe('when to print progress', () => {
  it('never when stderr is not a terminal, never with --quiet', () => {
    expect(shouldPrintProgress(false, false)).toBe(false);
    expect(shouldPrintProgress(true, true)).toBe(false);
    expect(shouldPrintProgress(false, true)).toBe(true);
  });
});
