# v0.5.9-alpha

**The release that stops `fix-llm` calling a repository clean when it is not.** In v0.5.8-alpha,
a call the scanner holds for review could vanish from `fix-llm`'s report entirely, leaving
"Nothing to fix" and a `--fail-on tierB` gate that passed. This tag fixes that. It also adds
Claude Sonnet 4.5's retirement and follows two dates Google moved.

The deprecation registry moves from `sha256:079c0af585316432` (167 entries) to
`sha256:4145ea23431d5bc5` (168 entries: 164 model ids, 4 parameter rules).

Scans with registry refresh switched on already have the registry changes: `registry-publish` signed
and published them when they merged. Everything else in this release needed a tag.

---

## What a customer gets

### 1. `fix-llm` lists every call held for review

The scanner holds some live calls back from an automatic patch. Examples are a parameter whose rule
changes on the replacement, a parameter no rule covers, a real call inside an `examples/` tree, a
gateway-prefixed id, and a wrapper class. `audit` always listed those as Tier B. In TypeScript,
`fix-llm` dropped them:

| call | `audit` | `fix-llm` in v0.5.8-alpha | `fix-llm` now |
|---|---|---|---|
| `gpt-3.5-turbo` + `max_tokens: 20` | review | "Nothing to fix" | review, `param_behaviour_change` |
| `claude-opus-4-1-20250805` + `max_tokens: 1024` | review | "Nothing to fix" | review, `coupled_param_unverified` |
| a real SDK call under `examples/` | review | "Nothing to fix" | review |

- **The first row was a v0.5.8-alpha regression.** Before v0.5.8-alpha that call was a Tier A
  patch. The parameter guard v0.5.8-alpha added moved it to review, which `fix-llm` did not
  report.
- **The second row covers every Anthropic call** to a model Mendr would otherwise migrate,
  because every Messages call passes `max_tokens`.
- **The fix.** `fix-llm` now gives each such call the same reason code `audit` does, prints the
  scanner's own sentence for why it is held, and never patches it. Python and `watch` were never
  affected.

**If you gate CI on `fix-llm --fail-on tierB`, it can turn red after upgrading.** A repository that
passed on v0.5.8-alpha can fail now. That is the gate working: those calls always needed a person.

### 2. Claude Sonnet 4.5's retirement, held for review

`claude-sonnet-4-5-20250929` is in the registry. Anthropic retires it on **2026-11-30** and names
`claude-sonnet-5-5` as the replacement. Every call site is **review only**, never patched
automatically:

- Anthropic's Sonnet 5.5 migration guide names settings Sonnet 4.5 accepts that return a 400 error
  on Sonnet 5.5: thinking budgets, sampling parameters, assistant prefill, forced tool choice, and
  thinking type "disabled".
- It also says thinking runs by default, so code that reads `content[0].text` breaks.
- Sonnet 4.5 still works until then, so a bad automatic swap would break code that works today.

`mendr evidence claude-sonnet-4-5-20250929` prints the reason in full. The bare alias
`claude-sonnet-4-5` has no entry, because Anthropic's deprecations page does not name it.

### 3. Two Google dates follow Google

Google moved both shutdowns later. v0.5.8-alpha reported these live models as already past
retirement:

| model | v0.5.8-alpha said | now |
|---|---|---|
| `gemini-omni-flash-preview` | "7d OVERDUE" (2026-09-30) | 15 days left (**2026-10-22**) |
| `gemini-2.5-flash-image` | "5d OVERDUE" (2026-10-02) | 159 days left (**2027-03-15**) |

For `gemini-2.5-flash-image`, the replacement is now `gemini-3.1-flash-lite-image`, the one Google's
table names. Both entries stay review only.

### 4. The rollback floor moves

The bundled stamp was re-run right before the tag. A downloaded snapshot published before it is
refused. The bundled registry grades fresh for 14 days from the stamp.

---

## Upgrading

- **CLI:** `npx github:ajitheee/mendr#v0.5.9-alpha audit .`
- **Audit workflow:** set the repository variable `MENDR_SPEC=v0.5.9-alpha`. No workflow edit is
  needed.
- **Migrate workflow: a workflow edit is required.** Change `@v0.5.8-alpha` to `@v0.5.9-alpha` in
  your committed `mendr-migrate.yml`, or re-run the one-click setup. `reusable-migrate.yml` cannot
  honour `MENDR_SPEC`, because GitHub forbids an expression in `uses:`.

---

## Known and unchanged

- **Some held calls get the wrong headline.** A call held for any reason other than a parameter rule
  carries the code `platform_blocked`, whose sentence says it "sits under a deployment key". The
  line beneath it now gives the real reason, but the headline is still wrong.
- **`migrate` does not say why it skipped a held call.** It does nothing for a held call, even
  after that model is approved, and does not report why.
- **Anthropic's `max_tokens` is treated as model-dependent,** so a call to a model Mendr would
  migrate goes to review rather than being patched.

---

## Evidence

- Root suite and CI on the release PR, which includes the App's tests.
- `npm run validate:registry`: 0 violations across 164 model id records.
- `check-dates` against the live pages: confirmed 111, failing 0.
- `node scripts/check-pins.mjs`: OK. Every release pin is `v0.5.9-alpha`.
- Probes on the release build, offline:
  - the three calls above: `fix-llm` lists 0 Tier A and 3 Tier B, and `--fail-on tierB` exits 1;
  - six Sonnet 4.5 calls in TypeScript and Python: all Tier B;
  - the two Google ids: "15d left" and "159d left".
