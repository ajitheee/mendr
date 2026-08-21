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

Replacements come from a deprecation registry that's verified against the live public model catalogs, so it isn't guessing from a blog post. If a replacement can't be verified, mendr locates the spot and refuses to auto-apply rather than risk a bad patch.

Being precise about what "verified" covers, because it's two different checks: an entry is auto-applied only if the **replacement** is live in a public catalog and isn't contradicted by the provider's own recommendation table, *and* the **deprecation claim** is self-consistent and quote-backed — it states a lifecycle, doesn't claim a model is retired while the catalogs still list it live, carries a shutdown date when the deprecation is only announced, quotes an excerpt that actually names the model, and has the fetched page stored on disk behind it. What mendr does **not** do is independently confirm with the provider that a model was retired. No public oracle answers that, so mendr doesn't pretend to. New entries reach the registry only when a human runs `mendr candidates promote <id>` and clears both checks.

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
