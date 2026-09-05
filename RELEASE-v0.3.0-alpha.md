# mendr v0.3.0-alpha — private-repo trust, the GitHub App, JavaScript, and safe migrations

This is the release external partners should use. It supersedes `v0.2.4-alpha`,
which predates the Windows/PowerShell encoding fixes, the report hardening, and
everything below — do not send testers to the old tag.

## What this claims

Mendr is a **trustworthy AI model-retirement scanner and early-warning system.**
It is not "fully self-maintaining" yet, and does not claim to be. It detects
retiring AI model dependencies, explains the evidence, keeps migration decisions
under human control, and never touches your default branch.

## Since v0.2.4-alpha

**JavaScript support** — `.js/.jsx/.mjs/.cjs` are scanned with the same
conservative guards as TypeScript (first-party SDK resolution, proxy/Azure
detection, examples/catalogs kept informational, test files separate). A
JavaScript-only repo now reports real exposure instead of "inconclusive".

**The migration sandbox and human-approved PRs** — `mendr migrate` proves a
model-id swap in an isolated sandbox (a baseline-relative type-check and build,
your tests, an optional eval) and emits a portable `mendr-migration/v1`
artifact. The GitHub Action opens **one idempotent PR only when the migration
verifies**, built from that artifact. Mendr never merges; a human approves. The
button is "Prepare migration for review," not "Fix automatically".

**The Mendr GitHub App** — the hosted half, kept out of the code path. Your CI
runs the scan and posts **only the findings** (paths, line numbers,
classifications, redacted snippets, hashes), authenticated by the run's OIDC
token. The App holds `checks: write` + `metadata: read` only; it never clones or
reads your code. One-click "Set up the audit" connects a repo without any new
App permission. A five-part finding page (possible cause → evidence → confidence
boundary → migration evidence → next action), "Open in GitHub", and "Rerun
audit".

**The trust package** — a cross-package schema-compat test that blocks
incompatible releases; a stored-data inventory (no tokens, no source code);
field-level AES-256-GCM encryption at rest for stored findings with key
rotation; retention, on-demand deletion, and hard cleanup on uninstall; an
append-only audit log that never holds findings or secrets; an incident-response
plan; and privacy/security pages specific to the real system.

**Scanner and report hardening** — deterministic exit codes (`0` completed,
`1` scanner failure, `2` usage error, `3` inconclusive; `--fail-on-exposure` to
gate), so a broken or inconclusive scan never reads as clean. Test files are now
scanned as **test-only references** — surfaced as informational, never migration
candidates. Reader tie-back proves an env-var config selector is read in code.
"Nothing uploaded" is enforced by an offline guard and a build-time network-block
test. Windows/PowerShell encoding, contradictory informational actions, and long
reports were fixed in the hardening leading up to this release.

## Validation

- Root suite 72 files / 974 tests; App suite 11 files / 67 tests; both builds
  clean. The offline guarantee and the scanner↔App schema compatibility are
  tested on every build.
- Registry: verified-only auto-apply, claim-checked, human-promoted; no AI ever
  writes a production registry record without review.

## Known boundaries (unchanged, stated honestly)

- Repository scanning proves a model appears in code, **not** that production
  calls it. Runtime evidence (OTel / usage export / your read-only key) is
  optional and strengthens confidence; it is never required.
- Coverage is TS/TSX, JavaScript, Python and config, for OpenAI, Anthropic and
  Google. Other languages are reported as unanalyzed, never silently clean.
- The hosted App has not yet been deployed publicly; standing it up and creating
  the GitHub App from `/setup` are operator steps.

## Freeze

After publishing, freeze this tag. New defects go into the next alpha; do not
move or overwrite `v0.3.0-alpha`.
