# v0.5.11-alpha

**The release that stops calling a repository clean while calls are held for review.** In
v0.5.10-alpha, when every retiring model id `migrate` found was held for a person, it printed
`NO MIGRATION — no verified Tier-A swap was found` and listed none of them. The GitHub Action then
reported the repository clean and closed an open Mendr pull request with "Mendr: no deprecated model
ids remain; closing." v0.5.10-alpha holds more calls than v0.5.9-alpha, so this happened more often.
It was the first Known issue in v0.5.10-alpha's notes.

This tag:

- makes `migrate` list every call it held, and gives a run that held everything its own verdict,
  `held_for_review` (section 1);
- makes `migrate` read every file `fix-llm` reads, including files your `tsconfig.json` does not
  compile (section 2);
- changes what the Action does when it applied nothing: a new `held-for-review` outcome, a narrower
  rule for closing a pull request, a warning on an open one, and a size cap on the pull request
  description (section 3).

The hosted App learned the new outcome when #63 merged and the App redeployed, not with this tag
(section 4).

The deprecation registry does not change: `sha256:e0464cc70ab44d9d`, 223 entries, as in
v0.5.10-alpha. Its release stamp moves, which moves the rollback floor (section 6). `audit`,
`fix-llm` and `watch` gave the same results on both builds in every probe (section 5).

The Action change reaches a migrate workflow only when that workflow's ref moves to this tag, and
the one-click migrate workflow needs a workflow edit for that (Upgrading).

---

## What a customer gets

### 1. `migrate` lists every held call, and a run that held everything is not "no migration"

Each row was run on both builds with `migrate --skip-verify` and `migrate --skip-verify --json`,
offline, with the bundled registry:

| repository | v0.5.10-alpha | v0.5.11-alpha |
|---|---|---|
| `const MODEL = 'claude-opus-4-1-20250805'` used with `max_tokens` (TypeScript), and `create(model="gpt-3.5-turbo", …, max_tokens=20)` (Python) | `NO MIGRATION`, verdict `no_migration`, `skipped: []` | `HELD FOR REVIEW`, verdict `held_for_review`, both calls in `skipped` |
| an `o1-mini` call (replacement unverified) and the same Opus 4.1 const call | `NO MIGRATION`, verdict `no_migration`; `skipped` holds the `o1-mini` call only, and the human report lists nothing | `HELD FOR REVIEW`, verdict `held_for_review`, both calls listed |
| the two held calls of row 1, plus an inline `gpt-4-0613` call | swap to `gpt-5.6-sol`, `skipped: []` | the same swap; both held calls listed in the report, in `skipped` and in `--pr-body` |
| a `gpt-5.6-sol` call, nothing retiring | `NO MIGRATION`, `no_migration` | `NO MIGRATION`, `no_migration`, with new wording |
| `model: gpt-4-0613` in `config/llm.yaml`, no model id in the code | `NO MIGRATION`, `no_migration` | `NO MIGRATION`, `no_migration` (Known issues) |

What `migrate` printed for row 1 (the two sentences after each held call are shortened here):

```
HELD FOR REVIEW — nothing was migrated, and this repository is not clean: every retiring model id found needs a person (listed below).
  Nothing could be migrated automatically: 2 places in the code use a retiring model id that Mendr held for a person to review (listed under "Held for review"). Nothing was applied and nothing was verified.

Held for review (2) — retiring model ids Mendr found and did not change, because a person has to decide:
  src/ask.ts:3  claude-opus-4-1-20250805 (replacement on record: claude-opus-4-8)  [coupled_param_unverified]
    the replacement claude-opus-4-8 may not accept the parameter `max_tokens` that this call passes, …
  app/llm.py:5  gpt-3.5-turbo (replacement on record: gpt-5.6-terra)  [param_behaviour_change]
    moving from gpt-3.5-turbo to gpt-5.6-terra changes what this call asks for: …
Run `mendr fix-llm` or `mendr audit` on this repository for the evidence behind each one.
```

- **Which calls are listed:** every Tier B occurrence `fix-llm` reports, in TypeScript, JavaScript
  and Python, with the reason code `fix-llm` and `audit` give it. That covers held calls
  (`coupled_param_unverified`, `param_behaviour_change`, `surface_capped`, which includes fine-tunes
  and example trees), untraced settings (`usage_unverified`), casts (`type_cast_masked`), unverified
  replacements (`replacement_unverified`) and Azure deployment aliases (`platform_blocked`).
  v0.5.10-alpha listed only the last two kinds, and only in TypeScript.
- **`migrate` can list more.** It also reads every file its own TypeScript program loads. In a
  repository with no `tsconfig.json`, that includes build output in `dist/`, `build/` and `out/`,
  which `fix-llm` and `audit` skip (Known issues).
- **Where they are listed:** under *Held for review* in the human report, whether or not something
  was migrated, and in `skipped` in `--json`. `fix-llm` now builds its Tier B list from the same
  code, so the two commands classify a held call the same way; its output did not change in our
  probes (section 5).
- **`NO MIGRATION` now says what it covers:** "NO MIGRATION — no verified Tier-A swap was found in
  the source code, and nothing there was held for review. Nothing to apply. Configuration files are
  not read by migrate; `mendr audit` lists a retiring model id set in one."
- **The pull request evidence block** (`--pr-body`) lists held calls under *Left alone* with their
  code, and says merging does not resolve them. It names at most 50, then points to the job summary
  for the rest. It now goes through the same secret sanitizer as the report, because it carries the
  scanner's sentences. It is written only when a model is swapped. A pull request whose only change
  is a parameter edit has no evidence block, and lists held calls only in the copy of the full
  report under its description, which is cut to fit when the description would be too long
  (section 3).
- **With `--only`** (an approval-gated run), the list covers only the approved models. On the row-3
  repository, `--only anthropic/claude-opus-4-1-20250805` gave `held_for_review` with one call, and
  `--only openai/gpt-4-0613` migrated `src/go.ts` with an empty list.
- **Exit codes do not change.** `held_for_review` exits 0, as `no_migration` does. Without `--write`,
  only a failed gate exits 1.

### 2. `migrate` reads every file `fix-llm` reads

v0.5.10-alpha's `migrate` read only the files in the repository's own TypeScript program, as its
`tsconfig.json` defines it. `fix-llm` and `audit` read every JavaScript and TypeScript source file
in the repository except test files and the folders `node_modules`, `.git`, `dist`, `build`, `out`,
`.next` and `coverage`. So a call in a file the `tsconfig` leaves out was invisible to `migrate`,
whether it was a swap or a held call. v0.5.10-alpha's notes did not list this. `migrate` now adds
every source file whose text names a registry id, as `fix-llm` does. It still reads every file its
own program loads too, so it can read files `fix-llm` skips (section 1). Each row has
`"include": ["src"]` in `tsconfig.json`, with the call in `server/`:

| call in `server/` | v0.5.10-alpha `migrate` | v0.5.11-alpha `migrate` |
|---|---|---|
| the const Opus 4.1 call with `max_tokens` | `no_migration`, `skipped: []` | `held_for_review`, listed |
| an inline `gpt-4-0613` call with no parameters | `no_migration` (v0.5.10-alpha's `fix-llm` reports it as Tier A) | swap to `gpt-5.6-sol` |
| `const model = 'gpt-5.6-sol'; create({ model, max_tokens: 256 })` | `no_migration` | `max_tokens` renamed to `max_completion_tokens` |

The test suite pins the same for a `.js` file when `allowJs` is off. The type-check gate compares
the patched code with the same set of files unpatched, so a `.ts` file your build never compiles can
fail the gate only with an error the swap brings in. A `.js` file outside `allowJs` cannot fail it
at all, because TypeScript does not read that file (Known issues).

### 3. The Action: what a run that applied nothing means

When `migrate` changed no file, the Action now tells three cases apart. Only the first is clean.

| `outcome` | when | an open Mendr pull request |
|---|---|---|
| `clean` | verdict `no_migration` and a held count of exactly 0 | closed, but only by a run that was not approval-gated |
| `held-for-review` (new) | verdict `held_for_review`; or `no_migration` over a non-empty `skipped` list (an older CLI); or a `skipped` list that cannot be counted | left open, with one comment saying Mendr no longer verifies it |
| `not-verified` | a migration existed but did not verify | untouched, as before |

Each row below was run through `mendr-action/scripts/run-mendr.sh` from both tags, with `npx`,
`npm`, `gh`, `git` and `jq` replaced by stubs, as `src/migrate/actionOutcome.test.ts` does, and
with an open Mendr pull request, #7, in the stub. The artifact and report came from each build's own
CLI. Nothing reached GitHub.

| repository | v0.5.10-alpha Action | v0.5.11-alpha Action |
|---|---|---|
| held calls only (section 1, row 1) | `clean`; closes PR #7 with "Mendr: no deprecated model ids remain; closing." | `held-for-review`; no close; one comment on PR #7 |
| `o1-mini` and the Opus 4.1 const (section 1, row 2) | `clean`; closes PR #7 | `held-for-review`; no close; one comment |
| nothing retiring | `clean`; closes PR #7 | `clean`; closes PR #7 with the new comment below |
| the retiring id only in a config file | `clean`; closes PR #7 | `clean`; closes PR #7 (Known issues) |
| nothing retiring, approval-gated | `clean`; closes PR #7 | `clean`; PR #7 left open |

- **Held calls are said whether or not the run migrates something.** Whenever the artifact's held
  count is not zero, the log carries a warning annotation and the job summary a line under the
  report, for example: "Mendr: 2 places in the code still use a retiring model id and need a
  person. They were held for review, not migrated, so this repository is not clean." The warning
  and the summary line carry only that count. The calls themselves are listed in the sanitized
  report above that line and, on a run that opens or updates a pull request, in its description's
  evidence block (up to 50, section 1).
- **A held-for-review run opens no pull request.** It leaves an open Mendr pull request open, because
  closing it would say the repository is resolved. That pull request came from an earlier run, and
  its body still says Mendr verified its swap. So the run comments on it once:

  ```
  <!-- mendr-bot:held-for-review held=2 only= -->
  **Mendr no longer verifies this pull request.**

  Mendr: 2 places in the code still use a retiring model id and need a person. They were held for review, not migrated, so this repository is not clean.

  Mendr's latest run made no verified change in this repository, so no change on this branch is verified by Mendr any more. If this branch swaps one of those places, that is a swap Mendr now holds for a person instead of making. Do not merge on the strength of the earlier verification: check each change by hand, or close this pull request.

  Each held call is listed with its reason in the job summary of that run: <run URL>. `mendr audit` and `mendr fix-llm` give the evidence.
  ```

  The first line names the count and the scope. When a comment on the pull request already carries
  that line, the run does not comment again; a new count or a new scope is said again. On an
  approval-gated run, the third paragraph speaks only for the approved models. A comment that fails
  to post is a warning, never a failed job. With no open Mendr pull request, nothing is posted.
- **A clean run's closing comment says what was checked:** "Mendr: nothing in the source code Mendr
  migrates (TypeScript, JavaScript and Python) is left to migrate or held for review, so this pull
  request is no longer needed; closing. This check does not read configuration files: `mendr audit`
  lists a retiring model id set in one."
- **An approval-gated run never closes a pull request.** It looked only at the approved models, so
  it cannot say the repository is clean, and the open pull request may carry another model's swap.
  The one-click migrate workflow (`reusable-migrate.yml`) always runs approval-gated, so from this
  release it never closes a Mendr pull request. Close a stale one by hand. Only an Action workflow
  you wrote without `approval-gated` still closes one.
- **The pull request description stays under GitHub's 65,536-character limit.** The description
  carries the full Mendr report under the evidence block, and the report now lists every held call.
  The copy in the description is cut at a whole line to what fits, and says where the whole report
  is: the job summary of the run that last updated the pull request. v0.5.10-alpha embedded the
  report uncut. The test suite pins a verified migration with 250 held calls opening, and updating,
  a pull request whose description is under the limit, while the job summary lists all 250.
- **The App gets the count, never the list.** The report sent to your Mendr App adds
  `heldForReview`, the number of held calls. Their paths and sentences stay in your CI.
- **An App older than #63 refuses `held-for-review`** with HTTP 400. The Action logs a warning and
  the run is otherwise unaffected. The hosted App has the change (section 4).

### 4. The App shows a held run as needing a person

This shipped when #63 merged and the hosted App redeployed, not with this tag. The `app-deploy` run
for #63's merge commit (38120418200) passed its smoke check at 07:10:26Z on 2026-10-11. That check
waits until the deployed commit answers on `mendr-app.onrender.com`.

- The App accepts the outcome `held-for-review`, the verdict `held_for_review`, and `heldForReview`,
  kept only as a whole number from 0 to 1,000,000. A list sent in its place is dropped.
- A report that says `clean` with `heldForReview` above 0 is stored as `held-for-review`. The count
  decides, not the word.
- The approval the run carried out closes, with the detail "held for review: 2 places in the code
  still use a retiring model id and need a person. Nothing applied, no pull request, not resolved."
  It shows a warning chip, "held for review", instead of the green "done". Approving again would
  hold the same calls.
- The migration card shows "held for review — nothing applied, no PR, not resolved" and the count.
  The next action says to change each call by hand, and that the next completed scan confirms the
  resolution.
- An Action older than this tag, running its own CLI, still reports a held-only run as `clean` with
  no count, and the App still shows it as "nothing to migrate".

When this release is merged to main and the App redeploys, the App's one-click setup hands out
`v0.5.11-alpha` (`MENDR_CLI_SPEC` in `app/src/config.ts`). Until then it hands out `v0.5.10-alpha`.

### 5. If you read `migrate`'s output in CI or JSON

- **`migrate --json` stays `mendr-migration/v1`, with the same top-level fields.** Not every change
  is additive:
  - `verification.verdict` has a new value, `held_for_review`, where v0.5.10-alpha gave
    `no_migration`. A consumer that switches on every verdict, or treats an unknown one as clean,
    has to handle it.
  - Each `skipped` item gains `column`, `replacement`, `code` and `language`. `file`, `line`, `model`
    and `reason` keep their meaning, and the sentences for an unverified replacement and an Azure
    alias are unchanged word for word (checked on the `o1-mini` call).
  - `skipped` holds more items (section 1). They are in the order `fix-llm` prints its Tier B
    section: by reason, in a fixed order that starts with `replacement_unverified`,
    `coupled_param_unverified` and `param_behaviour_change`, then by file, line and column. This is
    not an alphabetical sort of `code`.
  - `notes` for a held-only run carries a new sentence. The `no_migration` note is unchanged.
  - A repository with code outside its `tsconfig` can now get `migrated: true` where it got `false`
    (section 2).
- **The human report changes.** A held-only run prints `HELD FOR REVIEW`, not `NO MIGRATION`, and the
  `NO MIGRATION` line itself is reworded (section 1). A script that searches for `NO MIGRATION` no
  longer finds it on a held-only run.
- **The Action's `outcome` output** has a new value, `held-for-review`. A step that tests for
  `clean` no longer sees it on a held-only repository. `pr_url` is empty, as for `clean`.
- **The Action and `migrate` can propose a change where they proposed none.** A swap or a parameter
  edit in a file outside the `tsconfig` is now made (section 2). So the Action can open a Mendr pull
  request on a repository where v0.5.10-alpha opened none. One whose only change is a parameter edit
  has no evidence block in its description (section 1).
- **The App report** (`mendr-migration-report/v1`) adds `heldForReview`, and new outcome and verdict
  values.
- **`audit`, `fix-llm` and `watch` do not change.** On nine probe repositories, `fix-llm --json`,
  `audit --json` and `watch --json` gave the same output on both builds, apart from fields that carry
  a time, a version or a path. A committed `.mendr/exposure.json` records the registry's content
  hash, which did not change, so it should not change on upgrading.

### 6. The rollback floor moves

The registry's content is unchanged, but its release stamp moved from 2026-10-11T02:08:07Z to
2026-10-11T07:10:25Z, right before the tag. The stamp is also the rollback floor: a signed snapshot
published before it is refused. With registry refresh on, the run uses the bundled copy instead
(below). A copy you point `MENDR_REGISTRY_FILE` at, with its `manifest.json` and `manifest.sig`
beside it, stops the run. On this build, `audit` and `migrate` with a copy of the
03:13:46Z snapshot exited 1 with "snapshot published 2026-10-11T03:13:46Z is older than this
scanner's bundled registry (2026-10-11T07:10:25Z) — refusing a rollback". v0.5.10-alpha used the
same files. Copy the snapshot again after `registry-publish` runs on this tag.

- The snapshot `registry-publish` made for the v0.5.10-alpha tag was published at 03:13:46Z, below
  the new floor. Until `registry-publish` runs on this tag, a v0.5.11-alpha run with registry
  refresh on refuses it and uses the bundled copy, which holds the same 223 entries. It prints:
  "mendr: registry refresh not applied — snapshot published 2026-10-11T03:13:46Z is older than this
  scanner's bundled registry (2026-10-11T07:10:25Z) — refusing a rollback". The bundled copy is
  graded fresh, so a scan that finds nothing is not made inconclusive.
- `registry-publish` runs when a release tag is pushed, as it did for v0.5.10-alpha. After that, a
  refreshed scan uses the new snapshot.
- The bundled registry grades fresh for 14 days from the stamp, until 2026-10-25 07:10 UTC.

---

## Upgrading

- **CLI:** `npx github:ajitheee/mendr#v0.5.11-alpha audit .`. Only `migrate` gives different results,
  unless you point `MENDR_REGISTRY_FILE` at a copy of the signed snapshot (section 6).
- **Audit and watch workflows:** set the repository variable `MENDR_SPEC=v0.5.11-alpha`. No workflow
  edit is needed. Their results do not change in this release (section 5).
- **Migrate workflow: a workflow edit is required.** It is the only way the Action change in
  section 3 reaches the one-click migrate job.
  - On the `uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@…` line, change the ref
    (`v0.5.10-alpha`, or the commit SHA you pinned) to `v0.5.11-alpha`.
  - If you used the one-click setup, that line is in the `migrate` job of `mendr-audit.yml`. Change
    the audit job's `uses:` line to the same ref too, so the file's two lines stay on one release as
    its comment asks. Still set `MENDR_SPEC`, which overrides that pin when it is set. Only
    repositories connected before the one-click setup have a separate `mendr-migrate.yml`.
  - You can also re-run the one-click setup, once the App hands out `v0.5.11-alpha` (section 4).
  - `reusable-migrate.yml` cannot honour `MENDR_SPEC`, because GitHub forbids an expression in
    `uses:`. It pins the Action and the CLI to the same release itself.
- **A hand-written Action workflow:** change both `uses: ajitheee/mendr/mendr-action@…` and
  `mendr-spec`. They must name the same release. On the held-only repository, the v0.5.11-alpha
  Action running the v0.5.10-alpha CLI still reported `clean` and closed the open pull request,
  because that CLI does not list held calls. The v0.5.10-alpha Action running the v0.5.11-alpha CLI
  reported `not-verified` and left the pull request alone.
- **An open Mendr pull request after upgrading:** a held-for-review run comments on it (section 3).
  On the one-click migrate workflow, a run happens only when a person approves a migration in the
  App. The App offers that only on a finding with a call Mendr can patch, so a pull request for a
  model whose calls are now all held gets no run and no comment. A one-click migrate workflow also
  no longer closes it. If an earlier release opened it for a swap this release holds, its
  description still says Mendr verified that swap. Check it by hand, and close it if you will not
  merge it.
- **Registry refresh:** the registry did not change, so a workflow with refresh on needs nothing. If
  you point `MENDR_REGISTRY_FILE` or `MENDR_REGISTRY_URL` at your own copy of the signed snapshot,
  copy it again after `registry-publish` runs on this tag, because a copy published before
  2026-10-11T07:10:25Z is refused (section 6). A workflow that does not set
  `MENDR_REGISTRY_REFRESH: 'on'` uses only the bundled registry, which grades stale after
  2026-10-25 07:10 UTC; a zero-finding audit is then inconclusive. Such workflows are an audit
  workflow generated before 2026-09-06, a migrate workflow generated before 2026-09-09, and a
  hand-written Action workflow such as `mendr-action/examples/mendr.yml`. Add the line, or re-run
  the one-click setup.

---

## Known issues

Fixed since v0.5.10-alpha, so no longer listed:

- `migrate` and the Action not disclosing held calls, which let the Action call a repository clean
  and close its Mendr pull request (sections 1 and 3). What remains is listed below.

Also fixed, and not listed in v0.5.10-alpha's notes: `migrate` not reading files the repository's
`tsconfig` leaves out (section 2).

Still open, or new:

- **A repository whose only retiring ids are in configuration files still reads clean.** `migrate`
  does not read configuration files. With `model: gpt-4-0613` in `config/llm.yaml` and no model id
  in the code, `audit` reports `EXPOSURE DETECTED` with a review-required config selector at
  `config/llm.yaml:2`, `fix-llm` finds nothing, `migrate` reports `NO MIGRATION`, and the Action
  reports `clean` and closes an open Mendr pull request. The `NO MIGRATION` line and the closing
  comment now say that configuration files were not read, and point to `mendr audit`. Counting a
  config selector as held was not done in this release. Read `audit` before you trust a clean
  `migrate` result or a closed Mendr pull request.
- **`migrate` reads build output that `audit` and `fix-llm` skip.** In a repository with no
  `tsconfig.json`, a held call in `dist/`, `build/` or `out/` makes `migrate` report
  `HELD FOR REVIEW` and the Action report `held-for-review`. In the same repository `audit` reports
  no exposure and `fix-llm` finds nothing, so the report's pointer to them shows no evidence. A swap
  there is made, as it was in v0.5.10-alpha.
- **A change in a `.js` file outside `allowJs` is reported as "type-check passed", though nothing
  checked it.** `migrate` now patches such a file (section 2). With `allowJs` off, TypeScript leaves
  the file out of the program, so the type-check gate reads none of it, not even its syntax. On a
  repository with `"include": ["src"]` and no `allowJs`, a const `gpt-4-0613` in `server/ask.js` was
  swapped with "type-check passed". Your build may not compile that file and your tests may not run
  it. A pull request can then call such a change verified on gates that never read it. Check by
  hand any Mendr change in a file your build does not compile.
- **A Python swap that fails the syntax check disappears from `migrate`.** `migrate` re-parses each
  Python file it patched. If any patched file parses with more syntax errors than before, it drops
  every Python swap in the run, and lists none of them as held. No note says so. If nothing else was
  found, the verdict is `no_migration` with an empty list, and the Action reports `clean` and closes
  an open Mendr pull request. We reproduced this only with a registry passed through
  `MENDR_REGISTRY_FILE` whose replacement for `claude-3-5-sonnet-20241022` breaks out of the string
  literal: `audit` reported the call as patch eligible, `migrate` printed `NO MIGRATION … nothing
  there was held for review`, and the stubbed Action closed the pull request. No replacement in the
  shipped registry contains a character that could break a string.
- **`clean` counts Tier A and Tier B only.** A retiring id the scanner reports as data (Tier C) does
  not hold a run, including the live calls it still misreads as data (below). Example:
  `model: 'gpt-4-0613' satisfies string` is Tier C, `audit` reports no exposure, and `migrate`
  reports `NO MIGRATION`, so the Action would close an open Mendr pull request.
- **The Action and the CLI must be on the same release** for this fix to work (Upgrading). The
  v0.5.11-alpha Action running the v0.5.10-alpha CLI still closes the pull request on a held-only
  repository.
- **The warning on an open pull request is said once per count and scope.** If the held calls
  change but their number does not, no new comment is posted. The pull request's description is not
  edited, so it still says its swap was verified; only the comment says otherwise.
- **Anthropic's `max_tokens` is treated as model-dependent when the replacement is in a family a
  sampling rule names.** That family is `claude-opus-4-8` for Claude 2, Claude 3 Opus, Opus 4 and
  Opus 4.1, and `claude-sonnet-5-5` for Sonnet 4.5.
  - Such a call that passes `max_tokens` goes to review (`coupled_param_unverified`) instead of
    being patched, in TypeScript and Python. `migrate` now lists it.
  - Those Opus models are already past their shutdown dates, so these calls already fail.
  - The finding's sentence says the replacement "may not accept the parameter `max_tokens`". For a
    Sonnet 4.5 call that also passes `temperature`, it names `max_tokens` and not `temperature`.
    The record's quarantine reason does name sampling parameters.
- **In Python, a swap the guard does not hold keeps every parameter as written.** Python has no
  parameter pass. The guard does not read:
  - keys a caller passes through a function's `**kwargs`. Example: `def ask(messages, **kwargs)`
    calling `create(model="gpt-4-0613", …, **kwargs)`, invoked with `max_tokens=256`, is swapped to
    `gpt-5.6-sol` (re-run on this build);
  - a dict it cannot see (`**self.params`, a call result);
  - a parameter nested in another argument. Example: `extra_body={"max_tokens": 256}` is swapped
    with the key kept;
  - a key added to the dict in another function;
  - a model passed on under another name: a local copy (`m = MODEL`), a function parameter fed at a
    call (`ask(MODEL, [])`), an attribute a constructor sets from one (`Bot(MODEL)` with
    `self.model = model`), or a name imported from another module. Each is swapped to
    `gpt-5.6-sol` with `max_tokens=256` kept;
  - a class attribute read through an object outside its class (`cfg.model` for a dataclass
    field).

  Separately, a call whose old model is already under the same rule stays Tier A and keeps its
  parameter: `o3-mini` with `max_tokens=256` is swapped to `gpt-5.6-sol` with `max_tokens` kept.
  The rule says the old model rejected that request too. Check Python swaps by hand.
- **In TypeScript, the same rule-already-applied case lands its parameter fix only where the fix can
  read the model.** Shapes where it cannot:
  - a request whose model is `this.model` (example: a class field `model = 'o3-mini'` and
    `create({ model: this.model, max_tokens: 256 })` is swapped with `max_tokens` kept);
  - a fallback or a ternary;
  - a model-like key other than `model`;
  - a `let` that is assigned again. Example: `let model = 'o3-mini'; if (cheap) model = 'gpt-4.1'`
    with `model: model, max_tokens: 256` is swapped to `gpt-5.6-sol` with `max_tokens` kept.
- **In TypeScript, a request that reads a copy of the model under another name is not read.**
  Example: `const model = 'gpt-4-0613'` used by one call with no parameters, and
  `const m = model; create({ model: m, max_tokens: 5 })` in another function. The const is a Tier A
  swap and the second request keeps `max_tokens`. Check such calls by hand.
- **In TypeScript, the parameter check does not read keys spread into a request.**
  `const defaults = { max_tokens: 256 }; create({ model: 'gpt-4-0613', ...defaults, messages })` is
  a Tier A swap to `gpt-5.6-sol` with `...defaults` kept (re-run on this build). So is
  `...{ max_tokens: 256 }` written in the call. Python reads the same keys:
  `create(model="gpt-4-0613", **defaults)` is held (`param_behaviour_change`). Check by hand any
  TypeScript swap whose request spreads in options.
- **Calls in other files are not read.** A declaration is linked only to requests in its own file.
  Example: `export const MODEL = 'gpt-4-0613'` in `models.ts` is used there by a call with no
  parameters, and imported into `chat.ts` by a call that passes `max_tokens`. The const is a Tier A
  swap, and the `chat.ts` request keeps `max_tokens` (re-run on this build). Check such calls by
  hand. The same limit means a gateway-prefixed const imported from another file does not hold the
  calls that use it. Example: `export const GW_MODEL = 'openai/o3-mini'` in `models.ts`, used in
  `chat.ts` as `create({ model: GW_MODEL, fallbacks: [{ model: 'o3-mini', max_tokens: 6 }] })`. The
  nested `max_tokens` is renamed, while the same call with the const declared in its own file is
  left as written.
- **Held-call shapes the parameter pass cannot tie yet** are listed in the README ("Held calls: what
  is and is not protected"). A parameter rule can still edit these:
  - the held call's model read as `this.model`, or the held id under a model-like key other than
    `model`;
  - a nested request reached by indexing, a property read, a callback, or a call inside the
    arguments;
  - a request built in a variable whose model is not a literal written in that object
    (`const req = { model: MODEL, … }`), or spread in from one;
  - a second, unheld model value inside a held call, which can still be swapped.
- **Some live calls are still reported as data (Tier C).** Read the Tier C list for ids you know are
  called. Such a call does not hold a `migrate` run either (above):
  - a config object declared in another file and read through a property path
    (`config.integrations.chatGPT.model`);
  - a request body built in a variable and passed through `JSON.stringify` to a raw `fetch`;
  - a runtime fallback returned from a helper (`return process.env.MODEL ?? 'o4-mini'`) and passed
    as `model: pickModel()`;
  - a positional constructor argument (`new OpenAiCompletionProvider(modelName || 'gpt-4-turbo', {})`);
  - a model kept under another key and read back (`opts.modelName`).
- **`satisfies` or `<T>` around a model value or a call's argument hides the call from the
  scanner.**
  - `model: 'gpt-4-0613' satisfies string` is reported as data (re-run on this build).
  - A proxy call written `create(<any>{ model: 'o3-mini', max_tokens: 256, … })` is reported as data,
    not held, and its `max_tokens` is renamed.
- **A Tier B call with an unverified replacement still gets parameter edits.** `o1-mini` with
  `max_tokens` is `replacement_unverified`, and `max_tokens` is still renamed in that call. On this
  build, `migrate` on such a call alone reports "Migration: 0 models across 1 file", with the
  rename in its diff and the `o1-mini` call under *Held for review*. When its gates verify, the
  Action can open a pull request whose only change is that rename. Its description has no evidence
  block, so the held call appears only in the full report under it (section 1).
- **The parameter pass has no surface rules of its own.** A sample or proxy call on a model that is
  not retiring is not held, and a parameter rule can still apply to it.
- **A gateway-prefixed id loses its record in `fix-llm`** when it sits behind an `as` cast
  (`type_cast_masked`). It shows as unverified with no entry id; `audit` names the record.
- **In Python, a file that names a local proxy host holds every client in it.** A direct SDK call in
  such a file is held for review (`surface_capped`).
- **Fine-tunes, not covered yet:**
  - A fine-tune id in a config file (`.env`, YAML, JSON) is still a Tier C catalog reference under
    its base model's row, with that row's date.
  - `audit` describes a fine-tune that joins its base model's row (no `ft-` row covers it) with the
    generic wording for a held call. It is still held and never swapped.
- **The parameter checks cannot reach a GPT-6 replacement,** because no parameter rule names that
  family. That is why `gpt-5.3-codex` is review only for every call.
- **A Live API entry can become automatic later.**
  - `gemini-2.0-flash-live-001`, `gemini-live-2.5-flash-preview` and
    `gemini-3.1-flash-live-preview` are held only because models.dev did not list
    `gemini-3.8-live` when they were stamped.
  - Once it does, a maintainer re-stamps them with `mendr verify-registry --write`.
  - They become automatic fixes when that change merges and is published. Nothing re-stamps them
    by itself.
- **Some automatic swaps go to a model other than the one the provider names now.** Anthropic's
  deprecations page names `claude-sonnet-5-5` as the replacement for `claude-3-sonnet-20240229`,
  `claude-3-5-sonnet-20240620`, `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219` and
  `claude-sonnet-4-20250514`. mendr swaps those ids, and their aliases, to `claude-sonnet-4-6` as
  Tier A fixes. Anthropic lists Sonnet 4.6 as active, retiring no sooner than 2027-02-17.
  `chatgpt-4o-latest` goes to `gpt-5.6-sol`, where OpenAI's page names `gpt-5.1-chat-latest`.
  `mendr check-dates` prints both as warnings. The registry is unchanged in this release, so these
  swaps are too.
- **Not yet in the registry, so calls to these get no finding:**
  - `deep-research-pro-preview-12-2025`, which shuts down on 2026-10-23 and is passed as an `agent`
    value the scanner does not read as a model call.
  - 33 ids waiting in the candidate queue (`registries/candidates.json`), all past the shutdown
    dates their rows give. Examples: `gpt-5.1-codex`, `gpt-5.2-codex`, `codex-mini-latest`,
    `o3-deep-research`, `imagen-4.0-generate-001`, and the aliases `gpt-4o-mini-realtime-preview`
    and `gpt-4o-mini-audio-preview`.
- **`fix-llm`'s Tier A count can be lower than the edits `--write` applies,** because it locates
  parameter sites before the swap.
- **`migrate --skip-verify` can run out of memory at Node's default heap on very large
  repositories.** Not re-tested for this release. `migrate` now also loads every source file outside
  the `tsconfig` that names a registry id (section 2), so it can use more memory than before on a
  repository with many such files.
- **A registry with two records for one model id can be handled two ways.**
  - None ships, but one is possible through `MENDR_REGISTRY_FILE`.
  - Then `audit` can hold the id under one record while `migrate` swaps it under the other.
  - `fix-llm` and `watch` read only the bundled registry.
- **Some report wording is still wrong.** The reason codes and tiers are right. `migrate`'s *Held
  for review* list and the pull request's *Left alone* list print the scanner's own sentences, so
  these appear there too.
  - `audit`'s human report calls a held proxy call "a code default or call not traced to a provider
    request".
  - In an example tree, a non-provider call such as an Express `res.json({ model: … })` is printed
    with the rule "the id is passed to a real provider request here".
  - The `platform_blocked` sentence says "deployment key" where the scanner also matches a
    deployment-named variable.
  - An untraced model value in a file that does make a supported SDK call still prints "no
    supported SDK call or parameter sink was found in this file". This happens in Python, and in
    TypeScript for a model read through a property path of an object in the same file.
  - The audit issue lists a held call at a verified SDK call site as "code literal (use not
    proven)".
  - Every `gpt-5.3-codex` finding prints a registry reason saying "Python has no parameter guard".
    Python has one since v0.5.10-alpha. The record is still review only, because no parameter rule
    names the GPT-6 family.
- **The App's install recovery has not been checked against live GitHub.** Its tests use a fake
  GitHub, and the post-deploy smoke check does not run it. GitHub's docs confirm that
  `GET /repos/{owner}/{repo}/installation` needs only the App's JWT, but they don't say when it
  returns 404. Step 2 of the recovery (the scoped token mint) is the guard that does not depend on
  that.
- **Install recovery brings back the installation, not the data the old database held.** Runs,
  migration reports, approvals, acknowledgements and audit-log entries stored before the move on
  2026-10-10 are gone. An approval made in the App before then has to be made again, and a
  repository's run history starts with its next scan.
- **A variable named exactly `TOKEN` is not redacted.** It never was. `mendr redact` on this build
  leaves `TOKEN=abcdef1234567890` as written and redacts `GH_TOKEN=…`.

---

## Evidence

Run on the release tree (`release/v0.5.11-alpha` at `d7067a2`, which is main at `03e8b3d` plus the
pins, the version and the stamp) on 2026-10-11 UTC, on Windows with Node 24.13.0. The v0.5.10-alpha
build was made in a separate directory from `git archive v0.5.10-alpha`. Both built with
`npm ci && npm run build`.

**Tests:** the full suite on the stamped tree passes 2126 tests in 120 files (run one file at a time, as CI runs it); the App suite passes 239 tests in 18 files, and its typecheck is clean. **Dates and rules against the live pages** (re-run on 2026-10-11): `mendr check-dates` reports 173 confirmed, 21 inferred, 0 failing and 25 not judged; `mendr check-rules` confirms 26 of 26 quoted sentences. **Review:** one agent drafted these notes from the code and probes, and two independent checks compared every claim with the release build and v0.5.10-alpha; all 9 of their corrections are applied.

- **Version pins:** `node scripts/check-pins.mjs` reports OK, with the release pins at
  `v0.5.11-alpha` and the SHA pins still at `072ee83` (v0.5.10-alpha's commit; the RC roll moves
  them after the tag). Its delivery-staleness rule did not run, because the tag does not exist yet.
- **Registry:** `git diff v0.5.10-alpha d7067a2 -- registries/` is empty. The committed
  `registries/llm-deprecations.json` hashes to `sha256:e0464cc70ab44d9d…` at both refs, with 223
  entries (219 model-id records). `scripts/validate-registry.mjs` reports 0 violations across 219
  model-id records. The candidate queue holds 33 ids. The probes printed the bundled hash as
  `sha256:c1f09e29bef50206`, because this Windows checkout has CRLF line endings; the hash is of the
  file's bytes.
- **Bundled stamp:** `2026-10-11T07:10:25Z`, `sha256:e0464cc70ab44d9d`, 223 entries
  (`src/registry/bundledStamp.ts`).
- **Registry refresh on both builds** (one read of the public snapshot, nothing sent): v0.5.11-alpha
  refused the snapshot published at 03:13:46Z as a rollback, used the bundled registry, and graded
  it fresh; `audit` on a repository with nothing retiring still concluded
  `NO EXPOSURE IN COMPLETED SURFACES`. v0.5.10-alpha accepted the same snapshot.
- **`migrate` probes:** ten scratch repositories outside the repository (held only; held with an
  unverified replacement; held plus a swap; nothing retiring; config only; a held call, a swap and a
  parameter edit outside the `tsconfig`; three held Python files; and a Python swap under an altered
  registry), each run with `migrate --skip-verify` and `--skip-verify --json` on both builds, plus
  `--only` and `--pr-body` on the mixed one. Every before/after row in sections 1 and 2 comes from
  these runs.
- **`audit`, `fix-llm` and `watch`:** `fix-llm --skip-gates --json`, `audit --json` and
  `watch --json` on nine of those repositories, on both builds, compared field by field after
  dropping time, version and path fields: no difference.
- **The Action:** `run-mendr.sh` from both tags, with `npx`, `npm`, `gh`, `git` and a `jq` stand-in
  stubbed as in `src/migrate/actionOutcome.test.ts`, on the artifacts and reports each build's CLI
  produced (with `--skip-verify`, which does not change the verdict of a run that migrates nothing),
  plus the two mixed-release pairings. Every row in section 3's second table and the two
  mixed-release results in Upgrading come from these runs. `src/migrate/actionOutcome.test.ts` ran
  all 24 of its tests on this machine with Git Bash, and passed.
- **Checked while reviewing these notes, on both builds where a comparison is stated:** a
  repository with no `tsconfig.json` and the Opus 4.1 const call in `dist/ask.js` (`migrate` held
  it on this build and listed nothing on v0.5.10-alpha; `audit` and `fix-llm` reported nothing on
  this build); `--pr-body` on the parameter-edit-only repositories, which wrote no file; a stubbed
  `run-mendr.sh` run on the `o1-mini` parameter-edit artifact, which opened a pull request with no
  evidence block; `audit` and `migrate` with `MENDR_REGISTRY_FILE` pointed at a copy of the
  03:13:46Z snapshot with its manifest and signature (exit 1 on this build, exit 0 on
  v0.5.10-alpha); and a full `migrate` (no `--skip-verify`) on the `.js`-outside-`allowJs`
  repository, with a check that TypeScript leaves the file out of the program.
- **Known issues re-run on this build:** the config-only repository, the Python syntax-check case,
  the `satisfies` case, the `**kwargs` case, the spread case, the cross-file const, the `o1-mini`
  parameter edit and `TOKEN`. The other carried-over items rest on code this release did not change:
  between the two tags, `src/usage`, `src/python`, `src/fix`, `src/redact`, `registries/`,
  `app/src/github` and `app/src/store` differ only in `src/usage/scanRepo.ts`, where fix-llm's file
  filter moved into a function `migrate` also calls.
- **App deploy:** the `app-deploy` run for #63's merge (38120418200) passed its gate, deploy and
  smoke jobs; smoke finished at 2026-10-11T07:10:26Z.
- **Tests:** the full suite on the release tree passes 2126 tests in 120 files, run one file at a
  time as CI runs it. The App suite passes 239 tests in 18 files, and its typecheck is clean.
