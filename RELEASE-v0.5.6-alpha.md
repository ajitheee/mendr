# v0.5.6-alpha

**This is the release that delivers v0.5.5-alpha's security fix.** That fix has been sitting
green on `main` since 2026-09-23 and has reached no customer at all — not through a tag, not
through `@main`, not through any ref that exists. If you run the Mendr action today, you are
running a build that publishes your migration report **unsanitized**.

Four fixes. Three of them are mendr describing work it had not done; the fourth is the
machinery that let the first one ship to nobody.

No new features. The registry content is unchanged (`sha256:e5f920c0fe57840f`, 161 entries);
only its published-at stamp moves, to the real publish time of the snapshot it is a copy of.

---

## The sanitizer reached no execution path

`efbc526` (v0.5.5-alpha's headline) closed the chain by which an eval command carrying a
credential could be published into the body of a public pull request. `run-mendr.sh` was
changed to pipe the report through a new `mendr redact` command and to **withhold the report
entirely** rather than publish it unchecked.

None of that ran.

```
$ git show v0.5.5-alpha:mendr-action/scripts/run-mendr.sh | grep -c redact
0
```

`.github/workflows/reusable-migrate.yml` hardcodes `uses: ajitheee/mendr/mendr-action@<tag>`,
and **GitHub forbids an expression in `uses:`**. So the ref is frozen in the file: even a
customer pinning the reusable workflow at `@main` executes the *tagged* script. Every
migration run through every shipped path published the report exactly as it did before the
fix — fail-open, not fail-closed.

Nothing caught it because every pin agreed with every other pin. `scripts/check-pins.mjs`
compared 40-hex SHAs in three documents and could not see a release tag anywhere.

**What this release does about it:** all thirty-three pin positions move together, and
`check-pins` now has a third rule that prints what is merged and undelivered. Run it on this
tree and it names the four commits above by hash.

## A failed gate rendered as "nothing to run"

The CLI's five-word verification vocabulary (`passed | failed | skipped | not_run |
inconclusive`) landed in `src/` only. The App still declared the old four and coerced anything
else to `not-configured`, which it renders as an em dash.

So a build or test gate that **ran and rejected the change** was stored, and shown to the
customer, as *"there was nothing to run"* — on the dashboard, which is the one surface an
external reviewer logs into. Four of the five words collapsed that way.

1,480 tests were green over it. The cross-package contract test hand-wrote the old words into
a value it declared as `MigrationResult`, and `tsconfig.json` excludes test files, so `tsc`
never saw the mismatch.

The App now accepts **both** vocabularies and stores the five. It has to: the CLI version is
pinned per customer, in a workflow file committed to their own repo, so the old words keep
arriving long after this tag moves.

## `type-check: passed` for a repository with no TypeScript

`checkTypes` compares two ts-morph projects. When a migration patches no `.ts`/`.js` file they
are the same — often empty — project, so it returned `passed` with zero new diagnostics and
the pull-request body said so. `fix-llm` said `skipped` for the same repository.

The signal is now the **patch**, not the repository: a mixed repo whose swap happens to be
Python-only hit the identical bug, and `migrations[].language` would not have caught it either
(a parameter transform patches a `.ts` file without producing a migration row).

## The test gate published your CI runner's filesystem path

```
your tests: **could not run** — could not read package.json: Error: ENOENT:
no such file or directory, open 'D:\a\acme-api\acme-api\package.json'
```

Into a public pull request, on every run against a repository that is not a Node project.

Neither existing defence covered it. The central sanitizer matches secret *shapes* and has no
absolute-path rule — nor should it. And the pull-request body **never reaches the sanitizer**:
`run-mendr.sh` pipes the *report* through `mendr redact` and cats the pr-body file in
directly. So the fix is to not build the string.

---

## Upgrading

**The two paths differ, and this is the part a previous runbook got wrong.**

- **Audit** — set the repository variable `MENDR_SPEC=v0.5.6-alpha`. No workflow edit.
- **Migrate** — **you must edit your committed workflow.** `reusable-migrate.yml`
  deliberately does not honour `vars.MENDR_SPEC`: GitHub forbids an expression in `uses:`, so
  honouring a caller's spec would pin the CLI while leaving the wrapper on a tag, decoupling
  exactly what must stay coupled. Bump the `@<tag>` in your own `mendr-migrate.yml`, or re-run
  the one-click setup.

Running the CLI directly:

```sh
npx github:ajitheee/mendr#v0.5.6-alpha audit .
```

## Known limits, stated rather than discovered

- **The bundled registry still goes stale before the date this product is aimed at.** Its
  stamp is 2026-09-24 and the max age is 14 days, so a local `npx` run without
  `--refresh-registry` reads stale from **2026-10-08** — and OpenAI shuts off `gpt-4`,
  `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini` and `o4-mini` on **2026-10-23**. A stale registry
  still proves an exposure; it cannot prove the absence of one, so a clean repo reads
  `inconclusive`. The generated workflows set `MENDR_REGISTRY_REFRESH: 'on'` by default and
  are unaffected. If you run locally, pass `--refresh-registry`.
- **Thirteen entries retire on 2026-10-23, not the five commonly listed** — the five above
  plus `gpt-4-0613`, `gpt-3.5-turbo-0125`, `gpt-4-1106-preview`, `gpt-4-turbo-2024-04-09`,
  `gpt-4o-2024-05-13`, `gpt-4.1-nano`, `gpt-image-1` and `o1-2024-12-17`. Twelve of the
  thirteen carry a verified, auto-applicable replacement; `gpt-image-1` is review-only,
  because public catalogs do not list image models.
- **`mendr` is still not on npm.** The install path remains the GitHub tarball above.
- **Behaviour is still not verified by anything here.** The gates prove a migration builds and
  your existing tests pass. They do not prove the replacement model answers the same way.

## Verification

- root: 1492 tests, 96 files
- app: 165 tests, 16 files
- `npm run build`, app `tsc --noEmit`: clean
- `node scripts/check-pins.mjs`: OK, all 33 release pins at `v0.5.6-alpha`
- `node scripts/validate-registry.mjs`: 0 violations across 157 `model_id` records

**After tagging, prove delivery rather than assuming it:**

```sh
git show v0.5.6-alpha:mendr-action/scripts/run-mendr.sh | grep -c redact   # must be non-zero
```

Green CI proved nothing last time.
