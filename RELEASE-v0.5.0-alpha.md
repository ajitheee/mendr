# v0.5.0-alpha

The release that makes six slices of safety work installable. Everything below has been on `main`
for a few days and reachable by nobody, because the workflow templates still pinned v0.4.8-alpha.

Two of these are security or correctness fixes, not features. If you run Mendr in CI, this is the
release to move to.

## Fixed: a verification run no longer hands your CI's token to your own test code

The gates run **your** build, test and eval commands, and they inherited the whole environment —
including the migrate job's `contents: write` and `pull-requests: write` token and its OIDC request
credentials. Nothing in a test suite needs those, and handing them to arbitrary code in your
dependency tree is a privilege escalation with no upside: a compromised transitive dependency could
have pushed to your default branch using Mendr's own job token.

Your own application secrets stay in scope, deliberately — stripping those is what turns a passing
gate inconclusive and makes the tool look worse than it is.

Captured output is also redacted **at the source** now, before it leaves your machine. The App
already redacted on arrival, but by then a secret printed by a test had crossed the network.

## Fixed: a migration can no longer point at a model that is already dead

The chained-deprecation check consulted only a hand-curated table whose `google` section was empty,
so a mapping into an id **this registry itself records as retired** classified as verified. Five
such rows were staged during registry work, including `gemini-2.5-flash-image` →
`gemini-3.1-flash-image-preview`, retired 81 days earlier. Promoting one would have opened a pull
request swapping working code to a model that returns 404, under a green verified label.

## Fixed: the parameter migrates with the model

`max_tokens` → `max_completion_tokens` listed `on_models: [o1, o3, o4, gpt-5]`, and the matcher
requires an exact prefix — so it never covered `gpt-5.6-sol`, the replacement target of 20 registry
entries, or `gpt-5.6-terra` behind another 18. The two most common migrations Mendr proposes were
swapping the model and leaving a parameter the new model rejects with a 400.

The Tier A summary also described renames its own diff did not contain, because it was built from
the transforms *located* rather than the ones *applied*.

## New: suppressions that can never make a run read as clean

`.mendr/suppressions.json` — a committed file your colleagues review in a pull request like any
other change.

```
mendr suppress src/pricing.ts:42 --reason "pricing table, not a call site" --until 2026-12-01
```

Suppressed findings appear in **every** report with the reason and the author. They stop being
actionable; they never stop being visible. The conclusion is computed before suppression is applied
and never revisited, so a repository with every finding suppressed still reports
`exposure_detected`. Entries key on a semantic fingerprint, so they survive a reformat, and an
expiry brings the finding back on its own.

## New: a pull request body you can decide from

Each swap now carries the evidence that was always available and always discarded: the shutdown
date **and how far away it is**, the provider's own notice, the registry's verdict on the
replacement, the registry entry id, coupled parameters, what actually ran in verification, and what
Mendr deliberately left alone.

An id already past its date says "retired 114 days ago — calls to it are already failing" rather
than printing a date in the past and hoping you notice.

## New: an account of every file, and a parse failure fails closed

The report now prints a denominator whose categories are exclusive and add up: discovered,
analyzed, test files, languages not read, parse failures, unopenable.

Two of those categories did not previously exist. A file that could not be **opened** was swallowed
by a bare catch. A file that **parsed with syntax errors** was never looked for at all — and that
one is dangerous, because the parser is error-tolerant: a malformed file does not fail, it quietly
changes the answer. With unbalanced braces a live `chat.completions.create({ model:
'gpt-3.5-turbo-0613' })` reads as "code data reference"; balance the braces and the same line is a
"verified provider SDK call site".

Either now forces `inconclusive`. A file Mendr could not read properly cannot be evidence of
absence.

## Fixed: config written in flow style is read correctly

`llm: {model: gpt-4-0613}` was reported as a catalog reference while `model: gpt-4-0613` was a
runtime selector — the same config demoted by a brace. The config scanner also gained a parse
concept where one is possible: malformed JSON (JSONC-aware, so `tsconfig.json` is not slandered),
and a model-like key whose value is a YAML alias, which is declared unreadable rather than guessed.

## Fixed: `mendr --version` tells the truth

It was hardcoded and three releases stale, printing `0.2.0-alpha` on a 0.4.8-alpha build. It now
reads `package.json`.

## Registry

158 entries, up from 110. The 48 promoted retirements all carry evidence — a content hash, a quoted
excerpt and a stored snapshot — where none of the previous 110 did. Auto-fix eligible: 133.

## Measured

`VALIDATION-2026-09-15.md`, re-run against this build across twelve public repositories:

- One automatically fixable finding across 15,712 analyzed source files, and it is correct.
- An independent search of 4,116 occurrences of a retiring model id found nothing missed.
- Zero parse failures and zero unopenable files across the whole corpus.
- 1,135 tests.

The same document says plainly what this does not establish, including that a Tier A denominator of
one is not a rate, and that the hardening rules were written after reading those same repositories.

## Upgrading

Bump both `uses:` lines in your workflow together:

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@v0.5.0-alpha
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@v0.5.0-alpha
```

Nothing in your configuration changes. If you had a repository named `docs`, `test`, `examples` or
`e2e`, its findings were being misfiled and will now appear correctly — expect more findings there,
not fewer.
