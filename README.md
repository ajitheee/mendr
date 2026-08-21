# mendr

mendr auto-fixes third-party API breaking changes in your TypeScript repo. Today it covers deprecated LLM model ids and the params that die with them (OpenAI, Anthropic, Google), plus Stripe field renames.

## the problem

A provider retires a model id, or flips a param like `max_tokens` to `max_completion_tokens` on the newer models. Your code keeps compiling until it doesn't, and you usually find out when it 404s or 400s in prod. mendr finds those spots and hands you the exact diff.

## quickstart

```sh
npx github:ajitheee/mendr fix-llm .
```

(once the package lands on the npm registry this shortens to `npx mendr fix-llm .`)

Point it at a repo and it prints a unified diff of the fixes it wants to make. Read the patch. If it's right, apply it.

You can also point it straight at a GitHub link. mendr clones a throwaway copy and scans that, so the real repo is never touched:

```sh
npx mendr fix-llm https://github.com/someone/their-repo
```

It never writes to your working tree on its own. The default is print-only. When you're ready to apply:

```sh
npx mendr fix-llm . --write
```

`--write` only applies a fix that passed the gates (type-check, plus your tests when they can run). Anything it can't verify is shown for review and left alone. You can also pipe the diff straight into git, since it's a standard patch:

```sh
npx mendr fix-llm . -o mendr.patch && git apply mendr.patch
```

## what it actually does to your files

Nothing, unless you pass `--write`. By default mendr loads your code in memory, works out the fix, and prints a diff. It does not commit, it does not open a PR, and it does not edit your files behind your back. That's the trust line and it stays that way.

## commands

- `mendr fix-llm <path>` — scan a repo for retired model ids and coupled params, print the gated diff. This is the one you'll use. Add `--eval-command "<cmd>"` to have it run your own evaluation against the patched code (see below).
- `mendr check --repo <path> --from <specA> --to <specB>` — list the breaking changes between two Stripe specs that your repo actually uses.
- `mendr scan <path>` — list the Stripe API surface a repo touches.
- `mendr fix <path> --from <specA> --to <specB>` — Stripe field-rename codemod.
- `mendr verify-registry` — check every model-id replacement in the registry against the live public model catalogs and print an audit.

Run any command with `--help` for its flags.

## how it decides what to change

mendr is call-site aware. It only swaps a model string when that string is actually an argument to a recognized LLM call, so it won't touch a model id sitting in a pricing table, a model-picker array, or a lookup map. For param fixes it traces the model at each call site and only removes or renames a param when that specific model requires it, so a `claude-opus` call can lose `temperature` while a sibling `haiku` call keeps it.

Replacements come from a deprecation registry that carries a per-entry verdict from a check against the live public model catalogs, so it isn't guessing from a blog post. Verification is **per entry, not registry-wide** — some entries carry a `verified` verdict, some carry `unverified`, and a few carry a recheck date with a note saying that id was not researched on that pass. The report footer prints the split rather than a blanket claim, and only a `verified` entry is ever auto-applied. If a replacement isn't verified, mendr locates the spot and refuses to auto-apply rather than risk a bad patch.

A stamp is one field, and a hand-edit can get it wrong. So the gate reads the entry's **reasons** too: if an entry is stamped `verified` while its own recorded reasoning says `do not auto-apply`, `status unknown`, `unverified`, `itself deprecated`, `not the currently-recommended` or `stale`, mendr treats it as **self-contradicted** and holds it at Tier B. The reasons are the working that produced the stamp, and when the two disagree the working is the half that was thought about. This is a fail-safe, not a data fix — the data may lie, and the gate must not — and `verify-registry --write` never deletes a hand-written reason, so a routine recheck cannot quietly clear a caveat that was blocking an auto-apply.

Every report ends with the registry's own provenance, computed from the registry that was actually loaded — never a hardcoded date:

```
registry: 106 active entries
catalog recheck: 2026-08-21
entry verification: 98 verified, 3 unverified, 5 unverifiable (per entry, see `mendr evidence <id>`)
held at review: 12 of those verified entries contradict their own stamp in `verification.reasons` and are never auto-applied
```

Those are three different facts and the footer keeps them apart. The **catalog recheck** date is the newest `checkedAt` stamp the entries carry (if entries carry different dates, the line names the newest *and* the oldest rather than implying one date covers all, and it names any entry carrying no date at all). The **entry verification** line is the per-entry verdict, and it is the one that decides what can be auto-applied.

`mendr evidence <id>` prints what a single entry actually rests on: its lifecycle and shutdown date, the oracles consulted, the verdict, and the reviewer's reasons in full — including reasons that undercut the verdict, which is the point of reading it. Stored evidence snapshots (fetched page, content hash, quoted excerpt) exist for entries promoted through `mendr candidates promote`; the entries hand-seeded into the shipped registry have none, and `mendr evidence` says so per entry rather than implying otherwise.

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

A Tier B finding prints like this — location, both ids, what the registry recorded about the mapping, both forms of the reason, and an explicit statement that no patch exists:

```
=== Tier B: review required ===

agent_app/simulator.py:166:13
  found:                 "gpt-4"
  replacement:           "gpt-5.6-sol"
  registry verdict:      verified (stamped 2026-08-21; not re-checked live
                         this run)
  reason:                usage_unverified -- assigned to a model-like
                         variable, but no supported SDK call or parameter sink
                         was found in this file.
  action:                no patch generated.
```

### registry verdict

The registry does not claim every mapping it holds is confirmed, so a Tier B finding says which kind it is, in the **label** as well as in the row below it:

```
  candidate replacement: "o3"
  registry verdict:      unverified -- this mapping did not clear verification
                         (see `mendr evidence o3`)
```

A verified mapping is a `replacement`; anything else is a `candidate replacement`, because a reader skimming for the id reads the label and may never reach the row below it.

The row is called **registry verdict** because that is precisely what it is: a verdict stored in a JSON file, stamped on some past date. A `fix-llm` run contacts no catalog, so the row says so out loud rather than implying a live check. It is *not* called "evidence": `entry.evidence` is the field that holds actual provenance (source url, content hash, stored snapshot), it is empty on every entry in the shipped registry, and naming a row after the one thing the data does not have is the kind of overclaim this project exists to avoid. `mendr evidence <id>` prints whatever an entry really has, including "no evidence captured for this entry -- it was hand-seeded."

A third value appears when the registry disagrees with itself:

```
  candidate replacement: "gemini-3.6-flash"
  registry verdict:      stamped verified 2026-08-21, but withheld -- the
                         entry's own recorded reasons contradict the stamp
                         (see `mendr evidence gemini-2.0-flash`)
```

`--json` carries the same fact as `registryVerdict: "verified" | "unverified" | "self-contradicted"`, alongside `verdictCheckedAt`.

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
npx mendr fix-llm . --fail-on tierB
```

`--fail-on` takes `tierA`, `tierB`, or `none` (the default). `blocked` still works as a **deprecated alias for `tierB`** and prints a notice on stderr — note that it now covers every review-required finding, not just unverified replacements.

### `--json`

`--json` emits `tierB` as a first-class array of `{ file, line, column, modelId, replacement, registryVerdict, verdictCheckedAt, reason, reasonText }`, and `summary` carries `{ tierA, tierB, tierC }`.

`write` reports what happened to your working tree, because `summary.tierA` cannot: `{ attempted, applied, filesWritten, reason }`. `attempted` is true whenever `--write` had gated patches to write; `applied` is true only once they are on disk; `reason` carries the abort message when a write was refused (a read-only file, an editor lock, content that drifted since the scan) and is `null` otherwise. The human `Summary:` line reports the same outcome — a refused write prints `0 auto-fixed, N not written -- write refused, working tree unchanged`, never an auto-fix that did not happen.

**Deprecated for one release:** the pre-three-tier keys `blocked`, `azure`, `informational` and `usageUnverified` (and `summary.blocked` / `summary.informational` / `summary.usageUnverified`) are still emitted so existing consumers keep parsing. They are now *projections* of the tier data — `blocked` is `tierB` filtered to `replacement_unverified`, `azure` to `platform_blocked`, `usageUnverified` to `usage_unverified` — so they cannot drift from the tier counts. One behavior change worth knowing: type-cast-masked findings used to be counted as `informational` and are now Tier B. Move to `tierB` + `summary.tierB`; the old keys will be removed.

## verify behavior, not just code

mendr's gates prove the patched code compiles, parses, and passes your tests. None of that says the *replacement model* behaves like the one it replaced. mendr won't invent a quality score to pretend otherwise — instead, point it at your own evaluation and it will run that.

Drop a `mendr.config.json` at the root of your repo:

```json
{
  "evalCommand": "npm run eval",
  "evalTimeoutMs": 600000
}
```

Both fields are optional. `evalTimeoutMs` defaults to 10 minutes. `--eval-command "<cmd>"` on `fix-llm` overrides the file for one run.

The command runs against a throwaway copy of your repo **with the fix already applied**, never against your working tree, and only after the code gates pass. Then:

| outcome | what mendr does |
| --- | --- |
| no eval configured | Tier A stands on the code gates alone, and the report says behavior was not tested — plus how to switch this on. |
| eval exits 0 | `behavioral verification: pass (your eval command: npm run eval, exit 0)`. That's the whole claim: *your* eval passed. |
| eval exits non-zero | **Tier A is downgraded to review.** The diff is printed but not applied, `--write` refuses, and mendr exits non-zero. A behavioral regression blocks the fix exactly like a failing test. |
| eval times out or can't run | **Same thing: the fix is not applied and mendr exits non-zero.** The gate fails closed — you asked for behavioral verification and didn't get it, so mendr won't apply a fix it couldn't verify. The report names the case ("your eval command was configured but did not complete: …"). Raise `evalTimeoutMs` if your eval needs longer. |

Only "no eval configured" lets a fix through on the code gates alone. Once you configure one, nothing short of exit 0 applies anything.

`--json` carries the same fact: `summary.behavioralVerification` is `"not-tested"`, `"pass"`, or `"fail"`, with an `eval` object naming the command, exit code and `status` (`"pass"`, `"fail"` or `"inconclusive"`, plus a `reason` on the last) whenever the gate actually ran. An inconclusive run reports `behavioralVerification: "not-tested"` — nothing was verified — and applies nothing.

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
