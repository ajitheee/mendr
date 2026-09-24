// THE sanitizer. One owner, one set of rules, every surface that can reach a
// human goes through it.
//
// WHY THIS FILE EXISTS. There were three textually-duplicated copies of the
// same seven patterns — src/audit/issueReport.ts, src/gates/sandbox.ts and
// app/src/redact.ts — and a whole output plane, the migrate path, that passed
// through none of them. That plane is not a log: mendr-action publishes the
// migrate report to the Actions log, the job summary AND the body of a public
// pull request. So a credential that reached it was not merely recorded, it was
// PUBLISHED, which turns a tool that reads secrets into one that leaks them.
//
// THE LEAK THAT PROVED IT (fixed with this module):
//   src/cli.ts        echoed the raw --eval-command to stderr
//   run-mendr.sh:115  captured stderr into $REPORT with 2>&1
//   run-mendr.sh:210  cat "$REPORT" into the pull-request body
// so `eval-command: "OPENAI_API_KEY=sk-... npm run evals"` published that key.
//
// TWO MECHANISMS, deliberately. Patterns catch secret SHAPES in text nobody
// declared; by-value redaction catches the exact strings we already know are
// secret (the action's own INPUT_* values, the job's tokens). By-value runs
// FIRST and is the stronger of the two: it cannot be defeated by a format this
// file has never seen.
//
// EVERY PATTERN HERE MUST BE LINEAR. This runs over attacker-influenced text —
// a test failure, a stack trace, a dependency's log line — inside someone's CI.
// A pattern that backtracks is a way to stall their build. Each quantifier
// below is pinned by a literal that cannot appear inside its own character
// class, or is explicitly bounded. sanitize.test.ts times the whole set against
// adversarial input and fails if it exceeds a fixed budget.

/** Replacement text. Fixed, so a reader can search their logs for it. */
const MARK = '***REDACTED***';

/**
 * Secret SHAPES.
 *
 * Ordered most-specific first: a PEM block before anything that might match
 * inside it, URL credentials before the bare-token rules, and the generic
 * NAME=value rule last so a named match does not pre-empt a precise one.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A private key block, bounded so a file full of BEGIN markers cannot make
  // this quadratic. Mendr's own registry signing key is a PEM; if one ever
  // reaches output it must not reach it whole.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${MARK} -----END PRIVATE KEY-----`],

  // scheme://user:password@host — the credential is in the authority, which is
  // exactly where a `git remote -v` or a failed fetch prints it.
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/]{1,200}):([^\s@/]{1,200})@/gi, `$1$2:${MARK}@`],

  // Authorization: Bearer <token>, and a bare Bearer token in a curl echo.
  [/\b(authorization\s*:\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s"']{4,}/gi, `$1${MARK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g, `Bearer ${MARK}`],

  // Provider and forge token formats.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, `gh*_${MARK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, `github_pat_${MARK}`],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, `$1-${MARK}`],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, `AIza${MARK}`],
  [/\bhf_[A-Za-z0-9]{16,}\b/g, `hf_${MARK}`],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, `gsk_${MARK}`],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, `xox*-${MARK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MARK}`],

  // JWT / OIDC. Measured linear: the literal dots sit OUTSIDE every character
  // class, so each quantifier's extent is pinned by the next separator and
  // there is no ambiguous overlap to backtrack through. This was reported as a
  // ReDoS; it is not one, and the measurement lives in sanitize.test.ts.
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, `jwt.${MARK}`],

  // NAME=value / NAME: value where the NAME says what it holds. Last, and
  // deliberately broad on the name side: a format we have never seen still gets
  // caught when its variable is honestly named.
  [
    /\b([A-Z][A-Z0-9_]{0,60}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|PAT)S?)\s*[:=]\s*["']?[^\s"'<>]{6,}/gi,
    `$1=${MARK}`,
  ],
];

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Values that are known secrets rather than guessed ones.
 *
 * Structural inputs are skipped: redacting `audit .` or `true` would shred the
 * report while protecting nothing, and a value that short cannot be a
 * credential worth hiding. Everything else an operator passed in is treated as
 * sensitive, because we cannot know what they embedded in it.
 */
const MIN_VALUE_LENGTH = 12;
const STRUCTURAL = new Set(['true', 'false', 'on', 'off', 'yes', 'no', 'auto', 'none', 'tierA', 'tierB', 'tierC']);

/**
 * Collect the exact strings this run already knows are sensitive: the action's
 * own inputs (GitHub exposes every one as INPUT_<NAME>), plus any variable
 * whose NAME declares it holds a credential.
 *
 * Callers pass the environment explicitly so this is testable and so nothing
 * reads process.env implicitly halfway down a render path.
 */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_VALUE_LENGTH) continue;
    if (STRUCTURAL.has(value.trim())) continue;
    const isInput = name.startsWith('INPUT_');
    const isNamedSecret = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|PAT)S?$/i.test(name);
    if (isInput || isNamedSecret) values.push(value);
  }
  // Longest first: redacting a value that CONTAINS another must not leave the
  // shorter one's tail behind as a recognizable fragment.
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Redact exact known values. Runs before the patterns; see the header.
 *
 * Sorts LONGEST FIRST here rather than trusting the caller. When one secret
 * contains another — `abcdefghijkl` inside `abcdefghijkl-suffix` — redacting
 * the shorter one first leaves `***REDACTED***-suffix`, which publishes the
 * tail of a credential and looks redacted while doing it. The collector used
 * to own this sort; being exported, this function has callers it cannot see.
 */
export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (!value || value.length < MIN_VALUE_LENGTH) continue;
    out = out.replace(new RegExp(escapeLiteral(value), 'g'), MARK);
  }
  return out;
}

/**
 * Sanitize text bound for any human-visible surface.
 *
 * NOT for the patch itself: a redacted diff does not apply. The `git apply`
 * targets and the issue's machine-read state block are deliberately excluded by
 * their callers, and sanitize.test.ts asserts those exclusions stay.
 */
export function sanitize(text: string, knownValues: readonly string[] = []): string {
  let out = knownValues.length > 0 ? redactValues(text, knownValues) : text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The name the rest of the codebase already used. Kept as the public spelling
 * so three modules did not have to change their call sites in the same commit
 * that changed what redaction MEANS.
 */
export const redactSecrets = (text: string): string => sanitize(text);
