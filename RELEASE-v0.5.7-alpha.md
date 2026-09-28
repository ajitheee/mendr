# v0.5.7-alpha

**A small release, and most of it does not reach you.** One customer-facing change, a
refreshed catalog, and a rollback floor that moves. The rest of the work since v0.5.6-alpha
was repository machinery — worth recording, not worth installing for.

The deprecation registry content is **unchanged** (`sha256:e5f920c0fe57840f`, 161 entries).
Only its published-at stamp moves, which is the point of cutting at all.

---

## The one thing a customer gets: a green that stops lying

`ajitheee/mendr-demo` has **169 workflow runs** whose `migrate / migrate` check reports
`success`. The migrate path has **never once executed**. Both are true, and the run log is
explicit about it:

```
Mendr: nothing is approved in the App for this repository; nothing to do.
  Set up Node.js                                → skipped
  Install target-repo dependencies              → skipped
  Run Mendr and open a PR                       → skipped
```

The approval gate exits 0, every later step is conditioned on
`steps.gate.outputs.proceed == 'true'` and skips, and GitHub reports a job that *started* as
a success. So the check reads green and a reader concludes a migration ran.

GitHub cannot mark a job `skipped` once it has begun, so the truth now goes where a reader
actually looks — the run page's own summary. All **three** no-op paths write one:

| path | what it now says |
|---|---|
| **403** — the App is not installed, or its installation is suspended | *"No migration ran, and none can… this job will keep reporting green while doing nothing."* |
| **nothing approved** — the ordinary hourly case | *"No migration ran… this job is green because the check itself succeeded, not because a migration did."* |
| **already claimed** — another run took them first | *"No migration ran here."* |

The 403 case is the quietest of the three: a repository disconnected from the App looks
exactly like a healthy one with nothing to do, hourly, forever.

There is also a new **`migrated`** action output, so a caller can branch on what happened
rather than on the conclusion, which cannot carry it.

None of these turns red. An hourly check that goes red for having nothing to do gets switched
off inside a week.

**Why this needed a tag.** `reusable-migrate.yml` hardcodes `uses: …/mendr-action@<tag>` and
GitHub forbids an expression in `uses:`, so even a customer pinned at `@main` runs the
*tagged* script. The fix merged on 2026-09-28 and reached nobody until this moment.
`check-pins` named it by hash every time it ran:

```
check-pins: NOTE — 1 commit(s) touch mendr-action/ or src/cli.ts since v0.5.6-alpha.
    95bffd4 fix(action): make the migrate gate say when it did nothing
```

## The bundled catalog is eleven days less wrong

`mendr catalog` and `mendr sdk-releases` had been CLI commands since Plane 1 slices 1 and 2
that **no workflow ever invoked**. They ran by hand, so both files sat frozen at 2026-09-17
while the deprecation registry moved weekly.

They are on a weekly schedule now, and the first run found real drift:

- **catalog 152 → 158 ids.** New: `gpt-6-sol`, `gpt-6-sol-pro`, `gpt-6-luna`,
  `gpt-6-luna-pro`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`,
  `claude-opus-5-5`, `claude-opus-5.5`.
- **No longer listed:** `claude-3-haiku`, `claude-opus-4`. Both are already `retired` in the
  deprecation registry (2026-04-20 and 2026-06-15), so the two sources agree — but a provider
  dropping an id from a third-party aggregator is **not** a retirement announcement and is not
  read as one.
- **5 SDK latest versions moved**, including `openai` 3.15.0 → **3.19.2**.

This matters to `mendr resolve` and to whether a future `mendr candidates promote` accepts a
replacement, because the catalog is what `candidates verify` classifies against. It does not
change what the fix engine applies today.

## The rollback floor moves

The stamp is re-run right before the tag, as the checklist requires. A downloaded snapshot
published before it is refused, so a replayed old — still correctly signed — snapshot cannot
hide a newer retirement.

Practical consequence for anyone pinned here: the bundled registry is graded fresh for 14 days
from this stamp, and after that a zero-finding scan reports `inconclusive` rather than clean.
That is deliberate.

---

## Repository machinery — recorded, not installed

None of this reaches a customer. It is here because the next person reading the history
should know why the collectors can be trusted now.

**A failing collector is no longer silent.** `registry-discover`'s scheduled run failed on
2026-09-01 — *"GitHub Actions is not permitted to create or approve pull requests"* — and
**nobody knew for 27 days**. Before this, **zero of eight workflows reported their own
failure**. Both registry workflows now keep one marker-based issue, reopened on failure and
closed by the next successful run.

The failure path was **exercised on purpose** rather than trusted: `registry-refresh` takes a
`simulate_failure` dispatch input, issue #25 was raised by a deliberately failed run and
closed by the next good one, with the raise and stand-down steps firing on exactly inverted
conditions. This repository has now shipped two paths that passed their tests and had never
once executed — the sanitizer and the Approve button — and an untested alarm would have been
a third.

**`PLANE-1.md` was corrected**, and in the unusual direction: it read *worse* than the code.
Open item 3 claimed the catalog and SDK record were "published but nothing verifies them",
which sounds like a live trust hole. Nothing verifies them because **nothing fetches them** —
`freshRegistry.ts` declares exactly three remote assets, and the catalog and SDK record are
only ever read from the bundled copies. The `.sig` files serve external feed consumers.
Recorded as a decision, not an omission.

**One test was under-specified, not flaky.** `--write with --skip-verify proves nothing and
applies nothing` shells out through `runMigration` exactly like the four tests above it, and
was the only one left on vitest's 5-second default — 24× less time for the same work. It was
red on this release's gate run and passed alone, which is the signature of a bad timeout
rather than a bad product.

---

## Known and unchanged

**The Approve button still fails silently**, and it is the reason the migrate path above has
never run. Eliminated so far: the route (302 anonymously, so it exists), the form (real POST,
real `type="submit"`, no orphaning nesting), the live-poll script, failed dispatch, cold
start, the signed-out path, the in-flight guard, the GitHub timeout and unhandled throws.
What settles it is one line from the Render log — `approve clicked` is the first statement in
the handler, before the session check.

Until that is fixed, the report **sanitizer has still never run on a customer path**, because
`run-mendr.sh` is only reached after an approval is claimed. Every "rehearsed on mendr-demo"
note remains an *audit* rehearsal only.

**The catalog still has no age check.** `mendr resolve` says "a public catalog lists it" from
a catalog of any age. The weekly refresh makes staleness less likely, not impossible.
