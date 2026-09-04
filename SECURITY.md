# Security policy

Mendr scans repositories for retiring AI dependencies. It runs where your code
already lives and, by default, makes no network calls. The full statement of
what it reads, writes and sends, the threat model and the known gaps is in
[TRUST.md](TRUST.md). This file is about reporting problems with that.

## Supported versions

Only the newest tagged release receives fixes. Tags are never moved or
overwritten; a fix ships as the next tag.

| Version | Supported |
|---|---|
| Newest `v0.2.x-alpha` tag | Yes |
| Older tags | No. Upgrade by changing the tag in your `npx` spec or workflow. |
| `main` | Best effort. It is the next release in progress. |

## What counts

Anything that breaks a claim in TRUST.md is in scope, in particular:

- The default audit making an outbound network call, or repository contents
  leaving the machine by any path.
- A committed secret surviving redaction in the issue body or JSON snippets.
- Repository-controlled text (paths, strings, file contents) injecting into the
  tracking issue, forging its state block, or altering the verdict.
- A wrongly closed tracking issue or a "clean" verdict with incomplete coverage.
- The scaffolded workflow or `mendr-action` needing, or being able to use, more
  permission than TRUST.md states.
- `fix-llm --write` touching files outside the reported locations.
- A dependency or build step that changes any of the above.

Findings about the scanner's accuracy (a missed model, a wrong tier) are
welcome too, but please file those as ordinary issues with a minimal fixture.
They are not security reports unless they hide a real retirement by design.

## How to report

Use GitHub's private vulnerability reporting for this repository:

https://github.com/ajitheee/mendr/security/advisories/new

Please include the version or commit, the command line, a minimal repository
or fixture that reproduces it, and what you expected. Do not open a public
issue for a security problem until a fix has shipped.

## What to expect

- Acknowledgement within **three business days**.
- An assessment and a plan within **ten business days**.
- A fix in a **new tag**, never a moved one, with the advisory named in
  `CHANGELOG.md`, and credit to you unless you ask otherwise.
- If a report shows that a claim in TRUST.md is wrong, TRUST.md is corrected in
  the same release, even if the fix takes longer.

## Safe harbour

Good-faith testing against your own repositories, your own forks, or this
repository is welcome. Please do not test against other people's repositories,
do not run scans that could degrade GitHub or a provider's service, and do not
access data that is not yours. We will not pursue action against research that
follows this policy.
