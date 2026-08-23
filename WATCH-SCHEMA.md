# Mendr Watch — what it is, and the JSON schema

Mendr Watch continuously rescans your repository inside your own GitHub Actions
environment and maintains one issue containing the current deprecation exposure.
It stores no customer repository state on Mendr infrastructure, never modifies the
default branch, and cannot bypass Mendr's deterministic safety gate.

## How that is guaranteed

- **Runs in your CI, not ours.** The generated workflow runs `mendr watch` on the
  GitHub-hosted runner in your repository. No code, no scan result, and no repo
  state is sent to Mendr.
- **Least privilege.** The workflow asks for `issues: write` and `contents: read`
  and nothing else. It opens no pull request, pushes no commit, and never writes
  to the default branch. It only creates and edits one issue.
- **Pinned, immutable.** The workflow is pinned to an immutable Mendr release tag
  (overridable to any tag or full commit SHA via the `MENDR_SPEC` repository
  variable), so a future upstream change can never execute in your CI without you
  choosing it.
- **Same safety gate as `fix-llm`.** Every occurrence is classified into the same
  A/B/C tier by the same deterministic classifier the fix path uses. Watch reports
  exposure; it never applies a change.

## `mendr watch --json`

```jsonc
{
  "schema": "mendr-exposure/v2",       // output/version tag
  "registryVersion": "sha256:<16 hex>",// content hash of the registry scanned against
  "scannedCommit": "<sha>|null",       // repo HEAD at scan time (null outside a git repo)
  "hasExposure": true,                 // models.length > 0

  "modelCount": 2,                     // number of distinct deprecated model ids

  // TWO VIEWS OF THE SAME SCAN — do not conflate them.
  // occurrence-level: every matched literal, by tier.
  "occurrenceCounts": { "tierA": 1, "tierB": 2, "tierC": 67 },
  // model-level: each id bucketed by the action it needs (what the badge counts).
  "modelCounts": { "reviewRequired": 2, "autoFixable": 0, "informational": 14 },

  // TWO UNAMBIGUOUS DEADLINE FIELDS (no single "nearest" that could mean overdue).
  "nearestUpcomingDeadlineDays": 36,   // soonest FUTURE retirement in days, or null
  "mostOverdueDays": 772,              // largest PAST overdue in days (positive), or null

  "filesScanned": 253,                 // TS + Python source files walked
  "filesMatched": 9,                   // of those, files that contained a registry token

  "models": [ /* ExposedModel[] — see below */ ],
  "badge": "![mendr watch](https://img.shields.io/badge/…)"
}
```

### `ExposedModel`

```jsonc
{
  "id": "gpt-4",                       // the deprecated model id in your code
  "provider": "openai",
  "entryId": "openai.gpt-4.retirement-2026-10-23", // stable registry id (mendr evidence <id>)
  "status": "deprecated|retired|null", // source-id lifecycle per provider docs
  "shutdownDate": "2026-10-23|null",   // ISO date calls stop working, when published

  "replacement": "gpt-5.6-sol",        // the id the registry migrates to
  "replacementVerdict": "quarantined", // registry verdict for the replacement mapping
                                       //   (verified|quarantined|unverified|unverifiable|unstamped|withheld)
  "autoApplyAllowed": false,           // whether the engine may auto-apply this swap

  "sourceUrl": "https://…|null",       // provider doc the retirement was read from

  "occurrences": 2,                    // total matched occurrences of this id
  "tierCounts": { "A": 0, "B": 1, "C": 1 },
  "highestTier": "B",                  // most severe tier present — ORDERING ONLY
  "disposition": "review_required",    // the field to BRANCH ON (see below)

  "locations": [                       // sorted, capped sample (see MAX_LOCATIONS_PER_MODEL)
    { "file": "agent_app/simulator.py", "line": 166, "column": 13,
      "tier": "B", "reason": "usage_unverified", "usageVerdict": "unverified" },
    { "file": "agent_app/simulator.py", "line": 12, "column": 5,
      "tier": "C", "reason": null, "usageVerdict": "n/a" }
  ]
}
```

### `disposition` — the model-level action (branch on this, not `highestTier`)

| value | meaning |
| --- | --- |
| `auto_fixable` | Tier A only — a verified swap exists |
| `review_required` | Tier B present, no Tier A |
| `mixed_review_required` | both Tier A and Tier B — a swap AND something to review |
| `informational` | Tier C only — data references, nothing to do |

`highestTier` exists only to order the list (A before B before C). A model with
both a Tier A and a Tier B occurrence has `highestTier: "A"` but
`disposition: "mixed_review_required"` — it still needs review. **Never decide
model-level action from `highestTier`.**

### `tier` / `reason` / `usageVerdict` per occurrence

- `tier`: `"A"` (auto-fixable) · `"B"` (review) · `"C"` (data). Same tiers as
  `fix-llm`.
- `reason` (Tier B only): `usage_unverified` · `replacement_unverified` ·
  `platform_blocked` · `type_cast_masked`. `null` for A and C.
- `usageVerdict`: `"confirmed"` (a live model argument) · `"unverified"` (not tied
  to a live call) · `"n/a"` (a data position).

## The committed record: `.mendr/exposure.json`

Schema `mendr-exposure/v2`: `{ "schema", "registryVersion", "models": [...] }`
with the same `ExposedModel` shape. It carries durable facts only (no timestamp,
no countdown, no scanned commit), so re-running on unchanged code against the same
registry is byte-identical — no per-scan churn. The engine regenerates exposure
from source on every run and never trusts a committed `exposure.json` as input.

## Stability

The schema tag (`mendr-exposure/v2`) changes only on a breaking shape change.
Fields may be added within a version; consumers should ignore unknown fields.
