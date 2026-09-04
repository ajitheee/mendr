// Plain-ASCII output for terminals that cannot show the report's glyphs.
//
// Partner audits on Windows (2026-09-04) showed `Γ£ô` and `ΓÇö` where `✓` and
// `—` should be: PowerShell 5.1 decodes a native command's stdout with the OEM
// code page whenever the output is captured or piped (Tee-Object, a file, a
// variable), even inside a UTF-8-capable terminal. The report is UTF-8; the
// pipe is not. So: when stdout is not a TTY on Windows, or the terminal is not
// known to be UTF-8, render ASCII. `--plain` forces it anywhere; MENDR_UNICODE=1
// forces glyphs. Every glyph has an exact ASCII spelling — meaning is never lost.

const GLYPHS: ReadonlyArray<[RegExp, string]> = [
  [/✓/g, '[x]'],
  [/○/g, '[ ]'],
  [/✗/g, '[!]'],
  [/—/g, '-'],
  [/–/g, '-'],
  [/…/g, '...'],
  [/•/g, '*'],
  [/·/g, '-'],
  [/→/g, '->'],
  [/’/g, "'"],
  [/[“”]/g, '"'],
];

/** Rewrite one line of report text into plain ASCII. */
export function toPlain(line: string): string {
  let out = line;
  for (const [re, ascii] of GLYPHS) out = out.replace(re, ascii);
  return out;
}

/** Rewrite every line. */
export function toPlainLines(lines: readonly string[]): string[] {
  return lines.map(toPlain);
}

export interface OutputEnv {
  platform: string;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Should the human report be ASCII? `--plain` → yes. MENDR_UNICODE=1 → no.
 * Otherwise: on Windows, yes unless stdout is a TTY inside a terminal known to
 * be UTF-8 (Windows Terminal, VS Code). Elsewhere, no.
 */
export function shouldUsePlain(flag: boolean | undefined, e: OutputEnv = currentEnv()): boolean {
  if (flag) return true;
  if (e.env.MENDR_PLAIN === '1') return true;
  if (e.env.MENDR_UNICODE === '1') return false;
  if (e.platform !== 'win32') return false;
  if (!e.stdoutIsTTY) return true;
  const utf8Terminal = !!e.env.WT_SESSION || e.env.TERM_PROGRAM === 'vscode';
  return !utf8Terminal;
}

/**
 * Should progress lines go to stderr at all? Never when stderr is not a TTY:
 * PowerShell 5.1 wraps every redirected stderr line of a native command in a
 * NativeCommandError, which reads as a failure even though the scan succeeded.
 */
export function shouldPrintProgress(quiet: boolean | undefined, stderrIsTTY: boolean = !!process.stderr.isTTY): boolean {
  if (quiet) return false;
  if (process.env.MENDR_QUIET === '1') return false;
  return stderrIsTTY;
}

function currentEnv(): OutputEnv {
  return { platform: process.platform, stdoutIsTTY: !!process.stdout.isTTY, env: process.env };
}
