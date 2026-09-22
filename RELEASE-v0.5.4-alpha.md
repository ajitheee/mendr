# v0.5.4-alpha

The release where Mendr starts naming the **SDK** a repository is pinned to, not only the model id.

Everything new here is **information only**. It is not in `--json`, not in the GitHub issue, not sent
to your Mendr App, and it cannot move a conclusion or an exit code. That boundary is the feature:
the audit's answer is unchanged, and a reviewer gets one more fact for free.

## Which provider SDK your repository actually locks

A retiring model id is half of the change a team has to plan. The other half is the client library
that calls it — a repository pinned to `openai@4` is three major lines behind the SDK the
replacement model was written against, and nothing in the audit used to say so.

`mendr audit .` now prints, in the human report only:

```
✓ Provider SDKs: 2 declared by the root project in package-lock.json — information only, never part of the conclusion
    · openai 4.104.0 — 3 newer major lines seen: 5 (2024-12-20), 6 (2025-09-30), 7 (2026-07-27) — each date is when that major was first seen, pre-releases included; latest 7.18.0; whether any of them breaks your code is not decided here (record fetched 2026-09-18T03:44:22Z)
    · @anthropic-ai/sdk 0.65.0 — npm:@anthropic-ai/sdk has never been seen above major 0; on 0.x a minor may break and the record tracks majors only, so NOT checked (latest 0.126.0; record fetched 2026-09-18T03:44:22Z)
```

and, for a Python repository, a second row read from the root `requirements*.txt` files and the
root `uv.lock`:

```
✓ Python SDKs: 3 listed in uv.lock — information only, never part of the conclusion
    · openai 2.29.0 (uv.lock) — 1 newer major line seen: 3 (2026-08-12) — …
```

A repository that only inherits an SDK gets a different mark, and the reason for it:

```
○ Python SDKs: uv.lock lists none of the 4 PyPI provider SDKs directly; part of the root was not read
    · 3 locked in uv.lock that the root project does not declare (openai, anthropic, google-genai) — another package asked for them; NOT resolved
    not read: 28 local packages in uv.lock, pyproject.toml
```

Three kinds of file, all in the repository **root**: `package-lock.json`, `requirements*.txt`,
`uv.lock` — the files that record an exact installed version. Every other lockfile in the tree is
named, never opened.

What the rows refuse to say matters more than what they say:

- **A file the reader cannot fully understand is reported as not read** — never as "none". A single
  missed line would otherwise become a confident "no provider SDK in this repository", so both
  Python readers fail closed and `uv.lock` is parsed by recognising uv's own narrow shape rather
  than by guessing at TOML.
- **Only a registry-sourced copy of an SDK the root project declares is resolved.** git, tarball,
  directory, URL and editable installs are named and skipped, because the version recorded next to
  them is not what they install.
- **An SDK that is locked but not declared** is counted separately — "another package asked for
  them" — so a repository whose transitive tree pulls in `openai` never reads as a bare ✓ "none".
- **It prints an SDK name, a version, the file name and fixed reasons.** No paths, no URLs, no
  registry hosts; a version that does not round-trip back to the SDK it claims to be is dropped
  rather than printed.
- **Majors, not minors.** The bundled release record tracks major lines. On a 0.x package it says so
  and checks nothing, because there a minor can break you and the record cannot see it.

## The same section in your Actions job summary

A run of the generated workflow (or of `reusable-audit.yml` directly) now writes the npm *Provider
SDKs* section into the run's **job summary** — the page a reviewer already opens when a check goes
red.

It never leaves your CI. Nothing about your SDKs is added to the JSON, the issue, or the POST to
your App. It is switched on by `MENDR_JOB_SUMMARY: 'on'` in the workflow's environment — an
environment variable rather than a flag, because an older pinned CLI ignores an unknown variable
where an unknown flag would fail the whole run. The section is written *after* the JSON report has
been printed, and a failure while writing it costs the section and nothing else.

## Registry

**161 entries, up from 158** — `sha256:e5f920c0fe57840f`. Three models retiring between September 30
and October 2 were added **review-only**. None of them can be applied automatically:

- `gemini-omni-flash-preview` → `gemini-omni-1.1-flash` — **unverified**: Google's own pages confirm
  the shutdown and the replacement, but no public catalog lists the replacement yet, so the gate
  refuses it.
- `gpt-5.4-cyber` → `gpt-5.6-cyber` — **quarantined**. The replacement needs separate approval and
  provisioning; the model id alone does not grant access, so an automatic edit could break a caller
  who is not provisioned. Quarantine is deliberate state: it survives a later
  `verify-registry --write`, so a future re-stamp cannot quietly turn this into an auto-apply.
- `gemini-2.5-flash-image` → `gemini-3.1-flash-image` — **unverifiable**: the replacement printed in
  the source table was itself shut down in June, and Google's pages disagree about the successor, so
  the choice stays with a human. The stored replacement was corrected, with a second evidence
  reference.

51 further candidates found by the discovery job sit in `registries/candidates.json` awaiting
review. They are not part of the shipped registry and no audit reads them.

The bundled stamp **was** regenerated this time — `2026-09-22T03:28:07Z`. v0.5.3-alpha skipped it on
purpose because its registry was byte-identical; here the bundled copy genuinely changed, and
`registry-publish` runs on the release tag, so a signed snapshot at least as new as the stamp exists
within minutes of the tag.

## Maintainer-side

- `registries/model-catalog.json` (152 models) and `registries/sdk-releases.json` (8 packages) are
  now collected, published and signed alongside the registry snapshot, and `mendr resolve` walks a
  retiring model id along its chain to a successor that is either live or explicitly not proven.
  A customer audit reads only the **bundled** copy of the SDK release record, and **nothing verifies
  that record's signature on read yet** — the gap is written down in `TRUST.md` rather than left to
  be discovered.
- `scripts/check-pins.mjs` runs in CI: every 40-character SHA a customer copy-pastes must be the one
  verified pin. It exists because the install snippet sat four releases behind the identity row and
  nothing could see the difference — one stale hex string looks exactly like a fresh one.

## Upgrading

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@v0.5.4-alpha
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@v0.5.4-alpha
```

A repository already connected moves by setting the repository variable `MENDR_SPEC` to
`v0.5.4-alpha` (or to a full commit SHA, which is the only truly immutable pin) — no workflow edit.
