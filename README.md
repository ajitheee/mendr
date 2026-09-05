# mendr

**Find every retiring AI model your repo still calls, before the provider shuts it off.**

One command scans TypeScript, TSX, JavaScript, Python and config files, joins a dated retirement registry for OpenAI, Anthropic and Google, and tells you what breaks, where, and by when. No API key. Nothing is changed.

```sh
npx github:ajitheee/mendr#v0.2.4-alpha audit .
```

(`npx mendr audit .` once the package lands on the npm registry.)

## the problem

A provider retires a model id, or flips a param like `max_tokens` to `max_completion_tokens` on the newer models. Your code keeps compiling until it doesn't, and you usually find out when it 404s or 400s in prod. Dependabot and Renovate never fire on it: `gpt-4` is a string in your application code, not a package version.

## what you get

```
Audit coverage

✓ Source code:       342 files scanned (301 TS/TSX, 41 Python)
○ Configuration:     not applicable — no supported configuration files found
✓ Registry:          anthropic, google, openai
○ Runtime usage:     not measured — no runtime source connected (optional)

Conclusion: EXPOSURE DETECTED

Model: gpt-4
Location: src/ai/client.ts:42 — verified direct provider call site
Retirement: 2026-10-23
Migration evidence: gpt-5.6-sol [registry: verified] (evidence only — not applied here)
Decision: PATCH ELIGIBLE
Status: No change applied
```

Every output carries the coverage matrix, so a skipped surface can never read as "clean". There are exactly four conclusions and none of them is a general all-clear — see [AI dependency audit](#ai-dependency-audit-preview).

## keep it watched

```sh
npx github:ajitheee/mendr#v0.2.4-alpha audit . --install
```

scaffolds a GitHub workflow that keeps **one issue per repository** current: new, continuing and resolved findings, the exact commit scanned, and the coverage matrix. It asks for `contents: read` and `issues: write`, never touches your default branch, and never merges anything.

## want the fix, not just the finding?

`fix-llm` goes one step further: it writes the exact diff for a retired id at a verified call site and proves it against your type-check and tests before anything is applied. Print-only by default — read the patch, and if it's right, apply it:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha fix-llm .
```

You can also point it straight at a GitHub link. mendr clones a throwaway copy and scans that, so the real repo is never touched:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha fix-llm https://github.com/someone/their-repo
```

It never writes to your working tree on its own. The default is print-only. When you're ready to apply:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha fix-llm . --write
```

`--write` only applies a fix that passed the gates (type-check, plus your tests when they can run). Anything it can't verify is shown for review and left alone. You can also pipe the diff straight into git, since it's a standard patch:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha fix-llm . -o mendr.patch && git apply mendr.patch
```

### keep watching a repo

`fix-llm` is one-shot. `mendr watch` is the resident version — it scans in your own GitHub Actions and keeps one issue listing every deprecated model id you use, grouped by risk and deadline, so you find out before a model retires. Run it once to see your exposure, or `--install` to make it resident:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha watch .
```

See [standing watch](#standing-watch) for the details and [WATCH-SCHEMA.md](WATCH-SCHEMA.md) for the JSON.

## what it actually does to your files

Nothing, unless you pass `--write`. By default mendr loads your code in memory, works out the fix, and prints a diff. It does not commit, it does not open a PR, and it does not edit your files behind your back. That's the trust line and it stays that way.

## what leaves your machine

Nothing, by default. The audit reads the repository, the bundled registry and your local `git rev-parse`, and prints a report. That is enforced in code, not just written here: the test suite runs the audit under a preload that makes every network primitive throw, and the audit must still pass. You can enforce it yourself:

```bash
npx github:ajitheee/mendr#v0.2.4-alpha audit . --offline
```

The only optional network use is the provider usage read you ask for by name with your own read-only key, and a shallow `git clone` when you pass a GitHub URL instead of a path. The [Mendr GitHub App](app/README.md) is the one hosted piece: your workflow posts the audit JSON to it, proven by the run's OIDC token, and it writes a check run back; it has no `contents` permission and cannot read code. [TRUST.md](TRUST.md) has the per-command table, the data-flow diagram, the threat model, the permissions each surface needs, and the known gaps. [SECURITY.md](SECURITY.md) is how to report a problem with any of it.

## commands

- `mendr audit [path]` — **(preview)** the unified audit: scan TS/TSX/JS/Python source + config, join the deprecation registry, and report every retiring AI dependency with its location, deadline, and migration evidence. **Needs only the repository.** See below.
- `mendr fix-llm <path>` — scan a repo for retired model ids and coupled params, print the gated diff. This is the one you'll use. Add `--eval-command "<cmd>"` to have it run your own evaluation against the patched code (see below).
- `mendr migrate [path]` — **(preview)** verify a migration in an isolated sandbox and emit a portable result (`mendr-migration/v1`): the diff, every model swap, each gate's outcome (type-check, your build, your tests, an optional eval), an overall verdict and whether it is PR-ready. It never writes your working tree. `--json` for the artifact, `--patch <file>` for the git-applyable patch, `--eval-command "<cmd>"` for a behavioral gate.
- `mendr watch [path]` — list the deprecated model ids your code touches, sorted by the nearest provider retirement date. `--install` scaffolds a GitHub Action that keeps one self-updating issue current (see [standing watch](#standing-watch)).
- `mendr check --repo <path> --from <specA> --to <specB>` — list the breaking changes between two Stripe specs that your repo actually uses.
- `mendr scan <path>` — list the Stripe API surface a repo touches.
- `mendr fix <path> --from <specA> --to <specB>` — Stripe field-rename codemod.
- `mendr verify-registry` — check every model-id replacement in the registry against the live public model catalogs and print an audit.
- `mendr validate-registry` — check the registry for internal contradictions (offline); exits non-zero on any violation.
- `mendr usage-audit [provider]` — **(preview)** read per-model usage from a provider's read-only usage API. Superseded by `audit`.
- `mendr config-scan [path]` — **(preview)** locate deprecated model ids in config/IaC files. Superseded by `audit`.

Run any command with `--help` for its flags.

## AI dependency audit (preview)

**Connect your repository and mendr locates retiring AI dependencies. If you
choose to connect runtime evidence, mendr can also verify which ones are live.**

No provider key is required to get value. The default audit is repository-only:

```sh
mendr audit .
```

It scans TypeScript, TSX, JavaScript, Python, and supported config files, finds provider call
sites and model identifiers, joins them to the deprecation registry, and reports:

```
Deprecated model dependency located

Model: gpt-4
Location: src/ai/client.ts:42 — code call site (model argument)
Retirement: deprecated — 54d left (2026-10-23)
Migration evidence: gpt-5.6-sol [registry: verified] (evidence only — not applied here)
Production usage: not measured
Reader tie-back: not proven
Decision: REVIEW REQUIRED
Status: No change applied
```

That is already the risk, the location, the deadline, and the migration evidence
— and it is honest that runtime usage is unknown. **Code tells you where a model
is declared, not whether production calls it.** Runtime evidence closes that gap.

### Optional: prove which ones are live

Four ways in, all optional, all refusable. Pick whichever you're comfortable with:

```sh
# 1. OpenTelemetry — export your gen_ai/llm span or metric attributes. No key.
mendr audit . --runtime otel-export.json --runtime-source otel

# 2. Your own sanitized usage export (CSV or JSON). No credentials shared.
mendr audit . --runtime usage-export.csv

# 3. Your own read-only provider key, kept in YOUR CI or secret manager.
MENDR_PROVIDER_KEY=sk-admin-... mendr audit . openai --from 2026-07-01 --to 2026-07-31

# 4. Model gateway / Sentry / Datadog / structured app logs.
mendr audit . --runtime gateway.csv --runtime-source gateway_logs
```

mendr reads only **provider, model, service, environment, timestamp, request
outcome, and volume**. Never prompts, never responses. Cost is accepted if your
source carries it, but it is not required — you already have a billing dashboard,
and mendr is not trying to be another one.

Connect telemetry later and the same finding gains a line:

```
Production usage: OBSERVED — 18,342 requests, last seen 2026-08-29, service customer-support, env production
```

### What the conclusion can say

Exactly four verdicts — **never a general "clean"**:

| conclusion | meaning |
|---|---|
| `exposure_detected` | at least one retiring dependency was found |
| `no_exposure_in_completed_surfaces` | none found in the surfaces that finished |
| `inconclusive` | the core source scan did not complete — silence proves nothing |
| `audit_failed` | a surface was attempted and errored |

Every run prints a coverage report showing which surfaces ran, so a skipped or
failed surface is always visible.

**Limitations (this is a preview):**
- Report-only. Nothing is written, nothing is merged. `patch` means a *reviewed
  PR is possible*, not that a change was applied.
- A config match is a **candidate selector**, never proven to control runtime
  selection — reader tie-back does not exist yet, and the report says so.
- Absence from a runtime source is **not** proof a model is unused; it only
  covers what that source records.
- A deprecated id under a non-direct surface (Bedrock, Vertex, Azure, an
  OpenAI-compatible proxy) is reported as *provider-ambiguous* with **no** direct
  replacement; model-definition catalogs and test fixtures are never change targets.
- Provider usage reads cover **chat/completions only** (not embeddings, images,
  audio, batch, fine-tuning); Anthropic's usage API reports **no request counts**;
  **Google/Vertex is not supported**. All of this is disclosed in the coverage report.

Everything runs locally. Nothing is uploaded; no key is ever sent to us. Enforced by `--offline` and by the offline test on every build; see [TRUST.md](TRUST.md).

## standing watch

`fix-llm` is a one-shot: you run it, read a diff, and leave. But a model you use today retires on a date months out, and nobody re-runs a CLI on a calendar. `mendr watch` turns the scan into a resident thing that surfaces itself.

Mendr Watch continuously rescans your repository inside your own GitHub Actions environment and maintains one issue containing the current deprecation exposure. It stores no customer repository state on Mendr infrastructure, never modifies the default branch, and cannot bypass Mendr's deterministic safety gate.

Run it once to see your exposure (a local path, or a GitHub URL to scan a read-only copy):

```sh
npx github:ajitheee/mendr#v0.2.4-alpha watch .
```

```
Mendr Watch: 2 deprecated model ids, 4 unique occurrences
Highest risk first, then nearest deadline

REVIEW REQUIRED
  61d left  gpt-4 -> gpt-5.6-sol
    Tier B: 1 usage-unverified occurrence at agent_app/simulator.py:166
    Tier C: 1 data occurrence at agent_app/simulator.py:12

INFORMATIONAL
  retired 328d ago  gemini-1.5-pro -> gemini-2.5-pro
    Tier C: 2 data occurrences at agent_app/simulator.py:30,127
```

Every occurrence carries the same A/B/C tier `fix-llm` uses, so the two tools always agree. `--json` adds machine fields (occurrence vs model counts, both deadline fields, per-model verdicts) — see [WATCH-SCHEMA.md](WATCH-SCHEMA.md). It writes a small, diff-friendly `.mendr/exposure.json` you can commit — and it's **churn-free**: re-running on unchanged code produces byte-identical output, so there's no daily "one line changed" commit. The countdown is derived from the retirement date at read time, never stored.

Then make it resident:

```sh
npx github:ajitheee/mendr#v0.2.4-alpha watch --install
```

That scaffolds `.github/workflows/mendr-watch.yml` — a workflow that runs in **your own CI** (no server, nothing on our infrastructure) and maintains **one** GitHub issue: your deprecated model ids, each mapped to its retirement date, sorted by the nearest deadline. It's the [Renovate dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) mechanic — the issue is found by a hidden marker and edited in place forever, never re-posted, so it re-surfaces itself without ever spamming you. It asks for `issues: write` and `contents: read` and nothing else: it opens no pull requests, runs none of your tests, and pushes no commits. It's pinned to an immutable Mendr release (overridable via a `MENDR_SPEC` repo variable), so a future upstream change can't run in your CI without you choosing it.

Honest limits, up front: the countdown is day-granularity (GitHub cron drifts — it is never an exact-time promise), it maintains one issue and closes it when your exposure clears, and the optional README badge is a snapshot you paste, not a live endpoint (the paying case is private repos, which a live badge host can't read).

## how it decides what to change

mendr is call-site aware. It only swaps a model string when that string is actually an argument to a recognized LLM call, so it won't touch a model id sitting in a pricing table, a model-picker array, or a lookup map. For param fixes it traces the model at each call site and only removes or renames a param when that specific model requires it, so a `claude-opus` call can lose `temperature` while a sibling `haiku` call keeps it.

Replacements come from a deprecation registry that carries a per-entry verdict from a check against the live public model catalogs, so it isn't guessing from a blog post. Verification is **per entry, not registry-wide** — some entries carry a `verified` verdict, some carry `unverified`, and a few carry a recheck date with a note saying that id was not researched on that pass. The report footer prints the split rather than a blanket claim, and only a `verified` entry is ever auto-applied. If a replacement isn't verified, mendr locates the spot and refuses to auto-apply rather than risk a bad patch.

A stamp is one field, and a hand-edit can get it wrong — twelve records once shipped stamped `verified` over their own recorded reasoning saying *do not auto-apply*. The gate used to catch that by regex-matching those sentences at fix time, which made safety behaviour a function of wording: reword the caveat and the record silently becomes auto-appliable.

So the gate reads **structured fields**, and nothing else. Every record carries four:

| field | means |
| --- | --- |
| `status` | `verified` \| `quarantined` \| `unverified` \| `unverifiable` |
| `officialSourceConfirmed` | the provider's own docs confirm the deprecation |
| `replacementConfirmed` | the replacement is live and uncontradicted in the public catalogs |
| `autoApplyAllowed` | the single switch the engine reads |

A record is auto-applied only when **all four** hold: `status === 'verified'` and all three booleans true. The twelve contradicting records are now `status: "quarantined"` **in the registry file itself**, each with a `quarantineReason` saying what has to be resolved — so the data is honest to anyone who reads it, not just to anyone who runs mendr. `verification.reasons` survives as documentation and is never read by the safety path.

The marker list (`do not auto-apply`, `status unknown`, `unverified`, `itself deprecated`, `not the currently-recommended`, `stale`) still exists, in one place: `mendr validate-registry`, which **fails CI** when a caveat like that sits in `reasons` on a record that is nonetheless `autoApplyAllowed`. It also fails on a `verified` record missing one of its proofs, an `autoApplyAllowed` record that is not `verified`, a quarantine with no stated reason, a record with no replacement or no lifecycle claim, and a missing, wrong, or duplicated `entryId`. It runs offline, as part of `npm test` (so a bad record fails the commit that introduces it) and in the weekly `registry-verify` workflow. And `verify-registry --write` never deletes a hand-written reason and never lifts a quarantine — a fresh catalog verdict answers a different question than the one that put a record in quarantine.

Every report ends with the registry's own provenance, computed from the registry that was actually loaded — never a hardcoded date:

```
registry: 106 records
auto-fix eligible: 86
review-only: 20 (quarantined 12, unverified 3, unverifiable 5)
catalog recheck: 2026-08-21
```

**auto-fix eligible** is the headline because it is the number you act on: how many records clear the full four-field gate, counted through the same predicate the codemod calls. Everything else is **review-only**, itemised by state. (An earlier footer led with `98 verified` and put the twelve held records on a line of their own — arithmetically true, and still misleading, because the number a reader takes away is the one next to the word "verified", and 98 was never the number of things mendr would auto-fix.) The **catalog recheck** date is the newest `checkedAt` stamp the records carry; if they carry different dates the line names the newest *and* the oldest rather than implying one date covers all, and it names any record carrying no date at all.

`mendr evidence <id>` prints what a single record actually rests on: its lifecycle and shutdown date, the oracles consulted, the four gate fields as booleans, whether the engine gate passes or holds, and the reviewer's reasons in full — including reasons that undercut the verdict, which is the point of reading it. It accepts either the record's `entryId` or the bare deprecated model id. Stored evidence snapshots (fetched page, content hash, quoted excerpt) exist for entries promoted through `mendr candidates promote`; the entries hand-seeded into the shipped registry have none, and `mendr evidence` says so per entry rather than implying otherwise.

Being precise about what "verified" covers, because it's two different checks: an entry is auto-applied only if the **replacement** is live in a public catalog and isn't contradicted by the provider's own recommendation table, *and* the **deprecation claim** is self-consistent and quote-backed — it states a lifecycle, doesn't claim a model is retired while the catalogs still list it live, carries a shutdown date when the deprecation is only announced, quotes an excerpt that actually names the model, and has the fetched page stored on disk behind it. What mendr does **not** do is independently confirm with the provider that a model was retired. No public oracle answers that, so mendr doesn't pretend to. New entries reach the registry only when a human runs `mendr candidates promote <id>` and clears both checks.

## the three tiers

Every finding lands in exactly one tier, and the tier tells you what mendr is willing to do about it.

| tier | what it means | does mendr patch it? |
| --- | --- | --- |
| **A** | safe automatic patch: a live model argument whose replacement is verified, and the patched code cleared the gates | yes, with `--write` |
| **B** | potential migration requiring review: the id is dead and the replacement is known, but something specific is missing | **never** — no patch is generated, and `--write` will not touch it |
| **C** | informational data occurrence: a deprecated id sitting in a pricing table, a model-picker list, a lookup key, a comparison | no, and nothing to do |

Tier B is the one worth reading. Each finding names *what is missing* with a machine-readable reason code, so you can route or suppress a whole class without grepping English:

| reason code | what's missing |
| --- | --- |
| `replacement_unverified` | it's a live model argument, but the registry's replacement hasn't cleared verification against the public catalogs |
| `platform_blocked` | the value sits under a `deployment` / `deploymentName` / `deployment_name` key instead of a model argument — on Azure and similar platforms that names a provisioned deployment, so it's likely a provisioning change rather than a code change (mendr reads the key, not the value, so confirm which you have) |
| `usage_unverified` | a model-like assignment with no traced sink — the value is a known dead id, but nothing proves it's ever passed to a model call |
| `type_cast_masked` | the model argument is wrapped in an `as` cast to a named type, so the repo may constrain model ids with a type of its own and swapping the raw string could bypass that check (any cast other than `as string` / `as const` triggers this, including `as any`) |

Two further codes, `dynamic_model_value` and `insufficient_dataflow`, exist in the type for future detectors and are never emitted today.

A Tier B finding prints like this — location, both ids, **each dimension on its own row**, both forms of the reason, and the record to go read:

```
=== Tier B: review required ===

agent_app/simulator.py:166:13
  found:                 "gpt-4"
  replacement:           "gpt-5.6-sol"
  replacement verdict:   verified (registry stamp 2026-08-21, not re-checked
                         this run)
  usage verdict:         unverified -- no traced sink in this file
  classification:        tier B -- review required, no patch generated.
  reason:                usage_unverified -- assigned to a model-like
                         variable, but no supported SDK call or parameter sink
                         was found in this file.
  registry entry:        openai.gpt-4.retirement-2026-10-23
  evidence:              mendr evidence openai.gpt-4.retirement-2026-10-23
```

**Three rows, not one.** This block used to print a single `registry verdict: verified` line, which on a Tier B finding reads as though the *finding* were verified — while the usage is exactly what could not be confirmed. The two dimensions are now stated separately (what the registry recorded about the **mapping**, and what mendr established about the **occurrence**), and the third row states the outcome those two produce. Tier A prints the same three rows, where all three are affirmative:

```
  replacement verdict:   verified (registry stamp 2026-08-21, not re-checked
                         this run)
  usage verdict:         confirmed live model argument
  classification:        tier A -- auto-fixable, will apply with --write
  registry entry:        openai.gpt-4-0613.retirement-2026-10-23
  evidence:              mendr evidence openai.gpt-4-0613.retirement-2026-10-23
```

That is the **LOOK** form. This section renders before the write is attempted, so under `--write` it cannot know the outcome and does not guess — it reads `tier A -- auto-fixable; see Summary for whether it was applied`, and the `Summary:` line carries the real disposition (applied, refused, or downgraded). It never promises a `--write` that the same report has already refused.

### registry entry id

Every model-id record carries a stable `entryId`, generated as
`<provider>.<deprecated>.retirement-<shutdownDate|undated>` and validated for
uniqueness in CI. Tier A and Tier B findings print it, next to the exact command
that takes it — before it existed, findings named `mendr evidence <id>` without
ever putting an id on screen.

### replacement verdict

The registry does not claim every mapping it holds is confirmed, so a Tier B finding says which kind it is, in the **label** as well as in the row below it:

```
  candidate replacement: "o3"
  replacement verdict:   unverified -- this mapping did not clear verification
```

A verified mapping is a `replacement`; anything else is a `candidate replacement`, because a reader skimming for the id reads the label and may never reach the row below it.

The row is called **replacement verdict** because that is precisely what it is: a verdict about the *replacement mapping*, stored in a JSON file, stamped on some past date. It covers the mapping and nothing else — the `usage verdict` row beside it covers the occurrence. A `fix-llm` run contacts no catalog, so the row says so out loud rather than implying a live check. It is *not* called "evidence": `entry.evidence` is the field that holds actual provenance (source url, content hash, stored snapshot), it is empty on every entry in the shipped registry, and naming a row after the one thing the data does not have is the kind of overclaim this project exists to avoid. `mendr evidence <id>` prints whatever an entry really has, including "no evidence captured for this entry -- it was hand-seeded."

A quarantined record prints its own stated cause, verbatim, so the reason is on
the same screen rather than one command away:

```
  candidate replacement: "gemini-3.6-flash"
  replacement verdict:   quarantined (registry stamp 2026-08-21) -- stamped
                         "verified" while its own recorded research says "do
                         not auto-apply", "status unknown" -- held for review
                         until that contradiction is resolved
```

A fourth value, `withheld`, is defence in depth: a `verified` stamp sitting over
a switched-off safety field. `validate-registry` rejects that combination
outright, so it should never ship — but if it ever does, the row names the
**field** that is false rather than quoting somebody's prose.

`--json` carries the same fact as `replacementVerdict: "verified" | "quarantined" | "unverified" | "unverifiable" | "unstamped" | "withheld"`, alongside `usageVerdict`, `tier`, `verdictCheckedAt` and the record's `entryId`.

### one occurrence, one tier

Every occurrence — one `(file, line, column, deprecatedId)` — lands in **exactly one** tier, resolved `A > B > C`. The same deprecated id can still appear in two tiers at two different *positions*, and the report says so rather than leaving you to guess:

```
Found: 0 tier A (safe automatic patch), 1 tier B (potential migration, review required),
       3 tier C (informational data occurrence).
       tier B by reason: usage_unverified 1.
note: "gpt-4" appears in more than one tier -- these are different occurrences (tier B: L166; tier C: L12).
```

The collapsed Tier C line carries line numbers for the same reason:

```
  agent_app/simulator.py -- 3 hits: gpt-4 (L12), gemini-1.5-pro (L30, L127)
```

`--verbose` still prints every hit individually.

### gating CI on a tier

```sh
npx github:ajitheee/mendr#v0.2.4-alpha fix-llm . --fail-on tierB
```

`--fail-on` takes `tierA`, `tierB`, or `none` (the default). `blocked` still works as a **deprecated alias for `tierB`** and prints a notice on stderr — note that it now covers every review-required finding, not just unverified replacements.

### `--json`

`--json` emits `tierB` as a first-class array of `{ entryId, file, line, column, modelId, replacement, replacementVerdict, usageVerdict, tier, registryVerdict, verdictCheckedAt, reason, reasonText }`. `tierA` entries carry the same three dimensions: `replacementVerdict` (`null` on a param transform, which rests on no model-id record), `usageVerdict: "confirmed"`, and `tier: "A"`.

`summary` carries `{ tierA, tierB, tierC, mode, uniqueOccurrences, filesModified, ... }`:

* `mode` is `"LOOK"` on any run without `--write` and `"WRITE"` when `--write` was passed — **intent, not outcome**. A `--write` run whose write was refused still reports `WRITE`; `filesModified` carries the result.
* `uniqueOccurrences` is the number of distinct `(file, line, column, modelId)` findings across all tiers, plus the param-transform sites (which are counted in Tier A but sit outside the model-id key space). It always equals `tierA + tierB + tierC`; if it ever could not, the printed line says so and names the tier sum rather than showing a number you cannot reconcile.
* `filesModified` is the count of files actually written — `0` in LOOK mode always, `0` on a refused or rolled-back write, and the real post-write number otherwise. It is the same value as `write.filesWritten`.

The human report prints the same three facts in its footer, above the registry block:

```
mode: LOOK
unique occurrences: 4
files modified: 0
registry: 106 records
```

`write` reports what happened to your working tree, because `summary.tierA` cannot: `{ attempted, applied, filesWritten, reason }`. `attempted` is true whenever `--write` had gated patches to write; `applied` is true only once they are on disk; `reason` carries the abort message when a write was refused (a read-only file, an editor lock, content that drifted since the scan) and is `null` otherwise. The human `Summary:` line reports the same outcome — a refused write prints `0 auto-fixed, N not written -- write refused, working tree unchanged`, never an auto-fix that did not happen.

**Deprecated for one release:** `tierB[].registryVerdict` is superseded by `tierB[].replacementVerdict`. It is still emitted, and always carries exactly the same value, so consumers keep parsing while they migrate — the rename exists because one row (and one field) covering both the mapping and the usage was the overclaim described above. Also deprecated: the pre-three-tier keys `blocked`, `azure`, `informational` and `usageUnverified` (and `summary.blocked` / `summary.informational` / `summary.usageUnverified`) are still emitted so existing consumers keep parsing. They are now *projections* of the tier data — `blocked` is `tierB` filtered to `replacement_unverified`, `azure` to `platform_blocked`, `usageUnverified` to `usage_unverified` — so they cannot drift from the tier counts. One behavior change worth knowing: type-cast-masked findings used to be counted as `informational` and are now Tier B. Move to `tierB` + `summary.tierB`; the old keys will be removed.

## verify behavior, not just code

mendr's gates prove the patched code compiles, parses, and passes your tests. None of that says the *replacement model* behaves like the one it replaced. mendr won't invent a quality score to pretend otherwise — instead, point it at your own evaluation and it will run that.

Drop a `mendr.config.json` at the root of your repo:

```json
{
  "evalCommand": "npm run eval",
  "evalTimeoutMs": 600000
}
```

Both fields are optional. `evalTimeoutMs` defaults to 10 minutes. `evalCommand` is the same setting as `gates.eval.command` (see [which gates must pass](#which-gates-must-pass)). `--eval-command "<cmd>"` on `fix-llm` overrides the file for one run.

The command runs against a throwaway copy of your repo **with the fix already applied**, never against your working tree, and only after the code gates pass. Then:

| outcome | what mendr does |
| --- | --- |
| no eval configured | Tier A stands on the code gates alone, and the report says behavior was not tested — plus how to switch this on. |
| eval exits 0 | `behavioral evaluation:  passed (your eval command: npm run eval, exit 0)`. That's the whole claim: *your* eval passed. |
| eval exits non-zero | **Tier A is downgraded to review.** The diff is printed but not applied, `--write` refuses, and mendr exits non-zero. A behavioral regression blocks the fix exactly like a failing test. |
| eval times out or can't run | **Same thing: the fix is not applied and mendr exits non-zero.** The gate fails closed — you asked for behavioral verification and didn't get it, so mendr won't apply a fix it couldn't verify. The report names the case: the row reads `behavioral evaluation:  inconclusive (…)`, never `not configured`. Raise `evalTimeoutMs` if your eval needs longer. |

Only "no eval configured" lets a fix through on the code gates alone. Once you configure one, nothing short of exit 0 applies anything.

`--json` carries the same fact: `summary.behavioralVerification` is `"not-tested"`, `"pass"`, or `"fail"`, with an `eval` object naming the command, exit code and `status` (`"pass"`, `"fail"` or `"inconclusive"`, plus a `reason` on the last) whenever the gate actually ran. An inconclusive run reports `behavioralVerification: "not-tested"` — nothing was verified — and applies nothing.

## which gates must pass

Every Tier A fix is reported check by check, and no check borrows another's word:

```
Code verification (what mendr checked):
  replacement verdict:    verified (stamped 2026-08-21)
  official source:        confirmed
  usage verdict:          confirmed (live model argument at the call site)
  syntax:                 n/a (typescript -- the type-check gate below subsumes parsing)
  type-check:             passed (no new errors)  [required]
  tests:                  inconclusive (repo has no installed node_modules to link -- cannot run tests)
Behavioral verification (NOT checked):
  behavioral evaluation:  not configured
```

`inconclusive` means the gate **could not run** — it is never printed as `passed`, and it is not the same fact as `not configured` (there was nothing to run) or `n/a` (that gate does not exist for this language).

Whether a gate that did not pass *blocks* the fix is your call, in the same `mendr.config.json`:

```json
{
  "gates": {
    "typecheck": { "required": true },
    "tests":     { "required": false },
    "eval":      { "command": "npm run eval:model-migration", "required": true }
  }
}
```

A gate marked `required` must return `pass` for Tier A. `fail` **or** `inconclusive` downgrades the fix to review, refuses `--write`, and exits non-zero, naming the gate that did not pass. A gate that is not required still blocks on a hard `fail` — `required: false` governs the cases where the gate produced no verdict, never a verdict you dislike.

Defaults, which are exactly mendr's behavior before this block existed:

| gate | default | why |
| --- | --- | --- |
| `typecheck` | required | A patch that introduces a type error is never auto-applied. |
| `tests` | not required | A fresh CI clone of someone else's repo usually can't run their suite. A suite that *runs and fails* still blocks. |
| `eval` | required whenever a command is configured | You asked for behavioral verification; not getting one is not a reason to proceed. |

`gates.eval.command` and the legacy top-level `evalCommand` are the same setting (setting both to *different* commands is an error, not a precedence puzzle), and `--eval-command` beats the file for one run. A malformed `gates` block — an unknown gate name, a misspelled `required`, a command on a gate that runs none — is a hard error naming the file and the field. Unknown *top-level* fields stay inert for forward compatibility, but a gate policy that silently doesn't apply is the failure this block exists to prevent.

`--json` carries the same records: `gates.policy` is what this run required, and `gates.outcomes` lists every gate with its `outcome`, `language`, `required` and `blocking` flags.

## install for repeat use

```sh
npm install -g mendr
```

Then `mendr` is on your path. Requires Node 20 or newer.

## honest limits

- TypeScript and TSX first. Pure-JS repos aren't scanned yet, and mendr will tell you it found nothing analyzable rather than pretend a JS repo is clean.
- It catches inline literal model strings and one-hop consts. A model id built from an env var or string concatenation is invisible on purpose, because guessing there would risk corrupting your code.
- Coverage is OpenAI, Anthropic, and Google model ids and coupled params, plus Stripe renames. More providers are coming.
- **It verifies code, not behavior — unless you configure an eval command.** The gates prove the patched code still compiles, still parses, and still passes your tests. They say nothing about whether the replacement model *behaves* like the one it replaced: output quality, latency, cost, and response shape are never exercised on their own. Set `evalCommand` in `mendr.config.json` (see [verify behavior, not just code](#verify-behavior-not-just-code)) and mendr will run *your* evaluation against the patched code and block the fix if it regresses. Without it, a Tier A pass means the swap is safe to build, not that it's safe to ship.
- It's early. If you run it and it does something dumb, that's exactly the feedback worth sending.

## license

MIT
