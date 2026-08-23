# Mendr Watch, tester quickstart

Mendr Watch tells you which deprecated model ids your code uses and when each one
stops working, and it keeps a single GitHub issue up to date so you find out
before a model retires instead of after.

It runs inside your own GitHub Actions environment. It stores no repository state
on Mendr infrastructure, never modifies the default branch, and cannot bypass
Mendr's deterministic safety gate. Nothing here touches your default
`mendr fix-llm` install.

The commands below pin to the release `v0.1.0`, so you always get the same tested
version (and no stale npx cache).

## See your exposure (about 30 seconds, no setup)

Run this in any repo you want to check:

```bash
npx github:ajitheee/mendr#v0.1.0 watch .
```

You can also point it straight at a GitHub URL, which scans a read-only copy so
you do not have to clone it yourself:

```bash
npx github:ajitheee/mendr#v0.1.0 watch https://github.com/you/your-repo
```

It groups what it finds, highest risk first: models needing a look (Tier A or B)
under REVIEW REQUIRED, data-only mentions under INFORMATIONAL, each with exact
locations. If your repo is clean it says so and tells you exactly what it checked,
so a clean result is never mistaken for a blind spot.

## Make it resident (no setup)

This scaffolds a GitHub Action that keeps one self-updating issue current in your
repo. It runs in your own CI. There is no server, and none of your code leaves
your repo.

```bash
npx github:ajitheee/mendr#v0.1.0 watch --install
```

Then commit and push the workflow file. It is pinned to the Mendr release
`v0.1.0` out of the box — an immutable tag, never a branch — so there is nothing
else to configure. On the next run it opens one issue titled "Mendr Watch". After
that it edits that same issue in place. It never opens a second one and never
spams you. When your exposure clears it closes the issue, and if exposure comes
back it reopens it.

(Optional: to run a different Mendr version, set a `MENDR_SPEC` repository
variable — Settings, Secrets and variables, Actions, Variables — to a release tag
or a full commit SHA.)

## What the issue looks like

Grouped highest risk first, then nearest deadline. Each occurrence carries the
same A/B/C tier `mendr fix-llm` uses, so the two tools always agree:

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

REVIEW REQUIRED means at least one occurrence is a live call or a model-like
value worth a look (Tier A or B). INFORMATIONAL means the id only appears as data
(a config value, a comparison, a catalog key), so it is a heads up, not something
to fix. A Tier A occurrence is one `mendr fix-llm` can already produce a verified
diff for.

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
