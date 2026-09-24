# Milestone: external validation

Response to the builder brief, written 2026-09-24 against `2641f63`. Every claim below carries a
`file:line` and was read from the code, not recalled. Where a brief item is already done, it says
so; where the brief's premise turned out to be wrong, it says that too.

**No new features are proposed.** Every task here removes a way Mendr can mislead the one external
engineer the milestone depends on.

---

## 0. Reconciliation — the brief arrived mid-flight

| Brief item | Status | Evidence |
|---|---|---|
| 1. Merge and verify PR #11 | **Merged, criteria NOT met** | `e0eafaa`. It scoped the type-check claim but did not introduce the five-state vocabulary |
| 2. Migration redaction gap | Open — **worse than described** | `run-mendr.sh:210` publishes it to a *public PR body*, not only logs |
| 3. Unsafe redaction expression | **Premise disproven** | Measured linear, 11 ms on 2,000,000 chars. See §1, task R3 |
| 4. Python-only Actions reporting | Open — **structurally blocked** | `cli.ts:3846` runs after the `return` at `cli.ts:3817` |
| 5. BOM handling | Done, fixtures incomplete | `a8b00bc`; missing CRLF and Windows-editor cases |
| 6. Registry guarantees | Intact; 2 trust anchors untested | `trustedKeys.ts` and `bundledStamp.ts` imported by no test |
| 7. Cut v0.5.5-alpha | **Already cut, before items 2–4** | `3a930de`. The gated release becomes **v0.5.6-alpha** |

**v0.5.5-alpha shipped under the previous plan, not this brief.** It was a fix release (gate-scope
honesty, BOM, pluralisation). It does not satisfy the Phase 1 exit criteria and is not claimed to.

---

## 1. Task list — ordered by severity, then dependency

### P0 — a customer's secret can be published today

**S1. The eval-command leak chain.** Verified end to end by hand:

- `src/cli.ts:1218` — `console.error("Running your evaluation against the patched code: " + evalCommand)`
- `mendr-action/scripts/run-mendr.sh:115` — `migrate … >"$REPORT" 2>&1` captures that stderr
- `mendr-action/scripts/run-mendr.sh:120` — `cat "$REPORT"` → the Actions log
- `mendr-action/scripts/run-mendr.sh:210` — `cat "$REPORT"` → **the public pull-request body**

The action's `eval-command` input is published verbatim. A customer who writes
`eval-command: "OPENAI_API_KEY=sk-… npm run evals"` has published their key in a public PR. This is
precisely the `INPUT_*` case the brief names, and it is the single most damaging defect in the
codebase: it converts Mendr from a tool that reads secrets into one that *publishes* them.

**S2. The migrate report publishes verbatim customer source.** `src/migrate/report.ts:58-63` embeds
the full unified diff — the changed line plus three context lines above and below each hit — into
the same `$REPORT` that `run-mendr.sh` publishes three ways. Because line 115 captures with `2>&1`,
every thrown `Error` and stack trace joins it. A private repository's source and internal paths
reach a public PR body.

**S3. No central sanitizer exists.** There are three textually-duplicated copies of the same seven
regexes — `src/audit/issueReport.ts:95`, `src/gates/sandbox.ts:73`, `app/src/redact.ts:5` — and only
two are held in sync by a test (`app/src/redact.test.ts:19` compares function bodies;
`sandbox.ts` is not in that test). The migrate path passes through none of them.

**S4. Pattern coverage is roughly 5 of the 11 categories the brief names.** Present: GitHub tokens,
well-formed JWTs, AWS key ids, `sk-`/`pk-`/`rk-` keys, `NAME=value` where NAME ends in a secret word.
**Absent**: `Authorization:`/`Bearer` headers, credentials embedded in URLs, `AIza…` (Google),
`hf_…`, `gsk_…`, Azure hex keys, AWS secret keys, and any by-value redaction of `INPUT_*`.

### P1 — a check that did not run is reported as passed

**V1. Six vocabularies, and none of them is the brief's.** `not_run` appears **nowhere** in the
codebase; `skipped` is renderable at exactly one site (`src/cli.ts:1157`). The producers each
declare their own union: `GateOutcome` (5 words, `src/gates/policy.ts:31`), `GateStatus` (4,
`src/migrate/migrate.ts:75`), `TestStatus` (3, `src/gates/runTests.ts:24`), `EvalStatus` (4,
`runEval.ts:31`), `BuildStatus` (4, `runBuild.ts:13`), and the Python syntax gate is a **boolean**
(`src/python/fixPy.ts:76`).

**V2. `fix-llm` and `migrate` disagree about the same repository.** "No test script" is
`not-configured` in one (`src/cli.ts:302`) and `inconclusive` in the other
(`src/migrate/migrate.ts:457`); `fix-llm` prints `Tier A … (VERIFIED)` where `migrate` computes
`inconclusive`. The classifier contract between them is a **string literal comparison** —
`result.output === 'no test script'` — with no test pinning both sides.

**V3. A test script that runs zero tests makes a migration PR-ready.** `runTests.ts:120` sets status
from the exit code alone; `parseTestCounts` (line 51) is attached but never consulted. So
`"test": "exit 0"` yields `pass`, which via `src/migrate/migrate.ts:356` makes `anyRealPass` true,
the verdict `verified`, `prReady: true`, and a PR body that says **"your tests: passed"**.

**V4. The blind type-check.** `src/gates/typecheck.ts:131` decides `passed` without consulting
`unresolvedModules`. The scope note added in PR #11 is a *detail string*, and details get dropped:
it is suppressed on the PR-body gate row and discarded entirely by the App. The file's own comment
(lines 48-54) already says `fix-llm <url>` is "systematically blinder" and "it said passed either
way". **Your rule overrules my earlier judgement call**: this becomes `inconclusive`.

**V5. "Skipped" is encoded as absence.** `--skip-gates` / `--skip-verify` produce missing rows or
`not-configured` — "there was nothing to run" — never "we chose not to run this".

### P2 — the milestone is unreachable for a Python repository

**P1a. The Python readers never execute in CI.** `src/cli.ts:3846` and `:3852` sit *after* the
`return;` at `src/cli.ts:3817` that ends the `--json` branch the Action runs. The job summary is one
call — `sdkJobSummaryMarkdown(readLockedSdks(...))` at `cli.ts:3812` — typed to the npm report only
(`src/report/auditReport.ts:326`).

**P1b. Two tests actively assert the gap.** `src/usage/lockedSdks.cli.test.ts:205-211` and `:260-266`
assert the job summary must **not** mention Python. Closing this means changing those assertions.

**P1c. The summary carries no finding at all, for either language** — no located model, no coverage
row, no conclusion. A Python repo's entire Mendr summary today is *"Provider SDKs: not read — no
package-lock.json at the repository root."*

**P1d. Migrate cannot reach `verified` on a Python-only repo**, so the brief's PR milestone is
**unreachable there** regardless of the summary work. This is the finding that most threatens the
milestone, because Python is where the ICP lives.

### P3 — the trust model's anchors are untested

**T1.** `src/registry/trustedKeys.ts` and the generated `src/registry/bundledStamp.ts` are imported
by **no test file**. Emptying the keyring (disabling signature verification) or backdating the
rollback floor passes CI green. Seven of the eight registry invariants have a test that would fail
if deleted; these two constants are the exception, and they are the anchors the other seven hang on.

**T2.** The SDK release record and model catalog are signed on publish and **verified by nobody on
read**. The SDK record at least fails closed on schema and age; the catalog does neither.

### P4 — the four surfaces cannot agree by construction

**F1.** `run-mendr.sh:115` and `:117` run `mendr migrate` **twice**. The log/summary come from one
execution and the PR-body evidence from another, so they can disagree without any bug. The brief's
requirement that "the CLI, logs, job summary and PR body show the same conclusion" is not a test to
write — it is a **refactor**: one run, one artifact, all surfaces rendered from it.

**F2. No harness exists.** 81 hand-rolled `mkdtempSync` repo builders across 43 test files, no shared
factory, `fixtures/` excluded by `vitest.config.ts:8` and referenced by nothing. No test executes
`run-mendr.sh` (CI only shellchecks it, `.github/workflows/ci.yml:24`) and no test runs the published
`dist/cli.js`.

### Not doing — and why

**R3. Do not rewrite the JWT regex.** The brief calls it "excessive backtracking". I measured it
against six adversarial shapes up to 2,000,000 characters: **strictly linear, 11 ms worst case**.
The `\.` separators sit *outside* every character class, which pins each quantifier's extent to the
next dot, so there is no ambiguous overlap to explode. I had repeated this "quadratic" claim myself —
in the status report and the v0.5.4 release notes — and it was wrong both times. The pattern *gaps*
in S4 are real and are the work worth doing; the ReDoS is not.

---

## 2. Files and components affected

| Task | Files |
|---|---|
| S1–S4 | **new** `src/redact/sanitize.ts` (one owner); delete duplicates in `src/audit/issueReport.ts:95`, `src/gates/sandbox.ts:73`; re-point `app/src/redact.ts`; `src/cli.ts:1218`; `src/migrate/report.ts:58-63`; `mendr-action/scripts/run-mendr.sh:115,120,210`; `mendr-action/scripts/build-report.mjs` |
| V1–V5 | **new** `src/gates/status.ts` (the five states, one union); `src/gates/policy.ts:31`, `runTests.ts:24,120`, `runEval.ts:31`, `runBuild.ts:13`, `src/python/fixPy.ts:76`; `src/cli.ts:300-310,1086,1157`; `src/migrate/migrate.ts:75,356,457`; `src/report/tiers.ts` (GateRow), `src/report/prBody.ts`; `app/src/` render paths |
| P1a–P1d | `src/cli.ts:3801-3852` (hoist the readers above the `return`), `src/report/auditReport.ts:232,326` (widen `sdkJobSummaryMarkdown` to a surface-agnostic renderer), `src/usage/lockedSdks.cli.test.ts:205,260` |
| T1–T2 | **new** `src/registry/trustAnchors.test.ts`; `src/registry/trustedKeys.ts`, `bundledStamp.ts`, `sdkReleases.ts`, `catalog.ts`; `TRUST.md` |
| F1–F2 | `mendr-action/scripts/run-mendr.sh` (single run), **new** `src/test/fixtures.ts`, **new** `src/e2e/surfaces.test.ts` |
| BOM | `src/config/scanConfig.ts`, `src/usage/lockedSdks.ts` (both already fixed); fixtures only |

---

## 3. Acceptance tests

**S (sanitization).** One table-driven suite. Inject a marker secret —
`sk-MENDRCANARY000000000000000000000000000000` — through each channel: an env var, command stdout,
command stderr, a config file, a URL (`https://user:pw@host`), a failing test's output, and the
action's `eval-command` input. Run the **complete** audit and migrate flows. The test fails if the
literal canary appears in: terminal output, the Actions log, `$GITHUB_STEP_SUMMARY`, the report file,
the PR title or body, any thrown error message, or stored evidence. Separately assert the sanitizer
is **not** applied to the byte-exact `git apply` targets (`cli.ts:350`, `:1316`, `:1379`) or the
issue state block (`issueReport.ts:543-552`) — a redacted diff would not apply.

**V (status).** Seven fixtures, as the brief specifies, each asserted across **all four surfaces**:
working type-check → `passed`; no type-check command → `not_run`; missing dependency → `inconclusive`
(never `passed`); command crashes → `failed`; command times out → `inconclusive`; gate disabled →
`skipped`; no supported files → `inconclusive`. Plus the two regressions this survey found:
`"test": "exit 0"` must **not** reach `verified`, and `fix-llm` and `migrate` must print the same
word for the same repository. A property test asserts no code path maps `not_run` or `skipped` onto
`passed`.

**P (Python).** A Python-only fixture with **no `package.json`**, run through the real Action —
not a unit test of the renderer. Assert the summary contains every field in the brief's list, and
that a Python finding reaches `verified` or reports honestly why it cannot.

**T (trust anchors).** `trustAnchors.test.ts` asserts: the keyring is non-empty and contains the
expected key fingerprint; the rollback floor parses and is not in the future; a snapshot signed by
an unknown key is refused; a snapshot older than the floor is refused. Each must fail if the
corresponding constant is emptied or backdated.

**BOM.** JSON and JSONC with and without a BOM; CRLF line endings; a file as Notepad and VS Code
write it; a genuinely malformed file *carrying* a BOM, which must remain `inconclusive` — never
`clean`.

---

## 4. Release checklist — v0.5.6-alpha

- [ ] S1–S4 merged; the canary suite passes across all seven injection channels
- [ ] V1–V5 merged; the five states are the only words any surface renders
- [ ] `fix-llm` and `migrate` agree on all seven fixtures
- [ ] Python-only fixture produces a complete Actions summary in a real workflow run
- [ ] T1 trust-anchor tests present and failing-when-broken (verify by temporarily emptying the keyring)
- [ ] BOM fixture set complete
- [ ] All existing tests pass (baseline 1,431 root + 157 App)
- [ ] `validate-registry`: 0 violations
- [ ] `check-pins`: OK
- [ ] TRUST.md updated per §5 — including the SDK-record disclosure
- [ ] `launch/DEMO-CLIP.md` sample output re-verified against the release
- [ ] Release notes, upgrade instructions, known limitations, security statement, supported-input
      matrix (§9), test evidence, release commit id

**Do not tag until the canary suite is green.** S1 is a live secret-exposure path; shipping anything
else first would be building on it.

---

## 5. Trust and security documentation

`TRUST.md` changes:

1. **Add a verification-status section** defining the five states verbatim, with the rule *"a check
   is never reported as passed unless it actually ran"* stated as a guarantee, not a preference.
2. **Correct the migrate row.** It currently describes what is sent to the App. It must also state
   that the full report — including the diff — is published to the PR body, and what is redacted.
3. **State the SDK-record position explicitly.** Per brief item 6, either sign it under the same
   trust model or keep disclosing it. Recommendation: **keep disclosing**, and make the disclosure
   louder — it is a *decision*, not an omission. The same sentence must say the model catalog has
   neither signature verification *nor* age or schema fail-closed.
4. **Add the trust-anchor note**: the keyring and rollback floor are now covered by tests, and what
   those tests guarantee.

---

## 6. Verified GitHub Actions demonstration

A real workflow run — not `act`, not a unit test — against the external-test repository (§11 of the
brief), producing: the audit summary, a finding, an approval, a migration, the four surfaces in
agreement, and an evidence-rich PR. Labelled a **demonstration repository, not an external
customer**, in the README's first line.

It must contain, per the brief: a retiring model, a coupled parameter change, TS *and* Python usage,
YAML/JSON config, a real build and test suite, one intentionally unsupported reference, one
suppressed finding, and a fake secret that proves redaction. That last one is the acceptance test
for S1–S4 running in public.

**Blocked on P1d**: until migrate can reach a verdict on Python, the demonstration can only show the
TS half end to end.

---

## 7. External onboarding guide

`onboarding/FIRST-REPO-NOTE.md` exists and is good; it needs the brief's eight-step flow made
explicit, and one addition — **what Mendr will never do**: merge, deploy, modify production, change
repository protections, or read secrets it does not need. Default stays read-only (`audit` is
already read-only and `migrate` already requires approval).

---

## 8. Reviewer-verdict template

`onboarding/REVIEWER-VERDICT.md` — one file per review, committed by Ajith, never requiring the
reviewer to expose source:

```yaml
repository:        # owner/name, or "private — withheld"
mendr_version:     # e.g. v0.5.6-alpha
registry_version:  # sha256:…
finding_fingerprint:
reviewer_role:     # maintainer | staff engineer | …
finding_verdict:   # finding_correct | finding_incorrect | insufficient_evidence | not_applicable
migration_verdict: # migration_correct | migration_incorrect | insufficient_evidence | not_applicable
reason:            # verbatim, in the reviewer's words
false_positive_reason:
date:
mendr_installed:   # yes | no
pr_opened:         # yes | no
pr_merged:         # yes | no
```

Plus the seven questions from Gate 1a, answered in the reviewer's own words. **A star, a view or a
reaction does not populate this file.**

---

## 9. Supported-input matrix

| Input | Read | Analysed | Notes |
|---|---|---|---|
| TypeScript / TSX / JS | yes | yes | literal + param locators |
| Python | yes | yes | no type-check gate; syntax re-parse only |
| Go, Java, Kotlin, Rust, C/C++, Ruby, PHP, C# | counted | **no** | reported as unread |
| YAML, JSON, JSONC | yes | yes | BOM tolerated since v0.5.5-alpha |
| TOML, `.env` | located | **no** | not parsed |
| `package-lock.json` (root) | yes | information only | never part of a conclusion |
| `requirements*.txt`, `uv.lock` (root) | yes | information only | terminal report only — see P1a |
| yarn / pnpm / bun / poetry / Pipfile / pdm | named | **no** | disclosed as not read |
| Non-root lockfiles, workspace members | named | **no** | disclosed |
| Shell scripts | **no** | no | a model id in a `.sh` is invisible |
| Runtime evidence (OTel, usage export, provider API, gateway logs) | opt-in | yes | never connected by anyone to date |

---

## 10. Remaining risks after v0.5.6-alpha

1. **Python cannot complete the loop** until P1d is designed — the ICP's language reaches a finding
   but not a verified migration.
2. **`approve → PR` has never run end to end for an external customer.** The first real approval is
   the first real test of that path.
3. **The model catalog stays unsigned and unguarded** (no signature check, no age or schema
   fail-closed) even after the SDK record is disclosed.
4. **Redaction is a denylist.** A credential format nobody has seen passes through. The canary suite
   proves the known categories, not the unknown ones.
5. **Coverage is honest but narrow** — shell scripts, TOML and `.env` remain unparsed, so "not
   exposed within measured coverage" is doing real work in that sentence.
6. **One reviewer is a sample of one.** Gate 1a produces a verdict, not a validated product.
