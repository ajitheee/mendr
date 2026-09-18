# Plane 1 — change intelligence: where it stands, 2026-09-17

The v2 architecture has four planes. Plane 1 turns what providers publish into checkable
facts about what is changing. It was built in narrow slices. This page records where every
node lives, the one node that was evaluated and deliberately not built (with the evidence
that decided it), and what is still open. Every claim below went through two independent
checks against the repo and the live sources, and both rounds of corrections are applied.

## The nodes

| Node in the v2 diagram | State | Where |
| --- | --- | --- |
| Provider catalogs, changelogs, status | Catalogs: built, slice 1 (`c3539e9`). They are compiled from two third-party aggregators, OpenRouter's model list and models.dev, and filtered to first-party anthropic, google and openai ids; no provider's own catalog is read. Changelogs: **deprecation pages only**, built before v2 (`3caa5cb`); providers' general changelogs and release notes are not collected. Status: **evaluated, not built** (below). | `src/registry/catalog.ts` → `registries/model-catalog.json`; `src/registry/discover.ts` |
| Collectors | Built. `discover.ts` is scheduled monthly (`registry-discover.yml`), but it has **never completed a scheduled run** (open item 2). `catalog.ts` and `sdkReleases.ts` run **only by hand**; nothing refreshes their output (open item 4). | `discover.ts`, `catalog.ts`, `sdkReleases.ts` |
| Immutable source evidence | Built for deprecation pages: hashed and snapshotted. The catalog and SDK record carry a sha256 of each source's response but **no stored copy**, so the hash can show only that a source changed, not what it said. | `evidence.ts`, `registries/evidence/` |
| Normalizer and change classifier | Normalizer: built. Classifier: **partial**. `discover.ts` labels a row retired (shutdown date on or before the run date) or deprecated (a later date) when it can read a shutdown date, and leaves the status unset when it cannot. `verify.ts` grades whether a replacement is safe to auto-apply. `claimCheck.ts` gates whether a deprecation claim is quote-backed. Nothing classifies an SDK release as breaking: slice 2 defers that to a human reading changelogs, a curation step that does not exist yet. | `normalize.ts`, `discover.ts`, `verify.ts`, `claimCheck.ts` |
| Contract and change graph | Built, slices 3 (`911f62b`) and 4 (`ae3bdc4`) | `src/registry/graph.ts`, shown by `mendr resolve` |
| Signed metadata feed | Deprecation registry: signed, published to `registry-latest`, and verified by the scanner before use when refresh is on. **But the repository is now private, so that fetch fails** and the scanner falls back to its bundled registry (open item 1). Catalog and SDK record: the publish script will sign each with a detached `.sig`, but it has not run since slices 1 and 2, so **neither is signed, published or verified yet** (open item 3). | `manifest.ts`, `scripts/publish-registry.mjs`, `.github/workflows/registry-publish.yml` |
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

1. **The repository is private, so the signed feed cannot be fetched.** `ajitheee/mendr` is
   private, and an unauthenticated request for `registry-latest/manifest.json` returns HTTP
   404. The scanner's refresh sends no credentials, so it falls back to the bundled
   registry. The same change stops other repositories calling Mendr's reusable workflows.
   `mendr-demo`'s scheduled runs have failed with "a workflow file issue" since 2026-09-17
   20:22 UTC, after a last success at 17:05 UTC.
2. **Scheduled discovery has never completed.** Its only scheduled run (2026-09-01) wrote 100
   candidates and 3 snapshots, then failed at the pull-request step. The repository does not
   let GitHub Actions create pull requests, and that setting is still off.
3. **The catalog and SDK record will be signed on the next publish, but are not yet signed or
   published, and nothing verifies them.** `registry-latest` still carries only
   `llm-deprecations.json`, `manifest.json` and `manifest.sig`, last published 2026-09-17
   05:34 UTC, before slices 1 and 2. The next scheduled publish follows the weekly verify
   run, and only if that run passes. The cron is Mondays 06:00 UTC, and GitHub has started it
   between 07:03 and 13:05 UTC. Any release tag pushed sooner also publishes. Every trigger
   checks out `main`, so it would pick both files up. They sit in `registries/`, which the
   npm package includes, so the next release will carry them; no release so far does. No
   Mendr code checks either `.sig`.
4. **The catalog and SDK record go stale, and only one of them says so.** No workflow reruns
   `mendr catalog` or `mendr sdk-releases`.
   - The SDK record passes 14 days on 2026-10-02. After that, `mendr resolve` reports
     `sdk_unchecked` instead of "newest major", which is honest.
   - The catalog has **no age check**. `mendr resolve` says "a public catalog lists it" from
     a catalog of any age.
5. **General changelogs and release notes are not collected.** Only deprecation pages are.
