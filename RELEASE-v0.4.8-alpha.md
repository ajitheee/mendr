# mendr v0.4.8-alpha — the public-beta pin

Supersedes `v0.4.7-alpha`; every earlier pin keeps working unchanged. This is
the tag the 20 September 2026 public beta ships on: the App generates caller
workflows against `reusable-audit.yml@v0.4.8-alpha` and
`reusable-migrate.yml@v0.4.8-alpha`, and both pin `mendr-action@v0.4.8-alpha`
and the CLI at `github:ajitheee/mendr#v0.4.8-alpha`. A tag is immutable; a
later fix ships as `v0.4.9-alpha` and partners move when they choose.

## What changed

**A repository removed from the App no longer turns red every hour.** The
approvals check treats the App's "not installed" answer as "nothing to do":
one notice, a green skip. The daily audit still fails visibly on such a
repository, which is the right signal that the workflow file is orphaned.

**The Mendr mark.** A lowercase m built from one rail and three legs, the way
three model calls hang off one dependency trace; the third leg stops one
stroke short and an amber node sits where its foot should be — the retiring
dependency, caught before it drops. It is the wordmark's own first letter.
Favicon, App header and site header use it; `brand/` carries the SVG, PNG and
lockup files with the usage rules.

**Privacy, security and TRUST wording checked against the system as built.**
What leaves your CI is stated exactly — a signed findings report per scan and,
on migration runs, the outcome, branch, pull-request number, registry
provenance and a redacted diff hunk; never a whole file, never a clone, never
a key. The optional `actions: write` grant, the registry GET and the
"inconclusive, never clean" rule, the three subprocessors, the personal data
held and how to exercise rights, and what uninstall deletes are all on the
page.

**Partner beta outreach** (`docs/partner-outreach.md`): who to ask, the
message, what we ask of a partner and what we promise.

## Upgrading

Nothing to do for a repository connected through the App: regenerate the
caller file from the repository's page if you want the new pin, or leave the
old one — it keeps working. CLI users: replace `v0.4.7-alpha` with
`v0.4.8-alpha` in the `npx` command.

## Verification

Released only after the tagged package audited a real repository with a fresh
signed registry, the registry-publish run for the tag was green, the App
deployed on the release commit and reported `encryption.enabled: true` with
`decrypt: ok`.
