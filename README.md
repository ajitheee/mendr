# mendr

mendr auto-fixes third-party API breaking changes in your TypeScript repo. Today it covers deprecated LLM model ids and the params that die with them (OpenAI, Anthropic, Google), plus Stripe field renames.

## the problem

A provider retires a model id, or flips a param like `max_tokens` to `max_completion_tokens` on the newer models. Your code keeps compiling until it doesn't, and you usually find out when it 404s or 400s in prod. mendr finds those spots and hands you the exact diff.

## quickstart

```sh
npx mendr fix-llm .
```

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

- `mendr fix-llm <path>` — scan a repo for retired model ids and coupled params, print the gated diff. This is the one you'll use.
- `mendr check --repo <path> --from <specA> --to <specB>` — list the breaking changes between two Stripe specs that your repo actually uses.
- `mendr scan <path>` — list the Stripe API surface a repo touches.
- `mendr fix <path> --from <specA> --to <specB>` — Stripe field-rename codemod.
- `mendr verify-registry` — check every model-id replacement in the registry against the live public model catalogs and print an audit.

Run any command with `--help` for its flags.

## how it decides what to change

mendr is call-site aware. It only swaps a model string when that string is actually an argument to a recognized LLM call, so it won't touch a model id sitting in a pricing table, a model-picker array, or a lookup map. For param fixes it traces the model at each call site and only removes or renames a param when that specific model requires it, so a `claude-opus` call can lose `temperature` while a sibling `haiku` call keeps it.

Replacements come from a deprecation registry that's verified against the live public model catalogs, so it isn't guessing from a blog post. If a replacement can't be verified, mendr locates the spot and refuses to auto-apply rather than risk a bad patch.

## install for repeat use

```sh
npm install -g mendr
```

Then `mendr` is on your path. Requires Node 20 or newer.

## honest limits

- TypeScript and TSX first. Pure-JS repos aren't scanned yet, and mendr will tell you it found nothing analyzable rather than pretend a JS repo is clean.
- It catches inline literal model strings and one-hop consts. A model id built from an env var or string concatenation is invisible on purpose, because guessing there would risk corrupting your code.
- Coverage is OpenAI, Anthropic, and Google model ids and coupled params, plus Stripe renames. More providers are coming.
- It's early. If you run it and it does something dumb, that's exactly the feedback worth sending.

## license

MIT
