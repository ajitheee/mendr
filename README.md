<p><img src="brand/mendr-lockup.png" alt="mendr" height="44"></p>

# mendr

**Find every retiring AI model your repo still calls, before the provider shuts it off.**

One command scans TypeScript, TSX, JavaScript, Python and config files, joins a dated retirement registry for OpenAI, Anthropic and Google, and tells you what breaks, where, and by when. No API key. Nothing is changed.

**Beta partner?** Start with [BETA-ONBOARDING.md](BETA-ONBOARDING.md): connect in five minutes, what you will see, what leaves your CI, troubleshooting.

```sh
npx github:ajitheee/mendr#v0.5.10-alpha audit .
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
npx github:ajitheee/mendr#v0.5.10-alpha audit . --install
```

scaffolds a GitHub workflow that keeps **one issue per repository** current: new, continuing and resolved findings, the exact commit scanned, and the coverage matrix. It asks for `contents: read` and `issues: write`, never touches your default branch, and never merges anything.

## want the fix, not just the finding?

`fix-llm` goes one step further: it writes the exact diff for a retired id at a verified call site and proves it against your type-check and tests before anything is applied. Print-only by default — read the patch, and if it's right, apply it:

```sh
npx github:ajitheee/mendr#v0.5.10-alpha fix-llm .
```

You can also point it straight at a GitHub link. mendr clones a throwaway copy and scans that, so the real repo is never touched:

```sh
npx github:ajitheee/mendr#v0.5.10-alpha fix-llm https://github.com/someone/their-repo
```

It never writes to your working tree on its own. The default is print-only. When you're ready to apply:

```sh
npx github:ajitheee/mendr#v0.5.10-alpha fix-llm . --write
```

`--write` only applies a fix that passed the gates (type-check, plus your tests when they can run). Anything it can't verify is shown for review and left alone. You can also pipe the diff straight into git, since it's a standard patch:

```sh
npx github:ajitheee/mendr#v0.5.10-alpha fix-llm . -o mendr.patch && git apply mendr.patch
```

### keep watching a repo

`fix-llm` is one-shot. `mendr watch` is the resident version — it scans in your own GitHub Actions and keeps one issue listing every deprecated model id you use, grouped by risk and deadline, so you find out before a model retires. Run it once to see your exposure, or `--install` to make it resident:

```sh
npx github:ajitheee/mendr#v0.5.10-alpha watch .
```

See [standing watch](#standing-watch) for the details and [WATCH-SCHEMA.md](WATCH-SCHEMA.md) for the JSON.

## what it actually does to your files

Nothing, unless you pass `--write`. By default mendr loads your code in memory, works out the fix, and prints a diff. It does not commit, it does not open a PR, and it does not edit your files behind your back. That's the trust line and it stays that way.

## what leaves your machine

Nothing, by default. The audit reads the repository, the bundled registry and your local `git rev-parse`, and prints a report. That is enforced in code, not just written here: the test suite runs the audit under a preload that makes every network primitive throw, and the audit must still pass. You can enforce it yourself:

```bash
npx github:ajitheee/mendr#v0.5.10-alpha audit . --offline
```

The optional network uses are: the **registry refresh** (`--refresh-registry`, or `MENDR_REGISTRY_REFRESH=on`, which the generated workflows set) — one GET of three public, signed files so the audit uses current retirement knowledge, verified against a key built into the release before use, sending nothing; the provider usage read you ask for by name with your own read-only key; and a shallow `git clone` when you pass a GitHub URL instead of a path. The [Mendr GitHub App](app/README.md) is the one hosted piece: your workflow posts the audit JSON to it, proven by the run's OIDC token, and it writes a check run back; it has no `contents` permission and cannot read code. [TRUST.md](TRUST.md) has the per-command table, the data-flow diagram, the threat model, the permissions each surface needs, and the known gaps. [SECURITY.md](SECURITY.md) is how to report a problem with any of it.

## commands

- `mendr audit [path]` — **(preview)** the unified audit: scan TS/TSX/JS/Python source + config, join the deprecation registry, and report every retiring AI dependency with its location, deadline, and migration evidence. **Needs only the repository.** See below.
- `mendr fix-llm <path>` — scan a repo for retired model ids and coupled params, print the gated diff. This is the one you'll use. Add `--eval-command "<cmd>"` to have it run your own evaluation against the patched code (see below).
- `mendr migrate [path]` — **(preview)** verify a migration in a secret-sanitized verification environment and emit a portable result (`mendr-migration/v1`): the diff, every model swap, each gate's outcome (type-check, your build, your tests, an optional eval), an overall verdict and whether it is PR-ready. It never writes your working tree. `--json` for the artifact, `--patch <file>` for the git-applyable patch, `--eval-command "<cmd>"` for a behavioral gate.
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
| `inconclusive` | the core source scan did not complete, or the registry it was joined against is not provably fresh — silence proves nothing |
| `audit_failed` | a surface was attempted and errored |

Every run prints a coverage report showing which surfaces ran, so a skipped or
failed surface is always visible.

**Registry freshness.** A pinned release ships its registry; left alone it would
re-scan forever with the knowledge of the day the tag was cut. So every registry
in use is dated and graded by age: older than 14 days
(`MENDR_REGISTRY_MAX_AGE_DAYS`) is stale, and a zero-finding scan on a stale
registry is `inconclusive` (exit 3) — stale knowledge can still prove an
exposure, never the absence of one. `--refresh-registry` (or
`MENDR_REGISTRY_REFRESH=on`, which the generated workflows set) fetches the
latest signed snapshot: one GET of public files, verified against a key built
into the release before use, nothing sent. Off by default; `--offline` wins.
Knobs, the verify path and the threat model: [REGISTRY-FRESHNESS.md](REGISTRY-FRESHNESS.md).

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
npx github:ajitheee/mendr#v0.5.10-alpha watch .
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
npx github:ajitheee/mendr#v0.5.10-alpha watch --install
```

That scaffolds `.github/workflows/mendr-watch.yml` — a workflow that runs in **your own CI** (no server, nothing on our infrastructure) and maintains **one** GitHub issue: your deprecated model ids, each mapped to its retirement date, sorted by the nearest deadline. It's the [Renovate dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) mechanic — the issue is found by a hidden marker and edited in place forever, never re-posted, so it re-surfaces itself without ever spamming you. It asks for `issues: write` and `contents: read` and nothing else: it opens no pull requests, runs none of your tests, and pushes no commits. It's pinned to an immutable Mendr release (overridable via a `MENDR_SPEC` repo variable), so a future upstream change can't run in your CI without you choosing it.

Honest limits, up front: the countdown is day-granularity (GitHub cron drifts — it is never an exact-time promise), it maintains one issue and closes it when your exposure clears, and the optional README badge is a snapshot you paste, not a live endpoint (the paying case is private repos, which a live badge host can't read).

## how it decides what to change

mendr is call-site aware. It only swaps a model string when that string is actually an argument to a recognized LLM call, so it won't touch a model id sitting in a pricing table, a model-picker array, or a lookup map. For param fixes it traces the model at each call site and only removes or renames a param when that specific model requires it, so a `claude-sonnet-5-5` call can lose `temperature` while a sibling `claude-haiku-4-5-20251001` call keeps it.

Anthropic’s sampling rules (`temperature`, `top_p`, `top_k`) cover every model Anthropic’s pages say rejects a non-default value: Claude Opus 4.7 and later, Claude Sonnet 5 and 5.5, Claude Haiku 5.5, Claude Fable 5 and 5.1, Claude Mythos 5 and 5.1, and Claude Mythos Preview. Claude Sonnet 4.6, Claude Haiku 4.5 and earlier models accept the parameters, so their calls keep them. Each rule quotes the Anthropic sentences it rests on, and `mendr check-rules` re-reads them on the live pages; a rule whose sentence has gone fails the check. In TypeScript and JavaScript, a call that migrates onto one of these models and passes a sampling value or `max_tokens` goes to review (`param_behaviour_change` or `coupled_param_unverified`) instead of being patched. Since `v0.5.10-alpha`, Python's parameter guard holds the same call with the same reason code, wherever it can read the parameter (see *Held calls: what is and is not protected*). Python has no parameter pass, so nothing drops a sampling value from a Python call; check by hand a Python call whose parameters the guard does not read, before a swap onto these models.

OpenAI’s migration guide tells a move to GPT-5.6 to replace `prompt_cache_retention` with `prompt_cache_options.ttl`, and a move to GPT-6 from GPT-5.5 or earlier to set that ttl to `"30m"`. No registry rule can make that edit, and the guide does not say whether the API rejects the old field. So in TypeScript and JavaScript, a call that passes `prompt_cache_retention` and would migrate onto a GPT-5.6 model goes to review (`coupled_param_unverified`) instead of being swapped with the field kept. The same guard cannot reach a GPT-6 replacement, because no parameter rule names that family, so `gpt-5.3-codex` → `gpt-6-sol`, the only GPT-6 migration nothing else held, is review-only for every call. Since `v0.5.10-alpha`, Python's parameter guard holds a Python call that passes `prompt_cache_retention` onto GPT-5.6 in the same way, wherever it can read the parameter; like the TypeScript guard, it cannot reach a GPT-6 replacement.

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

`mendr evidence <id>` prints what a single record actually rests on: its lifecycle and shutdown date, the oracles consulted, the four gate fields as booleans, whether the engine gate passes or holds, and the reviewer's reasons in full — including reasons that undercut the verdict, which is the point of reading it. It accepts either the record's `entryId` or the bare deprecated model id. Stored evidence snapshots (fetched page, content hash, quoted excerpt) exist for entries promoted through `mendr candidates promote` and for most review-only records a reviewer added by hand from a provider page; some of those also cite the model page or migration guide behind a hold. The original hand-seeded entries have none, and `mendr evidence` says so per entry rather than implying otherwise.

Being precise about what "verified" covers, because it's two different checks: an entry is auto-applied only if the **replacement** is live in a public catalog and isn't contradicted by the provider's own recommendation table, *and* the **deprecation claim** is self-consistent and quote-backed — it states a lifecycle, doesn't claim a model is retired while the catalogs still list it live, carries a shutdown date when the deprecation is only announced, quotes an excerpt that actually names the model, and has the fetched page stored on disk behind it. What mendr does **not** do is independently confirm with the provider that a model was retired. No public oracle answers that, so mendr doesn't pretend to. Entries become auto-fix eligible only when a human runs `mendr candidates promote <id>` and they clear both checks. When the gate cannot check a candidate (a replacement no public catalog lists yet, a restricted-access model, an image model), a reviewer can add it by hand as **review-only**: status `unverified`, `unverifiable` or `quarantined`, auto-apply off, evidence kept. mendr then flags the id in your code and names the replacement, but never edits it, and the registry validator rejects auto-apply on any record that is not `verified`.

Records match by exact id, so a record covers the one id it names. Some deprecations pages retire an alias or a model family and give no date for the dated snapshots under it. A snapshot like that, which the provider's model page lists and marks Deprecated, can be recorded on its own: review-only, with no shutdown date, and an entry id ending in `retirement-undated`. Six are recorded this way today: `gpt-5.1-2025-11-13`, `gpt-5.4-nano-2026-03-17`, `gpt-4o-audio-preview-2025-06-03`, `gpt-4o-audio-preview-2024-12-17`, `gpt-4o-mini-audio-preview-2024-12-17` and `gpt-4o-mini-realtime-preview-2024-12-17`. A call or a usage row on one of them gets a finding that reads "no dated deadline", and the record's note gives the date the provider stated for the alias or family. That date is never copied onto the snapshot, because a future retirement has to be stated by the provider for the id itself. A row that names only a family (OpenAI's `gpt-4o-audio`, `gpt-4o-mini-audio` and `gpt-4o-mini-realtime`) is kept as the provider wrote it, but no OpenAI page lists a model by that literal id, so it matches nothing callable; its note says which callable ids have records of their own and which do not yet.

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
| `coupled_param_unverified` | it's a live model argument, but the call passes a model-dependent parameter (such as `max_tokens` on an Anthropic call) that no migration rule covers for the replacement, so swapping the id alone could leave a request the provider rejects |
| `param_behaviour_change` | it's a live model argument and a migration rule covers its parameter, but the rule only starts applying on the replacement, so it changes what the call asks for (a token limit that now also counts reasoning tokens, or a sampling value that is dropped); the value needs a person |
| `surface_capped` | the id is held for where or how it is used, such as in a sample tree, as a gateway-prefixed id (the successor may need a different prefix), behind a wrapper class, through a proxy or partner client or one mendr cannot resolve, in a request made at import time, or (in Python) through a legacy SDK or an endpoint whose successor is not verified for it. A fine-tuned model id (`ft:…`) is held here too, wherever it is used, because swapping it for the base-model replacement would drop the customer's training; see *Fine-tuned models* below the table. On an Azure client the value names a deployment, so the change may be a provisioning one. `fix-llm`'s human report prints the specific rule under the finding. `fix-llm --write` and `migrate` skip the parameter edits they can tie to a held call; see *Held calls: what is and is not protected* below the table |
| `platform_blocked` | the value sits under a `deployment` / `deploymentName` / `deployment_name` key instead of a model argument — on Azure and similar platforms that names a provisioned deployment, so it's likely a provisioning change rather than a code change (mendr reads the key, not the value, so confirm which you have) |
| `usage_unverified` | a model-like assignment or default with no traced sink (a model-named constant, a default-configuration object, a CLI `--model` default, a field default) — the value is a known dead id, but nothing proves it's ever passed to a model call. `fix-llm` lists these for TypeScript and Python alike, as `audit` does, and prints the scanner's own sentence under the finding when it says more than this one. A Python call held for its client, wrapper or surface is `surface_capped`, not this |
| `type_cast_masked` | the model argument is wrapped in an `as` cast to a named type, so the repo may constrain model ids with a type of its own and swapping the raw string could bypass that check (any cast other than `as string` / `as const` triggers this, including `as any`) |

Two further codes, `dynamic_model_value` and `insufficient_dataflow`, exist in the type for future detectors and are never emitted today.

**Held calls: what is and is not protected.** The model id that put a call on hold at review (`surface_capped`, `coupled_param_unverified`, `param_behaviour_change`) is never swapped. `fix-llm --write` and `migrate` also skip parameter edits (such as renaming `max_tokens`) that they can tie to the held call. That covers its options object, and objects nested in it through objects, arrays, spreads, casts, ternaries, `||`, `??` or `&&`, when the call's model is a string literal, a `||` / `??` / ternary of literals, or a const declared in the same file. In `v0.5.9-alpha` that model also had to be written as `model: …` with a plain key and no `!`. Since `v0.5.10-alpha`, a `{ model }` shorthand, a quoted `"model"` or computed `["model"]` key, and `MODEL!` are tied to the held call too. Not covered yet, so a parameter rule can still edit a held call's request:

- the held call's model read as `this.model`, or the held id under any model-like key other than `model` (`modelName`, `modelId`, `model_name`, `fallbackModel`, …);
- a nested request reached by indexing, a property read, a callback, or a call inside the arguments (`.filter(Boolean)`, `.map(…)`);
- a request built in a variable whose model is not a literal written in that object (`const req = { model: MODEL, … }`), or spread in from one. A request object whose retiring id IS written in it (`const req = { model: 'gpt-4', … }` passed to `client.chat.completions.create(req)`) is judged like an inline argument, and when that call is held, its own parameters are skipped too.

**Python calls are held for their parameters too** (on `main` after `v0.5.9-alpha`; that tag swaps them). A Python call that passes a parameter a registry rule changes on the replacement, or, when the replacement is in a family some rule constrains, a model-dependent parameter (`temperature`, `top_p`, `top_k`, `max_tokens`, `n`, …) that no rule covers for it, is held with the reason code TypeScript gives the same call, `param_behaviour_change` or `coupled_param_unverified`, in `audit`, `watch` and `fix-llm` alike. Both languages ask one function, so the rules are not kept twice. `client.chat.completions.create(model="gpt-3.5-turbo", max_tokens=20)` is held, not swapped to `gpt-5.6-terra` with `max_tokens` kept, and so is a Claude Opus 4.1 call passing `max_tokens` or `temperature`. A call whose replacement is in no rule's family is still patched: `claude-3-5-sonnet-20241022` with `max_tokens` and `temperature` moves to `claude-sonnet-4-6`.

`migrate` and the Action do not list these held Python calls yet, as with the TypeScript held calls in the `v0.5.9-alpha` known issues. `migrate` leaves a held call unswapped and does not name it under skipped. A Python call that `v0.5.9-alpha` swapped and this guard holds is therefore no longer migrated. If a repository's only findings are held calls, `migrate` reports no migration, and the Action reports the repository clean and closes an open Mendr pull request. Run `audit` to see every held call.

The parameters read are:

- the call's keyword arguments;
- the keys of a dict unpacked into the call with `**name`, when `name` is bound to a dict display or `dict(…)` where Python would look it up (the call's own function, an enclosing function, or the module), plus keys added there or beside the call with `name["k"] = …`, `name.update(…)` or `name.setdefault("k", …)`; and the keys of a `**{…}` or `**dict(…)` written in the call;
- for a function parameter unpacked into the call (`def chat(messages, **kwargs)`, then `**kwargs`), the keys added to it in those three ways, such as `kwargs.setdefault("max_tokens", 512)`, because they are sent whatever the caller passes;
- for a model bound to a name that mendr traces into the call (`MODEL = "…"`, `self.model = "…"`, a class attribute or a parameter default, then `model=MODEL`), the keyword arguments of each call whose model is that same value: the same binding of the name, or `self.model` inside the same class. A call on `self.judge.model`, on `args.model`, or on a parameter, local, import or comprehension variable that shadows the name does not take the value, so its parameters do not hold it. The finding sits on the line the value is written on, and its sentence names the call's line. TypeScript follows the same hop, and more (see *Which requests the parameter checks read* below); there the finding carries the held request's own sentence, which does not name the call's line.

Not read, so such a call can still be swapped with the parameter as written: the keys a caller passes in through a function parameter such as `**kwargs`, a dict mendr cannot see (an attribute such as `**self.params`, a call result), a parameter nested in another argument (`extra_body={…}`, `config=…`), a key added to the dict in some other function, and a call that reads a class attribute through an object outside its class (`cfg.model` for a dataclass field `model: str = "…"`). Python has no parameter pass, so nothing renames or drops a parameter after a swap. A call whose old model is already under the same rule (`o3-mini` with `max_tokens`) stays Tier A in both languages; in Python it keeps `max_tokens`, which that rule says the old model rejected as well.

A second model value inside a held call that is not itself held can still be swapped: the plain branch of `useGw ? 'openai/…' : '…'`, or a factory call such as `openai('…')` inside the request. A model value inside a held Python call can be swapped the same way. A call that no retiring id reaches is not held, so a sample or proxy call on a current model gets parameter rules like any other; so does a call mendr reports as Tier C, as an untraced const (`usage_unverified`), or in Tier B for an unverified replacement (`replacement_unverified`) or an `as` cast (`type_cast_masked`), even though that Tier B finding itself says no patch was generated for the model id.

**Which requests the parameter checks read.** This covers TypeScript and JavaScript; the Python guard's reads are listed above. In `v0.5.9-alpha`, the checks behind `coupled_param_unverified` and `param_behaviour_change` ran only when the model id was a string literal written as the `model:` value itself. The same call was a Tier A swap when the id came through a `const`, a `{ model }` shorthand, an `as` cast, a `||` / `??` fallback or a ternary, and `max_tokens` could be left beside a replacement whose registry rule renames it. The release notes list this under Known issues. Since `v0.5.10-alpha`, the checks read every request the id reaches, the way they read the call written inline:

- the id written in the request, behind parentheses, `as string` or `as const`, or as one branch of a `||` / `??` fallback or a ternary;
- a `const`, a class property or an assignment such as `this.model = …`, read by name in a request, including through `{ model }`, `!`, a fallback or a ternary. The declaration is held when any request that reads it would be held written inline, and the finding carries that request's reason. A request also reads it through another binding that the same file feeds it: a local set from it (`const m = MODEL`), a function's parameter at a call that passes it (`ask(MODEL)`, `ask(m)`, `new Bot(MODEL)`, or `withRetry(ask, MODEL)`, which hands the function on beside it), or a field the constructor sets from such a parameter (`constructor(model: string) { this.model = model }`). A request whose `model` is a different variable of the same name that nothing in the file feeds, such as a function's own parameter or a local, does not hold it. A property of another object, `config.model = …`, is read back only through a `.model` read, so a plain `model` variable that is never set from one does not hold it either. Calls in other files are not read: a parameter fed the declaration only from another file does not hold it, so check such a call by hand;
- parameter keys however they are written: `max_tokens`, `"max_tokens"` and `["max_tokens"]` are one key.

The parameter fix that follows a swap reads the model through a `const` (or a `let` / `var` that nothing assigns again), a `{ model }` shorthand, parentheses, `as string`, `as const` and `!`, and reads a quoted or computed key as the plain one, renaming it in its own spelling. It reads those shapes only in a request: an object passed to a call, or a request object built in a variable and passed to a provider endpoint. An object that is not a request, such as a model table, a presets list or a settings object, is edited only where `v0.5.9-alpha` edited it: its keys are plain, and its model is written `model: '…'` or `model: NAME` for a variable set to a plain string. So `[{ name: 'Short', model, max_tokens: 256 }]`, `{ model, temperature: 0.7, label: 'Opus' }` and `{ model: 'o3-mini' as string, max_tokens: 100000 }` are left as they are, and a table row `{ model: 'o3-mini', max_tokens: 100000 }` is still renamed, as before. To keep a file of such rows as written, put the line `// mendr: model-catalog` in its first five lines. A `let` that is assigned again is no longer read as one model, so its request's parameters are left alone. In `v0.5.9-alpha`, `let model = 'claude-opus-4-8'; if (cheap) model = 'claude-sonnet-4-6'` lost `temperature` on the Sonnet path too.

Still not covered: when the parameter rule already applied to the old model, the swap stays Tier A, and its parameter fix lands only where the fix can read the model. An example is `o3-mini` to `gpt-5.6-sol` with `max_tokens`, which the rule renames for both. A request whose model is `this.model`, a fallback or a ternary, or a model-like key other than `model` is swapped with `max_tokens` left as it was. The registry's rule says the old model already rejected that request, so check such a call by hand.

**Fine-tuned models.** OpenAI names a fine-tuned model `ft:<base>:<org>:<suffix>:<job id>`, for example `ft:gpt-3.5-turbo-0125:acme::9abc`. The TypeScript, JavaScript and Python scanners locate one wherever they locate a plain model id, and join it to a registry row by the rule the usage audit applies to the fine-tunes it observes:

- A fine-tune joins the registry's row for fine-tunes of its base model. That row covers the base model and its own snapshots, and the most specific row wins: `ft-gpt-3.5-turbo` covers `ft:gpt-3.5-turbo-0125:…`, and `ft-gpt-4` covers `ft:gpt-4-0613:…` but not `ft:gpt-4o-…`.
- A fine-tune that no such row covers joins its base model's row. A fine-tune of a model the registry does not list is not a finding.
- A fine-tune is never swapped, whatever its row says, because every replacement is a base model and the swap would drop the customer's training. Wherever a plain id would be a live or untraced selector, the fine-tune is held for review (`surface_capped`). It is held for its training before any parameter is read, so a fine-tune call that also passes a parameter the parameter guard would hold (such as `max_tokens` on a move to `gpt-5.6-sol`) still gets the training reason, in TypeScript and Python alike. `fix-llm` prints that sentence under the finding, `audit` counts it as exposure and says the same, and `watch` lists it under review. In a list, a lookup key or a comparison it is Tier C, as a plain id would be. In a test file it is a test-only reference.
- Only a whole fine-tune id matches: `ft:`, the base model, the organisation, the suffix (which may be empty), the job id, and optionally a checkpoint (`:ckpt-step-88`), with nothing around it. A gateway prefix (`openai/ft:…`) is accepted. A string that merely contains a fine-tune id, an f-string or template literal that builds one, and an id with a part missing are not findings.

Not covered yet:

- A fine-tune id in a config file (`.env`, YAML, JSON) is still reported as a catalog reference (Tier C) under its base model's row, with the base model's date. Read the config Tier C list for `ft:` ids you know are selected.
- `audit` describes a fine-tune that joins its base model's row (no `ft-` row covers it) with the generic wording for a held call. It is still held and never swapped.

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
npx github:ajitheee/mendr#v0.5.10-alpha fix-llm . --fail-on tierB
```

`--fail-on` takes `tierA`, `tierB`, or `none` (the default). `blocked` still works as a **deprecated alias for `tierB`** and prints a notice on stderr — note that it now covers every review-required finding, not just unverified replacements.

Since `v0.5.9-alpha` that includes the TypeScript/JavaScript calls mendr holds at review (`coupled_param_unverified`, `param_behaviour_change`, `surface_capped` above). `audit` always listed them; `fix-llm` in `v0.5.8-alpha` and earlier left them out, printed "Nothing to fix" and exited 0, so a gate that passed on those versions can fail after the upgrade. That is the gate reporting calls it should always have reported. `--fail-on tierA` can move the other way: a parameter edit inside a held call's request used to be counted as Tier A, and a repository whose only Tier A was such an edit can now pass.

Since `v0.5.10-alpha`, the gate can move again for one more set of calls. A call whose model id comes through a `const`, a `{ model }` shorthand, a cast, a fallback or a ternary, with a parameter beside it that holds the same call written inline, moves from Tier A to Tier B. So `--fail-on tierB` can fail where `v0.5.9-alpha` passed, and `--fail-on tierA` can pass where it failed. See *Which requests the parameter checks read* above.

Python calls the parameter guard holds (see *Held calls* above; on `main` after `v0.5.9-alpha`) move the same way. A call `v0.5.9-alpha` reported as a Tier A swap is now Tier B, so `--fail-on tierB` can fail where it passed, and `--fail-on tierA` can pass where it failed. A Python call whose replacement is unverified and that passes such a parameter changes reason code, from `replacement_unverified` to `param_behaviour_change` or `coupled_param_unverified`, as the same TypeScript call already does; it stays Tier B. A committed `.mendr/exposure.json` changes once for these calls on the first run after the upgrade.

`--fail-on tierA` can also fail where `v0.5.9-alpha` passed. The parameter fix now reads a request whose model comes through a `{ model }` shorthand, parentheses, `as string`, `as const` or `!`, or whose parameter key is quoted or computed. A parameter edit there counts in Tier A even when no model id in the repository is retiring: `const model = 'gpt-5.6-sol'; create({ model, max_tokens: 256 })` gets `max_tokens` renamed to `max_completion_tokens`. An object that is not a request does not (see above).

The calls that move to Tier B on `main` also drop out of `migrate` and the GitHub Action. `migrate` never swaps a held call, so a repository whose only findings are such calls gets `NO MIGRATION — no verified Tier-A swap was found`, where `v0.5.9-alpha` proposed the swap. The Action then reports the repository clean and closes a Mendr pull request it had opened. This is the `v0.5.9-alpha` Known issue that `migrate` and the Action do not disclose held calls, now reached by more calls. The most common case is a call to Claude 2, Claude 3 Opus, Opus 4 or Opus 4.1 whose model comes through a `const` or a `{ model }` shorthand: Anthropic requires `max_tokens`, so every such call passes it, and that holds the swap to `claude-opus-4-8` for review. An OpenAI call that passes `max_tokens` to a model whose replacement is a `gpt-5.6` model, such as `gpt-4-0613` (which shuts down on 2026-10-23), is held the same way. Until `migrate` lists held calls, read Tier B in `mendr audit` or `fix-llm` before you trust a clean result or a closed Mendr pull request.

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

**Deprecated for one release:** `tierB[].registryVerdict` is superseded by `tierB[].replacementVerdict`. It is still emitted, and always carries exactly the same value, so consumers keep parsing while they migrate — the rename exists because one row (and one field) covering both the mapping and the usage was the overclaim described above. Also deprecated: the pre-three-tier keys `blocked`, `azure`, `informational` and `usageUnverified` (and `summary.blocked` / `summary.informational` / `summary.usageUnverified`) are still emitted so existing consumers keep parsing. They are now *projections* of the tier data — `blocked` is `tierB` filtered to `replacement_unverified`, `azure` to `platform_blocked`, `usageUnverified` to `usage_unverified` — so they cannot drift from the tier counts. The newer Tier B codes (`coupled_param_unverified`, `param_behaviour_change`, `surface_capped`) have no legacy key and no legacy `summary` count: read them from `tierB` and `summary.tierB`. One behavior change worth knowing: type-cast-masked findings used to be counted as `informational` and are now Tier B. Move to `tierB` + `summary.tierB`; the old keys will be removed.

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
