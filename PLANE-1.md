# Plane 1 — change intelligence: where it stands, 2026-09-28

The v2 architecture has four planes. Plane 1 turns what providers publish into checkable
facts about what is changing. It was built in narrow slices. This page records where every
node lives, the one node that was evaluated and deliberately not built (with the evidence
that decided it), and what is still open. Every claim below went through two independent
checks against the repo and the live sources, and both rounds of corrections are applied.

## The nodes

| Node in the v2 diagram | State | Where |
| --- | --- | --- |
| Provider catalogs, changelogs, status | Catalogs: built, slice 1 (`c3539e9`). They are compiled from two third-party aggregators, OpenRouter's model list and models.dev, and filtered to first-party anthropic, google and openai ids; no provider's own catalog is read. Changelogs: **deprecation pages only**, built before v2 (`3caa5cb`); providers' general changelogs and release notes are not collected. Status: **evaluated, not built** (below). | `src/registry/catalog.ts` → `registries/model-catalog.json`; `src/registry/discover.ts` |
| Collectors | Built and, since 2026-09-28, actually scheduled. `discover.ts` runs monthly (`registry-discover.yml`); its one scheduled attempt failed on a repository setting that has since been turned on, and the next fire is 2026-10-01 (open item 2). `catalog.ts` and `sdkReleases.ts` ran **only by hand** until `registry-refresh.yml` put them on a weekly cron (open item 4). A failure in either is now raised as an issue rather than passing unnoticed (open item 6). | `discover.ts`, `catalog.ts`, `sdkReleases.ts` |
| Immutable source evidence | Built for deprecation pages: hashed and snapshotted. The catalog and SDK record carry a sha256 of each source's response but **no stored copy**, so the hash can show only that a source changed, not what it said. | `evidence.ts`, `registries/evidence/` |
| Normalizer and change classifier | Normalizer: built. Classifier: **partial**. `discover.ts` labels a row retired (shutdown date on or before the run date) or deprecated (a later date) when it can read a shutdown date, and leaves the status unset when it cannot. `verify.ts` grades whether a replacement is safe to auto-apply. `claimCheck.ts` gates whether a deprecation claim is quote-backed. Nothing classifies an SDK release as breaking: slice 2 defers that to a human reading changelogs, a curation step that does not exist yet. | `normalize.ts`, `discover.ts`, `verify.ts`, `claimCheck.ts` |
| Contract and change graph | Built, slices 3 (`911f62b`) and 4 (`ae3bdc4`) | `src/registry/graph.ts`, shown by `mendr resolve` |
| Signed metadata feed | Deprecation registry: signed, published to `registry-latest`, and verified by the scanner before use when refresh is on (re-checked after open item 1 was resolved: the refresh grades it `fresh`). Catalog and SDK record: signed with detached `.sig` files and published to `registry-latest` since 2026-09-18. Nothing verifies them on read because **nothing fetches them** — the scanner's only remote assets are the registry, its manifest and its signature; the catalog and SDK record are read from the bundled copies (open item 3). | `manifest.ts`, `scripts/publish-registry.mjs`, `.github/workflows/registry-publish.yml` |
| OpenAPI, GraphQL, protobuf, SDK releases | SDK releases: built, slice 2 (`928326f`). OpenAPI: a pre-v2 differ exists (`src/detect/diffSpec.ts`, behind `mendr check` and `mendr fix`) that compares two local Stripe spec files, but no Plane 1 collector fetches provider specs. GraphQL, protobuf: not built. | `src/registry/sdkReleases.ts` → `registries/sdk-releases.json` |
| Kubernetes, database, infrastructure contracts | Not built | — |

Kubernetes, database and infrastructure contracts are on the do-not-build lists:
"infrastructure contracts" in the 2026-09-15 build order, and "Kubernetes or database
support" in the freeze. OpenAPI, GraphQL and protobuf are not named on either list. They are
left alone for two reasons. GraphQL and protobuf would be additional API change types, which
the freeze names. And acting on more of what the existing OpenAPI differ already detects
runs into the build order's `typeChange.ts`/`enumValue.ts` fix stubs and Stripe seam
cleanup.

## Status: evaluated, not built

"Status" in the diagram most plausibly means provider status pages. They were checked on
2026-09-17, before deciding, to see whether they carry change intelligence.

| Provider | Machine-readable source | Window | Items | Name a known id exactly | Name a model by display name | Announce a deprecation or retirement |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `status.anthropic.com/api/v2/incidents.json` | 2026-07-22 → 2026-09-16 | 50 | 0 | 24 (e.g. "Claude Sonnet 5", "Claude Opus 4.8") | 0 |
| OpenAI | `status.openai.com/feed.rss` | 2026-06-23 → 2026-09-17 | 89 | 2 (`gpt-4o-mini`, `gpt-image-2`) | 7, six of them also or only wrong ids (below) | 0 |
| Google | `status.cloud.google.com/incidents.json` | the feed's current contents | 6 | 1 (a Vertex Gemini API incident listing seven Gemini ids, five of them exactly) | 1 | 0 |

- **Known id** means one of the 285 model ids in `registries/llm-deprecations.json` (a
  `model_id` entry's deprecated or replacement id) or `registries/model-catalog.json`.
  "Exactly" means a whole-token, case-sensitive match. "By display name" means lowercasing
  the text and joining words with hyphens, so "Claude Sonnet 5" becomes `claude-sonnet-5`,
  then looking for the id anywhere in it.
- **Announce** means a lifecycle word (`/deprecat|retir|sunset|end of life|shut ?down/i`)
  used about a model. Two items had raw hits (62 regex matches in all, mostly repeated
  across updates). Both were Google Cloud incidents and all the hits were physical: a
  cooling failure in which a chiller shut down and servers were then shut down to protect
  them, and a data-center fire that forced an emergency power shutdown. None was an
  announcement.

Four findings decided it:

1. **Status pages are outage feeds, not change feeds.** Not one of the 145 items announced a
   retirement. The thing Mendr exists to catch did not appear in any of them.
2. **They name models, but never reliably.** Anthropic names a model in about half its
   incidents, always by display name and never by API id. Google writes
   `gemini-3.0-flash-preview` and `gemini-3.0-pro-preview` where the ids are
   `gemini-3-flash-preview` and `gemini-3-pro-preview`. On OpenAI's feed a case-insensitive
   exact match links "GPT-5.6 Sol" to the wrong id, `gpt-5.6`. The display-name match links
   "gpt-image-2.5-flare" only to the wrong id `gpt-image-2`, and five more items also pick up
   wrong shorter ids (`gpt-5`, `gpt-4`, `gpt-4o`, `gpt-4.1`, `gpt-5.1`). Either way, a link
   would often be a confident, incorrect statement.
3. **Status cannot join the signed feed.** It changes by the minute. The signed feed is
   republished after the weekly verify run, on release tags, when the deprecation registry
   changes, and by hand, and a scanner treats it as fresh for 14 days. A status snapshot
   inside it would be days old before anyone read it.
4. **Coverage is partial where it exists.** OpenAI's standard `summary.json` lists 25
   components while its own page API lists 34. The Gemini developer API status page
   (`aistudio.google.com/status`) is a JavaScript page with no feed.

If "status" means a model's lifecycle status, that is already built: every one of the
registry's 154 `model_id` entries carries one (116 `retired`, 38 `deprecated`).

**Where it belongs if it comes back:** not in Plane 1. It belongs where Mendr runs something
against a provider and has to tell a provider incident from a broken migration. That is
verification in Plane 2, or production assurance in Plane 4.

**Revisit when** a provider starts announcing retirements on its status page, or a
customer's verification fails during a provider incident.

## Open items

1. **Resolved 2026-09-17: the repository had gone private.** Between 17:05 and 20:22 UTC
   `ajitheee/mendr` became private. The signed feed returned HTTP 404 to the scanner, which
   fell back to its bundled registry. Other repositories could not call Mendr's reusable
   workflows, and `mendr-demo` failed with "a workflow file issue". The repository was made
   public again the same day. After that, the feed, the pinned reusable workflow and the
   source tarball all returned 200 without credentials, the scanner's refresh graded the
   feed `fresh`, and `mendr-demo`'s audit and migrate jobs passed. **The install path
   depends on the repository staying public.**
2. **Resolved 2026-09-18, verified 2026-09-28: scheduled discovery can complete.** Its only
   scheduled run (2026-09-01) wrote 100 candidates and 3 snapshots, then failed at the
   pull-request step with *"GitHub Actions is not permitted to create or approve pull
   requests."* The setting was turned on 2026-09-18 — **after** that run, which is why the
   failure looked permanent. Confirmed on today:
   `repos/ajitheee/mendr/actions/permissions/workflow` reports
   `can_approve_pull_request_reviews: true`, and the manual dispatch that same day opened
   PR #7 with 54 candidates.

   **Still unproven on a schedule**, because 2026-09-01 was the only scheduled fire and the
   next is 2026-10-01 07:00 UTC. The cron is monthly, so this row cannot be closed before
   then — but a failure is no longer silent (item 6).
3. **Closed as "working as intended" 2026-09-28. The earlier wording overstated the risk.**
   `registry-latest` holds all seven files since the merge of #8 on 2026-09-18 22:42 UTC:
   the registry with its manifest and signature, plus `model-catalog.json`,
   `sdk-releases.json` and their `.sig` files.

   The previous text — *"published but nothing verifies them"* — reads as a live trust hole
   in the scanner. It is not one, and the difference matters. **Nothing fetches them
   either.** `src/registry/freshRegistry.ts:38-40` declares exactly three remote assets —
   `manifest.json`, `manifest.sig`, `llm-deprecations.json` — and there is no other network
   read of a registry file anywhere in `src/`. The catalog and the SDK record are only ever
   read from the bundled copies on disk (`src/cli.ts:2119`, `:3872`, plain `readFileSync`),
   whose integrity comes from the signed artifact that carries them.

   So the `.sig` files serve **external consumers of the feed**, not this scanner. There is
   nothing to verify on read because there is no read over the wire.

   **Decision, 2026-09-28: do not add remote refresh for these two.** It would put a network
   dependency on every scan to solve a problem the bundled artifact already solves, and the
   weekly refresh in item 4 keeps the bundled copies current without it. Revisit only if a
   consumer needs the catalog fresher than the release cadence.
4. **Half resolved 2026-09-28: they are refreshed now, but the catalog still has no age
   check.** `mendr catalog` and `mendr sdk-releases` had been CLI commands since slices 1
   and 2 (`src/cli.ts:2236`, `:2201`) that **no workflow ever invoked**, so both files sat
   frozen at 2026-09-17 while the deprecation registry moved weekly.

   `.github/workflows/registry-refresh.yml` (PR #22) now reruns both every Monday 06:00 UTC
   and opens one PR. Its first run found eleven days of drift: **+8 model ids, −2, and 5 SDK
   bumps** (PR #23), including `gpt-6-sol`, `gpt-6-luna` and `openai` 3.15.0 → 3.19.2. The
   catalog went 152 → 158 ids. It refuses to open a PR when only `fetchedAt` moved, which was
   exercised the same day.

   **Still open:** the catalog has **no age check**. `mendr resolve` says "a public catalog
   lists it" from a catalog of any age, and the weekly job makes that less likely rather than
   impossible — a run that fails for a month leaves the staleness silent to the reader even
   though item 6 makes it loud to us. The SDK record does degrade honestly: it passes 14 days
   on 2026-10-02 and `mendr resolve` then reports `sdk_unchecked` rather than "newest major".
5. **General changelogs and release notes are not collected.** Only deprecation pages are.
6. **Closed 2026-09-28: a failing collector is no longer silent.** The 2026-09-01 discovery
   failure in item 2 went unnoticed for **27 days**, and was found only because someone read
   this file and went looking. Before PR #24, **zero of eight workflows reported their own
   failure** — a monthly job that dies quietly is worse than no job, because you go on
   believing you have change intelligence.

   Both registry workflows now keep ONE issue, found by the marker
   `<!-- mendr-registry-health:v1 -->`, edited in place, reopened when it breaks again and
   closed by the next successful run. The body states the consequence rather than the event:
   while it is open, treat the catalog, the SDK record and the candidate queue as stale by an
   unknown amount.

   The failure path was **exercised on purpose** before being trusted —
   `registry-refresh` takes a `simulate_failure` dispatch input. Issue #25 was raised by a
   deliberately failed run and closed by the next good one, with `raise the alarm` and
   `stand down` firing on exactly inverted conditions. An alarm nobody has heard ring is not
   an alarm; this repository has shipped two paths that passed their tests and had never once
   executed, and that is not a third.
