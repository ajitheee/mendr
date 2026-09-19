# Mendr on your repository — what it does, and what it won't

You're the first team outside my own to run this, so this note is longer than it needs to be and
more honest than it has to be. I would rather you know the limits before you install than find
them yourself and stop trusting the output.

## The problem it covers

Exactly one: **a model id hard-coded in your repository that the provider has scheduled for
shutdown.** OpenAI retires `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o3-mini` and `o4-mini` on
2026-10-23. Code pinned to one of those keeps working until that date and then returns
`model_not_found`. Most teams find out from a customer.

It is not a linter, not a cost tool, not an eval harness, and it does not track API parameter
changes — only model retirements.

## How it runs

One workflow file in your repository. The scan runs **in your CI, on your runner**. Only the
findings leave — model ids, file paths, line numbers, classifications, redacted snippets — never
your code. Authenticated by your run's GitHub OIDC token, so there is no secret to store.

When a finding has a fix, **you approve it**, your CI verifies it on a throwaway copy, and one
pull request opens. **Mendr never merges.** A person always does.

## Install

Two pinned lines, plus one repository variable. Everything is pinned to an immutable 40-character
commit SHA rather than a tag, because a tag can be moved and a moved tag is indistinguishable from
the original.

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@ff86f14e18165a984d5e5297b68504190d09f93f
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@ff86f14e18165a984d5e5297b68504190d09f93f
```

Set the repository variable `MENDR_SPEC` to the same SHA so the CLI it fetches is pinned too.

One repository setting is needed for the pull request to open: **Settings → Actions → General →
"Allow GitHub Actions to create and approve pull requests."** Without it the verified change still
lands on a branch and the finding says so.

Full provenance — artifact hash, registry hash and signature, validator result, validation report
— is in `RC-2026-09-16.md`. Verify any of it before you install.

## Permissions it asks for

- **audit job:** `contents: read`, `id-token: write`. No write scopes, no secrets.
- **migrate job:** `contents: write` and `pull-requests: write` — to push one branch and open one
  PR — plus `id-token: write`. It runs only on your approval, never on a push or a pull request.

## What to expect on the first run

- A coverage denominator: discovered, analyzed, test files, languages not read, parse failures,
  unopenable. The categories are exclusive and add up. Read it — it tells you what a quiet result
  is actually worth.
- One of four conclusions. **A general "clean" is not one of them.** If a file could not be parsed
  or opened, the run is `inconclusive`, not clean.
- Probably a **report rather than a patch**. See the first limitation below.

---

# What Mendr will not do

Stated up front, because you'd find all of this anyway.

**1. It will probably not auto-fix anything.** Across 26 real repositories, exactly one produced
an automatically fixable finding. Mendr only rewrites a call site when it can resolve the SDK
client in the same file, and production code usually injects or wraps its client. Expect findings
you review, not patches you merge. If you want the patch rate to be the pitch, it isn't.

**2. It reads TypeScript/TSX, JavaScript and Python. Nothing else.** Go, Java, Kotlin, Rust, C#,
Ruby, PHP are counted and reported as unread, never analyzed. It does not read shell scripts — a
model id set in a `.sh` and passed as a CLI argument is invisible.

**3. Behaviour is never verified.** The gates prove the change builds and your existing tests pass.
They prove nothing about whether the new model matches the old one on quality, latency, cost or
response shape. Every PR says so. Give it an eval command if you have one; it still won't be proof.

**4. The verification environment is not isolated.** It is a *secret-sanitized* environment: a
throwaway copy with your CI's own credentials stripped (`GITHUB_TOKEN`, the OIDC tokens, all
`INPUT_*`) and captured output redacted at the source. But there is **no network isolation, no
process or filesystem isolation, and no resource limits.** Running a gate executes your repository's
own code with your repository's own privileges. If you don't already trust your test suite to run
in CI, this changes nothing about that. Full statement in `TRUST.md` §4b.

**5. Recall is not guaranteed, and the measurement has a known blind spot.** The published
validation narrowed candidates using the scanner's own idea of a candidate, so it can catch an id
sorted into the wrong bucket but structurally cannot catch a whole *position* the classifier
misreads. One such class was found by hand on 2026-09-16 and fixed. Assume others exist. **If you
know of a retiring model id in your repo that Mendr did not report, that is the single most
valuable thing you can tell me.**

**6. Config selection is located, not traced.** Outside an env-var read, Mendr cannot prove your
runtime actually reads a config value, and says so ("reader tie-back not proven").

**7. Runtime usage is unmeasured by default.** Unless you connect telemetry, "is this model
actually receiving production traffic" is a question Mendr does not answer.

**8. The migrate path's action reference is governed by a tag.** GitHub forbids an expression in a
workflow's `uses:`, so pinning by SHA gets you the workflow file at that SHA — and that file names
the Mendr action by tag. Every other link is pinned by content or commit. This is the one that
isn't, and it depends on me never moving a released tag.

**9. It is alpha, and you are the first.** Distribution is by git spec, not npm. The
approve-to-PR path has been exercised on my demo repository, not yet on anyone else's.

---

## What I'm asking of you

- One repository connected, private preferred.
- One person who can click Approve and review a pull request.
- Fifteen minutes after the first finding, and fifteen after the first PR.
- Honesty when it is wrong. A false positive is useful; a **false negative** is gold.

## What I promise

- Only findings leave your CI; nothing is applied without your approval; Mendr never merges.
- Uninstalling deletes everything stored about the repository.
- If it produces a wrong edit, I will tell you before you find it.
- A direct line to me for the whole beta.
