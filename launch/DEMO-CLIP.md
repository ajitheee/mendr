# Demo clip — recording script

A 30–45 second raw take of one `mendr audit` run, showing six things. Every line quoted below is
real output from the shipped `v0.5.4-alpha` build, captured on 2026-09-22 — not a mock-up. If your
screen says something different, the take is wrong and the checklist at the bottom will catch it.

The run itself takes **7 seconds** warm. Everything else is reading time, so the clip is paced by
you, not by the tool.

## The six beats, and the exact text to look for

| # | beat | the line on screen |
|---|---|---|
| 1 | the command starting | `mendr audit (preview)` |
| 2 | source + configuration coverage | `✓ Source code:  2 files scanned (1 TS/TSX, 1 Python)` and `✓ Configuration:  3 files scanned` |
| 3 | the result | `Conclusion: EXPOSURE DETECTED` |
| 4 | one review-required finding | `Decision: REVIEW REQUIRED` |
| 5 | the honesty line | `Production usage was not measured.` |
| 6 | nothing was touched | `No changes were applied.` |

Beats 5 and 6 sit together directly under the conclusion, and beat 6 is repeated in the closing
paragraph — so you get it twice in one take.

## Before you record — about five minutes

### 1. Build the prop repository

A small, believable service: one TypeScript call site, one config file, one Python file with
nothing wrong in it, and a lockfile. Paste this into PowerShell once. It writes to
`~\demo\support-bot`, well outside the mendr repo.

```powershell
$root = "$HOME\demo\support-bot"
# Windows PowerShell 5.1 writes a UTF-8 BOM with Set-Content, and a BOM in
# package-lock.json makes mendr report it unreadable. .NET writes none.
function Write-Prop($Path, $Text) { [System.IO.File]::WriteAllText($Path, $Text) }
New-Item -ItemType Directory -Force -Path "$root\src", "$root\config" | Out-Null
Write-Prop "$root\package.json" @'
{
  "name": "support-bot",
  "version": "1.2.0",
  "private": true,
  "dependencies": { "openai": "^4.104.0" }
}
'@
Write-Prop "$root\package-lock.json" @'
{
  "name": "support-bot",
  "version": "1.2.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "support-bot", "version": "1.2.0", "dependencies": { "openai": "^4.104.0" } },
    "node_modules/openai": {
      "version": "4.104.0",
      "resolved": "https://registry.npmjs.org/openai/-/openai-4.104.0.tgz",
      "integrity": "sha512-demo"
    }
  }
}
'@
Write-Prop "$root\config\app.yaml" @'
service: support-bot
llm:
  model: gpt-4
  temperature: 0.2
  timeout_ms: 30000
'@
Write-Prop "$root\src\assistant.ts" @'
import type OpenAI from "openai";

// The client is injected by the request handler, so the call site alone
// cannot prove which provider account it belongs to.
export async function summarizeTicket({ openai, ticket }: { openai: OpenAI; ticket: string }) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: "user", content: ticket }],
  });
  return completion.choices[0].message.content;
}
'@
Write-Prop "$root\src\retention.py" @'
import os

# Ticket retention window, in days.
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "90"))
'@
Write-Host "prop repo ready at $root"
```

Why this shape: the client arrives as a destructured parameter, so mendr **cannot** prove the call
is live — which is exactly what earns `REVIEW REQUIRED` instead of an auto-patch. That is the
honest half of the product and the half worth filming.

### 2. Terminal

- **Windows Terminal**, not the old console host. Mendr renders `✓` and `○` only where it knows the
  terminal is UTF-8 (Windows Terminal or VS Code); anywhere else it falls back to `[x]` and `[ ]`,
  which still reads correctly but looks worse on camera.
- **Width 120 columns.** Narrower wraps the `Reason:` line into a paragraph.
- Dark theme, font 16–18pt. Turn off notifications and hide anything with your name or a client's
  name in the path — the prompt will be on screen the whole time.
- `cd ~\demo\support-bot` **before** you record, so the first frame is a clean prompt.

### 3. What to record with

**Xbox Game Bar**, which is already installed. `Win` + `G` opens it, `Win` + `Alt` + `R` starts and
stops recording, and the file lands in `~VideosCaptures` as MP4. It records **the focused
window only**, which is what you want: no desktop, no taskbar, no second monitor, nothing to crop.

Two settings to check once, in Game Bar → Settings → Capturing:

- **Microphone off.** It defaults to off, but a hot mic on a silent screencast is the most common
  way a take is wasted.
- **60fps** if it is offered. Text scrolling at 30fps smears; at 60 it stays readable.

Then turn on **Do Not Disturb** (`Win` + `N` → toggle). A Teams popup across the conclusion line
means re-recording the whole thing.

If you want more control later, ShareX or OBS both do region capture and better encoding. Neither
is worth installing for a 45-second clip.

### 4. Window size, and why it decides your aspect ratio

The terminal window IS the video frame, so its shape is the clip’s shape. At 120 columns:

| rows | roughly | fits the whole report? | good for |
|---|---|---|---|
| 36 | 3:2 landscape | no — scroll (Option B) | X, LinkedIn, anywhere |
| 45 | 7:6, nearly square | no — scroll (Option B) | square social posts |
| 60 | portrait | yes — no scrolling (Option A) | a doc or a wide monitor, not social |

**Use 120 × 36 unless you have a reason not to.** It is landscape, the font can stay large, and
the scroll in Option B is three keypresses. A 60-row window fits everything at once but produces a
portrait video that needs letterboxing before anyone can post it.

Set it in Windows Terminal → Settings → Startup → Launch size, or in `settings.json`:

```json
"initialCols": 120,
"initialRows": 36
```

Confirm it took, in the terminal you are about to record:

```powershell
$Host.UI.RawUI.WindowSize
```

### 5. Warm the cache — this is the step people skip

The first `npx` of a git ref downloads and builds: about a minute, with install noise. The second
is 7 seconds and silent. Run it once, then clear:

```powershell
npx github:ajitheee/mendr#v0.5.4-alpha audit .
clear
```

Check that warm-up run says `Registry: … bundled <today> (fresh, 0 d)`. If it says `stale`, stop —
a stale registry changes the conclusion, and the clip would be showing a different product.

## The take

Type this, exactly — it is the command from the README, so anyone who pauses the video can run it:

```
npx github:ajitheee/mendr#v0.5.4-alpha audit .
```

The report is 57 rows at 120 columns and all six beats land in the first 40, so pick by how tall
your terminal is:

**Option A — everything on one screen (needs ~60 rows).** Best on a 1440p display. Type, run,
hold still for 25 seconds. No scrolling, no mouse.

| time | what happens |
|---|---|
| 0:00–0:04 | empty prompt; type the command at a natural pace |
| 0:04–0:11 | Enter. Seven seconds of nothing — let it sit, do not touch anything |
| 0:11–0:20 | the report prints; hold on the coverage block (beats 1, 2) |
| 0:20–0:30 | hold on `Conclusion: EXPOSURE DETECTED` and the two lines under it (beats 3, 5, 6) |
| 0:30–0:42 | hold on the finding block ending in `Decision: REVIEW REQUIRED` (beat 4) |
| 0:42–0:45 | stop recording on a still frame, not mid-scroll |

**Option B — bigger font, one slow scroll (recommended for anything that will be watched on a
phone).** Same start; after the report prints, the screen sits at the bottom.

| time | what happens |
|---|---|
| 0:00–0:11 | type, Enter, seven-second wait |
| 0:11–0:14 | report prints; screen is at the bottom of it |
| 0:14–0:17 | jump to the **top**: **Ctrl+Shift+Home** (plain Ctrl+Home does nothing here) |
| 0:17–0:26 | hold: `mendr audit (preview)` and the coverage block (beats 1, 2) |
| 0:26–0:34 | scroll down with **Ctrl+Shift+Down** — one line per press, no mouse — to `Conclusion: EXPOSURE DETECTED`; hold (beats 3, 5, 6) |
| 0:34–0:44 | keep pressing Ctrl+Shift+Down to `Decision: REVIEW REQUIRED`; hold (beat 4) |
| 0:44–0:45 | stop on a still frame |

Keyboard scrolling beats the mouse wheel here: one line per press, evenly paced, with a beat of
stillness between presses. A wheel spin turns into unreadable smear at 30fps and cannot be fixed
in the edit.

## Before you send it to me — check the take

Play it back and confirm all six strings are legible at full size:

- [ ] `mendr audit (preview)`
- [ ] `Source code:` … `2 files scanned` **and** `Configuration:` … `3 files scanned`
- [ ] `Conclusion: EXPOSURE DETECTED`
- [ ] `Decision: REVIEW REQUIRED`
- [ ] `Production usage was not measured.`
- [ ] `No changes were applied.`

Then the things that ruin an otherwise good take:

- [ ] No npm install noise anywhere (means the warm-up didn't take — run it again and re-record)
- [ ] `Registry: … (fresh, 0 d)`, not `stale`
- [ ] `✓` and `○`, not `[x]` and `[ ]` (wrong terminal)
- [ ] No personal or client paths in the prompt, no notification popups
- [ ] The last frame is still, not mid-scroll

## What you will actually see

```
mendr audit (preview)

Audit coverage

✓ Source code:       2 files scanned (1 TS/TSX, 1 Python)

  Files accounted for
       2  discovered
       2  analyzed (TS/TSX, JavaScript, Python)
✓ Configuration:     3 files scanned
✓ Provider SDKs:     1 declared by the root project in package-lock.json — information only, never part of the conclusion
    · openai 4.104.0 — 3 newer major lines seen: 5 (2024-12-20), 6 (2025-09-30), 7 (2026-07-27) …
✓ Registry:          anthropic, google, openai · bundled 2026-09-22 (fresh, 0 d)
○ Runtime usage:     not measured — no runtime source connected (optional)
○ Reader tie-back:   not proven — a config location is a candidate; mendr has not shown that runtime reads it

Conclusion: EXPOSURE DETECTED

We found one retiring AI dependency.

One is a code default or call that could not be traced to a provider request — review before changing.

Production usage was not measured.
No changes were applied.

1 deprecated model ids: 0 patch-eligible (no change applied), 1 need human review, 0 informational

Deprecated model dependency located

Model: gpt-4  (openai)
Location: src/assistant.ts:7 — code default or call not traced to a provider request (review)
          config/app.yaml:3 — config runtime selector candidate
Retirement: deprecated — 31d left (2026-10-23)  [source: https://developers.openai.com/api/docs/deprecations]
Migration evidence: gpt-5.6-sol [registry: verified] (evidence only — not applied here)
Production usage: not measured
Reader tie-back: not proven
Decision: REVIEW REQUIRED
Status: No change applied
Next action: Human review before any change
Reason: Located at a code default or call not traced to a provider request (its use as a live call is not
proven) and a config selector candidate (reader tie-back not proven). Production usage was not measured.
Human review required before any change.
```

**One line reads wrong on the published tag, and it is the line under the conclusion.** `v0.5.4-alpha` prints `1 deprecated model ids: ... 1 need human review` — singular count, plural noun. It is fixed on `main` (`1 deprecated model id: ... 1 needs human review`) but a tag is immutable, so it will be on camera unless you record after the next release. Your call: it is a small blemish on an otherwise clean report, and the six beats are unaffected.

The day count on the `Retirement:` line moves with the calendar — `31d left` on 2026-09-22, `0d` on
2026-10-23. Everything else is stable.

## Two things to know before this goes anywhere public

**The command in the clip only works because the package is not on npm yet.** `npx
github:ajitheee/mendr#v0.5.4-alpha` is the real install path today and it works for anyone
watching. `npx mendr audit .` would be shorter and better, and it will be a lie until
`npm publish` runs. Do not film the shorter one first.

**The prop is a prop.** It is a repository built to have a finding, and it should be described that
way — "here is what a run looks like", never "here is a customer". A real scan of a real repository
is a different and better clip, and it needs a real repository first.
