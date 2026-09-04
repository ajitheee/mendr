// A verbatim copy of the CLI's redaction (src/audit/issueReport.ts). The App
// re-applies it to EVERY string in every report it stores, so a client that
// forgot (or an older CLI) cannot land a credential in the database.
// `redact.test.ts` fails if this drifts from the CLI's function body.
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g, '$1-***REDACTED***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh*_***REDACTED***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***REDACTED***')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox*-***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***REDACTED***')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt.***REDACTED***')
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_?KEY|CREDENTIAL)S?)\s*[:=]\s*["']?[^\s"'<>]{6,}/gi,
      '$1=***REDACTED***',
    );
}
