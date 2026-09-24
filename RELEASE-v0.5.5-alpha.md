# v0.5.5-alpha

Three fixes, all found by **using** the shipped build rather than by testing it — one while hunting
a pull request worth opening, two while filming a demo of the tool on Windows. Every one of them
made mendr describe work it had not done.

No new features. The registry is unchanged.

## The gate failure that never happened

`fix-llm https://github.com/getmaxun/maxun` printed this, and it is wrong twice:

```
Found: 1 tier A (safe automatic patch), ...
Tier A: nothing auto-fixable.
Summary: tier A 1 (0 auto-fixed, 1 downgraded -- gates failed, not applied)
```

maxun's root `tsconfig.json` declares `include: ["src", "vite-env.d.ts"]`; its retiring model id
lives in `server/src/`. The scan walks the whole repository and finds it. The **gated** pass
re-loads through that tsconfig, so the project held no such file, the codemod changed nothing — and
the summary's residual bucket announced a gate failure for a gate that had never run on it.

That was the **only confirmed auto-fixable finding across 40 scanned repositories**, and it was
reported to its own operator as a rejection.

Fixed on both sides, because either alone leaves the hole open:

- **The load.** The located files are unioned into both gated projects. Sound precisely because the
  type-check is baseline-relative: a file the build never included brings the same pre-existing
  diagnostics to the baseline and the patched load, so they cancel and only a *new* error can fail.
- **The report.** `downgraded` stopped being a blind residual that printed "gates failed" for
  anything it could not explain. It now splits into `not gated` (the file could not be loaded, so no
  gate ran) and `not applied -- the codemod produced no change` (an unattributable remainder, which
  is mendr's defect to chase rather than the customer's diff to debug). **"Gates failed" now
  requires a gate to have actually blocked.**

## The type-check that could not see the SDK

`fix-llm <url>` shallow-clones and installs nothing, so the SDK whose types would reject a bad model
id is unresolved and the argument it guards is `any`. The gate passed because **nothing could fail
it**, and printed one word. On `swan-io/swan-partner-frontend` that was 69 unresolved packages
behind `passed`.

The gate now names what it could not see — in the gate row, in the one-line Tier A verdict that
gets skimmed and quoted, and in the pull-request body that reaches a stranger:

```
type-check: passed (no new errors; 1383 pre-existing ignored; 32 packages not installed
            in this checkout (@anthropic-ai/sdk, @mui/icons-material, @mui/lab, +29 more)
            -- their types were not checked)  [required]
```

**Deliberately not failed closed.** A swap that a literal-union type would reject is catchable only
when that package resolves; the crash this was found next to is a *runtime* validation error that
full type coverage would not have caught either; and refusing the stamp would downgrade every
fixture in mendr's own suite while preventing none of that class. Scoping the claim is the fix.

## A byte-order mark is not malformed content

Windows PowerShell 5.1 writes a UTF-8 BOM into every file `Set-Content` creates. RFC 8259 forbids
*emitting* one in JSON and explicitly allows a parser to ignore it; `JSON.parse` does not. So a file
npm reads happily was reported to its owner as unreadable — on Windows only.

Two readers were affected, and the second matters much more:

- `package-lock.json` → "not valid JSON", printing the provider SDK row as a red failure.
- **Any `.json` config → `malformed_json`, and the fail-closed rule then turns a CLEAN repository
  `inconclusive`.** That is the same failure shape as the zero-byte-output bug fixed in
  0.5.3-alpha — a run *with* findings concludes `exposure_detected` regardless, so it could only
  ever strike a repository that was clean — reached through a different door, and only for Windows
  users. It would have stayed invisible: every fixture in this suite is written by Node, which emits
  no BOM.

Both now strip a leading BOM before parsing. Genuinely malformed content still fails closed, BOM or
not, and that is tested. The Python readers already stripped it.

## The count line reads correctly at one finding

`1 deprecated model ids: 0 patch-eligible (no change applied), 1 need human review, 0 informational`
— singular count, plural noun, and a verb that did not agree either.

It sits directly under the conclusion, so it is the first line a reader parses after
`EXPOSURE DETECTED`, and the single-finding case is the common one: most repositories that are
exposed at all are exposed once. Every real report ever shown to anyone outside this project
carried it. Found by filming it.

## Registry

**Unchanged**: 161 entries, `sha256:e5f920c0fe57840f`. The bundled stamp was deliberately **not**
regenerated — the rollback floor already sits below the published snapshot, and re-stamping would
raise it above, making every install treat the live registry as a rollback until the next publish
completed. Same reasoning as 0.5.3-alpha.

## Upgrading

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@v0.5.5-alpha
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@v0.5.5-alpha
```

A repository already connected moves by setting the repository variable `MENDR_SPEC` to
`v0.5.5-alpha` (or to a full commit SHA, which is the only truly immutable pin) — no workflow edit.
