# Mendr Watch, tester quickstart

Mendr Watch tells you which deprecated model ids your code uses and when each one
stops working, and it keeps a single GitHub issue up to date so you find out
before a model retires instead of after.

You are testing this from a branch, so your normal setup does not change. Nothing
here touches your default `mendr fix-llm` install.

## See your exposure (about 30 seconds, no setup)

Run this in any repo you want to check:

```bash
npx github:ajitheee/mendr watch .
```

You can also point it straight at a GitHub URL, which scans a read-only copy so
you do not have to clone it yourself:

```bash
npx github:ajitheee/mendr watch https://github.com/you/your-repo
```

It prints every deprecated model id in your code, sorted by the nearest
retirement date, with a countdown. It also writes a small `.mendr/exposure.json`
you can commit if you want to track it. If your repo is clean it says so and
tells you exactly what it checked, so a clean result is never mistaken for a
blind spot.

## Make it resident (one setup step)

This scaffolds a GitHub Action that keeps one self-updating issue current in your
repo. It runs in your own CI. There is no server, and none of your code leaves
your repo.

```bash
npx github:ajitheee/mendr watch --install
```

Before it will run, pin the version. In your repo settings, under Secrets and
variables, Actions, Variables, add a repository variable:

- Name: `MENDR_SPEC`
- Value: `270ec71`

The workflow refuses to run unpinned on purpose, so a future change to Mendr can
never run in your CI without you choosing it. `270ec71` is the current commit on
`main`; pin to it (or any later `main` commit SHA) rather than a branch.

Then commit and push the workflow file. On the next run it opens one issue titled
"Mendr Watch". After that it edits that same issue in place. It never opens a
second one and never spams you. When your exposure clears it closes the issue,
and if exposure comes back it reopens it.

## What the issue looks like

A table, nearest deadline first:

```
| Model                | Provider | Retires    | Countdown        | In code        | Fix            |
| gpt-4-vision-preview | openai   | 2024-12-06 | retired 625d ago | 1× (data only) | —              |
| gpt-4-0613           | openai   | 2026-10-23 | 61d left         | 2× (2 live)    | auto-fix ready |
```

"auto-fix ready" means `mendr fix-llm` can already produce a verified diff for
that one. "data only" means the id appears in your code but not in a live model
call, so it is a heads up, not something to fix.

## What it does not do

- Countdowns are day level, not exact time. GitHub schedules drift.
- It reads TypeScript, TSX, and Python. A JavaScript-only repo scans clean
  because it is not covered, not because it is safe. The clean message says which
  languages and providers were checked so you can tell the difference.
- It never changes your code, opens a pull request, or pushes a commit. It only
  maintains the one issue. It asks for issues:write and contents:read and nothing
  else.

## What we want to know

The point of Watch is that it stays useful between retirement events without you
thinking about it. So the thing we care about is not whether it runs once. It is
whether you install the resident issue and keep it. Tell us:

- Did you install the Watch issue, or just run the command once?
- If you installed it, did you keep it open, or close it?
- Did the countdown or the "auto-fix ready" line make you do anything?

That is the signal that decides what we build next.

## If something breaks

- Run it from the root of a real project. Running it in an empty or system
  directory prints a "scanned 0 source files" hint.
- The countdown value comes from Mendr's registry of provider retirement dates,
  not from your provider account.
- `npx github:ajitheee/mendr fix-llm .` shows the proposed fixes for
  anything marked "auto-fix ready".
