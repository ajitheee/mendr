// The App's copy of the CLI's redaction, applied to EVERY string in every
// report it stores — so a client that forgot, or an older CLI, cannot land a
// credential in the database.
//
// WHY A COPY AT ALL. The App is a separate deployable with its own build; it
// cannot import from the CLI's src/ at runtime. So the pattern list is
// mirrored here, and `redact.test.ts` fails if it drifts from
// src/redact/sanitize.ts — the guarantee is mechanical, not a comment asking
// the next person to remember.
//
// This is the RECEIVING end and the second line. The CLI sanitizes at the
// source (src/redact/sanitize.ts), before anything crosses the network.

const MARK = '***REDACTED***';

// MIRRORED FROM src/redact/sanitize.ts — keep byte-identical; redact.test.ts enforces it.
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${MARK} -----END PRIVATE KEY-----`],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/]{1,200}):([^\s@/]{1,200})@/gi, `$1$2:${MARK}@`],
  [/\b(authorization\s*:\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s"']{4,}/gi, `$1${MARK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g, `Bearer ${MARK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, `gh*_${MARK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, `github_pat_${MARK}`],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, `$1-${MARK}`],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, `AIza${MARK}`],
  [/\bhf_[A-Za-z0-9]{16,}\b/g, `hf_${MARK}`],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, `gsk_${MARK}`],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, `xox*-${MARK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MARK}`],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, `jwt.${MARK}`],
  [
    /\b([A-Z][A-Z0-9_]{0,60}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|PAT)S?)\s*[:=]\s*["']?[^\s"'<>]{6,}/gi,
    `$1=${MARK}`,
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
