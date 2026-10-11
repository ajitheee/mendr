# v0.5.10-alpha

**The release that checks a request in more of the ways its model id can be written.** In
v0.5.9-alpha, the check that holds a risky swap for review ran only when the model id was a string
literal written as the `model:` value of a TypeScript request. The same call was swapped unattended
in two cases:

- when the id came through a `const`, a `{ model }` shorthand, a cast or a fallback;
- in Python, where the check did not run at all.

Some of those swaps produce a request that the registry's own rules say the replacement rejects, or
reads differently.

This tag:

- runs the check on more of the TypeScript requests a model id reaches in the same file: through a
  `const`, a `{ model }` shorthand, a cast, a fallback, a function parameter or a constructor field
  (section 1);
- gives Python the same check, over fewer routes (section 2);
- finds OpenAI fine-tuned model ids in code and holds them for review (section 3);
- adds OpenAI's 2027 retirements and extends Anthropic's sampling rules to Sonnet 5.5 and the other
  models that reject them (section 4).

The deprecation registry moves from `sha256:9319f3c6ea52b69d` (197 entries) to
`sha256:e0464cc70ab44d9d` (223 entries). No automatic swap is added to or removed from the
registry: all 26 new records are review only. What is automatic still changes. The extended
Anthropic sampling rules add automatic parameter edits (section 4), and the code changes move some
swaps to review and add some parameter edits (section 5).

`audit` and `migrate` with registry refresh switched on already have the registry data:
`registry-publish` signed and published it when #57 merged on 2026-10-11. Audit workflows generated
since 2026-09-06 and migrate workflows generated since 2026-09-09 switch refresh on. Older ones,
and a hand-written Action workflow, do not (Upgrading). `fix-llm` and `watch` read only the
registry bundled into the release, so they get it with this tag. Everything else needs the tag:
sections 1 to 3, and the `prompt_cache_retention` check in section 4.

---

## What a customer gets

### 1. More ways of writing a model id get the parameter check (TypeScript)

The check behind `coupled_param_unverified` and `param_behaviour_change` now reads the requests a
model id reaches in the same file through the shapes below, as it reads the call written inline.
Some routes are still not read (Known issues). The v0.5.9-alpha Known issue "A Tier A swap can leave
a request the replacement rejects, or change it without review" is fixed for these shapes. Each row
was run on both builds:

| call | v0.5.9-alpha | v0.5.10-alpha |
|---|---|---|
| `const model = 'gpt-4-0613'; create({ model, max_tokens: 256 })` | Tier A swap to `gpt-5.6-sol`, `max_tokens` kept | Tier B, `param_behaviour_change` |
| `const GPT4_MODEL = 'gpt-4-0613'; create({ model: GPT4_MODEL, max_tokens: 256 })` | Tier A swap, `max_tokens` renamed with no review | Tier B, `param_behaviour_change` |
| `model: 'gpt-4-0613' as const, max_tokens: 256` | Tier A swap, `max_tokens` kept | Tier B, `param_behaviour_change` |
| `model: process.env.MODEL \|\| 'gpt-4-0613', max_tokens: 256` | Tier A swap, `max_tokens` kept | Tier B, `param_behaviour_change` |
| `const MODEL = 'claude-opus-4-1-20250805'; messages.create({ model: MODEL, max_tokens: 1024 })` | Tier A swap to `claude-opus-4-8` | Tier B, `coupled_param_unverified` |
| `{ "model": "o3-mini", "max_tokens": 2 }` | Tier A swap, `"max_tokens"` kept | Tier A swap, renamed to `"max_completion_tokens"` |
| the inline call `model: 'gpt-4-0613', max_tokens: 256` | Tier B | Tier B (unchanged) |

- **A declaration is held when any request that reads it would be held written inline,** and the
  finding carries that request's reason. The requests read are the ones in the same file, including
  those reached through a function parameter at a call that passes the value (directly, or through
  a local copy as in `const m = model; ask(m)`), or a field a constructor sets from one. A request
  that reads a local copy itself is not read, and neither are calls in other files (Known issues).
- **The parameter fix that follows a swap reads more shapes:** a `{ model }` shorthand, `as string`,
  `as const`, `!`, and a quoted or computed key. It renames the key in its own spelling. It reads
  these shapes only inside a request. An object that is not a request, such as a model table, is
  edited only where v0.5.9-alpha edited it.
- **A `let` that is assigned again is no longer read as one model.** With
  `let model = 'claude-opus-4-8'; if (cheap) model = 'claude-sonnet-4-6'` and `model: model` in the
  request, v0.5.9-alpha removed `temperature`, including on the path where the model is Sonnet 4.6,
  which accepts it. That request is now left alone.

### 2. Python calls get a parameter check

Python now has a parameter guard like TypeScript's, but it follows fewer routes. Both scanners ask
one function, so the rules are not kept twice. `audit`, `watch` and `fix-llm` agree. `fix-llm
--write` and `migrate` leave a held Python call as written.

| Python call | v0.5.9-alpha | v0.5.10-alpha |
|---|---|---|
| `client.chat.completions.create(model="gpt-3.5-turbo", max_tokens=20, …)` | Tier A swap to `gpt-5.6-terra`, `max_tokens` kept | Tier B, `param_behaviour_change` |
| `client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, temperature=0.7, …)` | Tier A swap to `claude-opus-4-8`, both kept | Tier B, `coupled_param_unverified` |
| `MODEL = "gpt-4-0613"`, then `create(model=MODEL, max_tokens=256, …)` | Tier A swap | Tier B, `param_behaviour_change` |
| `claude-3-5-sonnet-20241022` with `max_tokens` and `temperature` | Tier A swap to `claude-sonnet-4-6` | Tier A swap (unchanged; no rule covers that family) |

The guard reads:

- the call's keyword arguments;
- the keys of a dict unpacked with `**name`, including keys added with `name["k"] = …`,
  `.update(…)` or `.setdefault(…)`, and the keys of `**{…}` or `**dict(…)` written in the call;
- for a model bound to a traced name (`MODEL = "…"`, `self.model = "…"`, a class attribute or a
  parameter default), the keyword arguments of each call that takes that same value.

Python still has no parameter pass, so nothing renames or drops a parameter after a Python swap.
What the guard does not read is listed under Known issues.

### 3. OpenAI fine-tuned model ids in code are found and held

The v0.5.9-alpha Known issue "OpenAI fine-tune ids written in source code are not located" is fixed.

```ts
await client.chat.completions.create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc', messages });
```

- **Before:** v0.5.9-alpha gave no finding, and `audit` concluded
  `no_exposure_in_completed_surfaces`.
- **Now:** the call is Tier B, `surface_capped`, under the registry row `ft-gpt-3.5-turbo`
  (2026-10-23). `audit` concludes `exposure_detected`, and `watch` lists it as `review_required`.
  The same Python call gives the same result.
- **Never swapped.** Every replacement is a base model, and the swap would drop the customer's
  training. The finding says so.
  - A Tier A call in the same file is still swapped.
  - A fine-tune call that also passes `max_tokens` is held for its training, not for the parameter.
- **Which row:** a fine-tune joins the registry's row for fine-tunes of its base model, the most
  specific first, and otherwise its base model's own row. A fine-tune of a model the registry does
  not list (for example `ft:gpt-4o-2024-08-06:…`) is not a finding.
- **Only a whole id matches.** A fine-tune in a list, a lookup key or a comparison is Tier C, as a
  plain id would be.
- **What the finding shows:** in `audit` and `watch`, the finding's model id is the row
  (`ft-gpt-3.5-turbo`), so it carries neither your organisation name nor the job id. `fix-llm`
  prints the id as written, in its `found:` line, in its held sentence and in its JSON `modelId`.
  Every snippet shows the line as written, so both appear there.

### 4. Registry: OpenAI's 2027 retirements, and Anthropic's sampling rules

Checked against the providers' own pages on 2026-10-10 and 2026-10-11. 17 page snapshots are added
under `registries/evidence/`.

- **Counts.** 26 model-id records added, none removed. The 193 existing model-id records are
  unchanged, field for field. Automatic (Tier A) records: 135 before and after.
- **All 26 new records are review only:** 6 quarantined, 13 unverifiable and 7 unverified. A live
  call to one gave no finding with v0.5.9-alpha's bundled registry and is now Tier B. For example,
  TypeScript calls on `gpt-5.1`, `gpt-5.3-codex`, `whisper-1` and `tts-1` each come out
  `replacement_unverified`. The same Python audio calls are held as `surface_capped`.
- **OpenAI, 2027-04-01:** `gpt-5.1` → `gpt-6-sol`, `gpt-5.4-nano` → `gpt-6-luna`, and
  `gpt-5.3-codex` → `gpt-6-sol`.
  - `gpt-5.1` and `gpt-5.4-nano` are held because the GPT-6 models default to a different
    reasoning effort. OpenAI's GPT-6 guide says that above `none`, `temperature`, `top_p` and
    `top_logprobs` must be removed.
  - `gpt-5.3-codex` is held because OpenAI's guide moves `prompt_cache_retention` to
    `prompt_cache_options.ttl`, and mendr neither checks nor rewrites that field on a swap to GPT-6.
    The gate first stamped this record verified. A later commit in #57 (507c5a7) held it before
    merge, so it is review only in this release.
  - The dated snapshots `gpt-5.1-2025-11-13` and `gpt-5.4-nano-2026-03-17` are recorded with no
    shutdown date, because OpenAI's page names only the alias. A call on one reads "no dated
    deadline".
- **OpenAI, 2027-01-06:** `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts-2025-03-20` and
  `gpt-4o-mini-tts-2025-12-15`, all pointing at `gpt-realtime-2.1-mini`. OpenAI's replacement is a
  Realtime API model, so the migration moves the call off the speech endpoint. An id swap is not
  that migration.
- **OpenAI, 2027-01-20:**
  - The family rows `gpt-4o-audio`, `gpt-4o-mini-audio` and `gpt-4o-mini-realtime` are kept as
    OpenAI wrote them. No OpenAI page lists a callable model by those literal ids, so they match
    nothing callable.
  - Four dated snapshots under those families have undated records of their own:
    `gpt-4o-audio-preview-2025-06-03`, `gpt-4o-audio-preview-2024-12-17`,
    `gpt-4o-mini-audio-preview-2024-12-17` and `gpt-4o-mini-realtime-preview-2024-12-17`.
- **OpenAI, 2027-02-26:** `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and
  `gpt-4o-transcribe-diarize`, pointing at `gpt-transcribe`. OpenAI names two replacements. Its
  transcription guide still sends word timestamps, subtitles and translation to `whisper-1`.
- **Already retired:**
  - OpenAI's `gpt-4-turbo-preview-completions` (2026-03-26). OpenAI names two replacements.
  - Google's `veo-3.0-generate-001`, `veo-3.0-fast-generate-001` and `veo-2.0-generate-001`
    (2026-06-30), and `veo-3.0-generate-preview` and `veo-3.0-fast-generate-preview` (2025-11-12).
    Google's named replacements are Veo 3.1 previews, which themselves shut down on 2026-10-22.
- **Candidate queue:** 43 before, 33 now. Ten went through `mendr candidates verify` and `promote`:
  the 2027-04-01 three, the four 2027-01-06 TTS ids, and the three 2027-01-20 family rows. The other
  16 records were added by hand from the provider pages.
- **Anthropic's sampling rules.** The rules that drop `temperature`, `top_p` and `top_k` now cover
  Claude Sonnet 5 and 5.5, Haiku 5.5, Fable 5 and 5.1, Mythos 5 and 5.1, and Mythos Preview, besides
  Opus 4.7 and later. Each rule quotes the Anthropic page it rests on. The v0.5.9-alpha Known issue
  "The rule that sampling parameters return a 400 does not yet cover `claude-sonnet-5-5`" is fixed.
  - **No automatic swap changes.** No automatic record migrates onto those families.
  - **But the rules now edit calls already on those models.** In TypeScript, on a call on Claude
    Sonnet 5 or 5.5, Haiku 5.5, Fable 5 or 5.1, Mythos 5 or 5.1, or Mythos Preview, `fix-llm` and
    `migrate` remove `temperature`, `top_p` and `top_k` as a Tier A fix. Anthropic's pages say these
    models reject a non-default value. Example, run on both builds:
    `model: 'claude-sonnet-5-5', max_tokens: 1024, temperature: 0.7` gave no finding on
    v0.5.9-alpha and is now Tier A with `temperature` removed. A `migrate` run with registry refresh
    on has proposed this since #57 merged. Python has no parameter pass, so a Python call keeps
    these parameters.
  - **The reason a held Sonnet 4.5 call carries also changes.** The `claude-sonnet-4-5-20250929`
    record was already review only, so the tier does not move.
    - A call that passes `temperature` and `max_tokens` changes from `replacement_unverified` to
      `coupled_param_unverified` (run on both builds).
    - A call that passes only `temperature` changes to `param_behaviour_change`, and one that
      passes neither stays `replacement_unverified` (both pinned by the test suite).
- **`prompt_cache_retention` is checked on a move to GPT-5.6.** This is code, shipped with #57, and
  needs this tag. OpenAI's guide tells a move to GPT-5.6 to replace `prompt_cache_retention` with
  `prompt_cache_options.ttl`. No registry rule can make that edit. So a call that passes it and
  would migrate onto a GPT-5.6 model is held (`coupled_param_unverified`).
  - Example: `model: 'gpt-4-0613', prompt_cache_retention: '24h'` was a Tier A swap to
    `gpt-5.6-sol` with the field kept. It is now held.
  - This applies in TypeScript and, where the guard reads the parameter, in Python.

### 5. If you gate CI on `fix-llm` or `audit`, the result can change after upgrading

Each exit code and reason below was run on both builds, offline, with the bundled registry, except
where a sentence names registry refresh.

- **`fix-llm --fail-on tierB` can fail where it passed (exit 0 before, 1 now).** Causes:
  - the calls in sections 1 and 2 that move from Tier A to Tier B;
  - fine-tunes in code;
  - the new registry records;
  - calls that pass `prompt_cache_retention` onto GPT-5.6.
- **`fix-llm --fail-on tierA` can pass where it failed (1 before, 0 now).** This happens when a
  repository's only Tier A was one of those calls, or a parameter edit on a `let` that is assigned
  again (section 1).
- **`fix-llm --fail-on tierA` can also fail where it passed (0 before, 1 now).** Two causes:
  - The parameter fix now reads shorthand, casts, `!` and quoted keys in a request, even on a model
    that is not retiring. `const model = 'gpt-5.6-sol'; create({ model, max_tokens: 256 })` now
    gets `max_tokens` renamed to `max_completion_tokens`, which counts as Tier A.
  - A TypeScript call already on Claude Sonnet 5 or 5.5, Haiku 5.5, Fable 5 or 5.1, Mythos 5 or
    5.1, or Mythos Preview that passes `temperature`, `top_p` or `top_k`: the extended sampling
    rules now remove them as Tier A (section 4). Example:
    `model: 'claude-sonnet-5-5', max_tokens: 1024, temperature: 0.7`.
- **`migrate` and the Action can now propose a change where they proposed none.** The same
  parameter edit is a migration. On `const model = 'gpt-5.6-sol'; create({ model, max_tokens: 256 })`,
  `migrate` on v0.5.9-alpha reported `no_migration`. It now proposes renaming `max_tokens`, and when
  the gates pass it reports `verified`. So the Action can open a Mendr pull request on a repository
  that calls no retiring model. The sampling edits in section 4 can do the same. With registry
  refresh on, `migrate` has proposed those since #57 merged.
- **`audit --fail-on-exposure` can fail where it passed (0 before, 1 now)** for a repository whose
  only retiring calls are fine-tunes or new registry records. With registry refresh on, the
  registry half of this has applied since #57 merged.
- **Reason codes move inside Tier B.** A Sonnet 4.5 call (section 4) changes reason. With registry
  refresh on, `audit` has shown this since #57 merged. A Python call whose replacement is unverified
  and that passes a parameter the guard reads changes too: it moves from `replacement_unverified` to
  `param_behaviour_change` or `coupled_param_unverified`, as the same TypeScript call already did.
  Example: `model="gpt-3.5-turbo-0613", max_tokens=20` moves to `param_behaviour_change`. A consumer
  that routes on reason codes sees these move. `fix-llm --json`'s older `blocked` count and list
  hold only `replacement_unverified` calls, so they drop these calls.
- **`fix-llm` reads only the bundled registry**, so for a `fix-llm` gate every change in this
  release, registry included, arrives with the tag.

### 6. The hosted App recovers an install it lost (#56)

This ships when the hosted App deploys from main, not with this tag. That deploy ran when #56
merged on 2026-10-11, and the deploy check saw #56's merge commit answering (Evidence).

The App's database moved to a new, empty Postgres on 2026-10-10. The App learns which installation
covers which repository only from GitHub's installation webhooks, which GitHub sends once. So every
existing install was refused on upload ("the Mendr GitHub App is not installed on <repo>") until the
account reinstalled the App.

The App now recovers the install from GitHub on the first upload after a lost database. This covers
`POST /api/ingest`, `POST /api/migrations` and the approvals check. For a repository its database
does not know, it asks GitHub before refusing:

1. `GET /repos/{owner}/{repo}/installation` with the App's JWT. The owner and repository come from
   the verified OIDC token, never from the request body.
2. A fresh installation token, limited to the token's `repository_id` and `metadata: read`. GitHub
   will not mint it for a repository outside the installation.
3. `GET /repos/{owner}/{repo}` with that token. GitHub's id must equal the token's
   `repository_id`.

Only when all three agree does the App store the installation and that one repository, write an
`installation_recovered` audit-log entry, and accept the upload. Any other answer gets the same 403
as before. The App remembers that answer per repository for 5 minutes, or 1 minute when GitHub or
the database did not answer.

Recovery brings back the installation and the repository, not the history. Runs, migration
reports, approvals, acknowledgements and audit-log entries stored in the old database are not
restored.

When a signed-in user's overview would be empty, the App reads `GET /user/installations` and then
`GET /user/installations/{id}/repositories` for each installation, with that user's own token, and
adds the repositories its database lacks. The page waits at most 8 seconds for these answers. It
does this at most once every 10 minutes per user. No permission changes: `checks: write`,
`metadata: read`, and the optional `actions: write`. TRUST.md describes both new paths. The privacy
page names the upload lookup but not the sign-in read of the user's installations.

Also on main since v0.5.9-alpha, and also not part of this tag:

- **The App's database is now on Neon** (AWS US East 2, Ohio), listed as a new provider in TRUST.md
  and the privacy page (#52).
- **The App fails fast** with one sentence when its database is unreachable (#52).
- **Render's health check uses `/livez`,** which never touches the database (#52).
- **`render.yaml` no longer provisions Render's expiring free Postgres** (#52).
- **The marketing site has a pricing section** (#51).

When this release is merged to main and the App redeploys, the App's one-click setup hands out
`v0.5.10-alpha` (`MENDR_CLI_SPEC` in `app/src/config.ts`). Until then it hands out `v0.5.9-alpha`.

### 7. The rollback floor moves

The bundled registry was stamped at 2026-10-11T02:08:07Z, right before the tag. A downloaded
snapshot published before that is refused. That includes the one `registry-publish` made when #57
merged, at 02:05Z. `registry-publish` runs again when the tag is pushed, so a refreshed scan on this
release has a snapshot it accepts. The bundled registry grades fresh for 14 days from the stamp,
until 2026-10-25 02:08 UTC.

---

## Upgrading

- **CLI:** `npx github:ajitheee/mendr#v0.5.10-alpha audit .`
- **Audit and watch workflows:** set the repository variable `MENDR_SPEC=v0.5.10-alpha`. No workflow
  edit is needed.
- **Migrate workflow: a workflow edit is required.**
  - On the `uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@…` line, change the ref
    (`v0.5.9-alpha`, or the commit SHA you pinned) to `v0.5.10-alpha`.
  - If you used the one-click setup, that line is in the `migrate` job of `mendr-audit.yml`. Change
    the audit job's `uses:` line to the same ref too, so the file's two lines stay on one release as
    its comment asks. Still set `MENDR_SPEC`, which overrides that pin when it is set. Only
    repositories connected before the one-click setup have a separate `mendr-migrate.yml`.
  - You can also re-run the one-click setup, once the App hands out `v0.5.10-alpha` (section 6).
  - `reusable-migrate.yml` cannot honour `MENDR_SPEC`, because GitHub forbids an expression in
    `uses:`.
- **A hand-written Action workflow:** change both `uses: ajitheee/mendr/mendr-action@…` and
  `mendr-spec`. They must name the same release.
- **Registry refresh:** an audit workflow generated before 2026-09-06, a migrate workflow generated
  before 2026-09-09, and a hand-written Action workflow do not set `MENDR_REGISTRY_REFRESH: 'on'`.
  Add the line or re-run the one-click setup. Until then, that workflow gets new registry records
  only with a new tag.
- **Open audit issue:** on the first run after the upgrade, two kinds of finding change.
  - Each finding whose role changes from a call site to a candidate shows as new. These are the
    findings that move from Tier A to Tier B (sections 1 and 2, and a call that passes
    `prompt_cache_retention` onto GPT-5.6 in section 4), and the Tier B findings that move to a
    parameter reason (a Sonnet 4.5 call that passes `temperature` or `max_tokens`, and a Python call
    whose replacement is unverified and that passes a parameter the guard reads). The old entry is
    not marked resolved on that run. It is listed under "Held open across a scanner or registry
    change", so the issue counts the finding twice until the next run on the same release and
    registry marks it resolved. With registry refresh on, the TypeScript Sonnet 4.5 calls already
    made this move when the registry from #57 was published.
  - Fine-tunes in code show as new. New registry records also show as new, unless your audit
    already refreshed the registry.
- **A committed `.mendr/exposure.json`** changes on the first `watch` run after the upgrade in every
  repository that commits it, because it records the bundled registry's hash (`registryVersion`),
  which moves from `sha256:9319f3c6ea52b69d` to `sha256:e0464cc70ab44d9d`. Its entries also change
  for the calls above: tiers, reason codes, and new rows for fine-tunes and new registry records.

---

## Corrections to v0.5.9-alpha's notes

- **"`as any` on the argument can hide the call" was not reproduced.** v0.5.9-alpha's Known issues
  listed `as any` on a call's argument among the wrappers that hide a call from the scanner. On
  both builds, `create({ … } as any)` was still recognised as a provider call in three cases: a
  direct call, a call through a proxy client, and a call in an `examples/` tree. The proxy and
  example calls were held for review, as they are without the cast. `satisfies` and `<T>` around
  the argument or the model value do hide the call (Known issues).

---

## Known issues

Fixed since v0.5.9-alpha, so no longer listed:

- a Tier A swap through a `const`, shorthand, cast or fallback skipping the parameter check
  (section 1; some routes remain, below);
- Python swaps never checking parameters (section 2; the editing half and some routes remain,
  below);
- fine-tune ids in code not located (section 3);
- the Sonnet 5.5 sampling rule (section 4);
- OpenAI's 2027 retirements missing from the registry (section 4).

Still open, or new:

- **`migrate` and the Action don't disclose held calls, and this release makes that more
  frequent.**
  - If a repository's only findings are held calls, `migrate` reports
    `NO MIGRATION — no verified Tier-A swap was found`, and the Action reports the repository clean
    and closes an open Mendr pull request with the comment "Mendr: no deprecated model ids remain;
    closing.", which is not true while held calls remain.
  - Sections 1 to 4 hold more calls. Examples on both builds:
    `const MODEL = 'claude-opus-4-1-20250805'` with `max_tokens`, a `{ model }` const on
    `gpt-4-0613` with `max_tokens`, and Python's `gpt-3.5-turbo` call with `max_tokens`.
    `migrate` on v0.5.9-alpha proposed each swap; it now proposes none.
  - One case always applies: a call to Claude 2, Claude 3 Opus, Opus 4 or Opus 4.1 through a
    `const` or shorthand in TypeScript, or any such call in Python. Anthropic requires
    `max_tokens`, so every such call passes it (next item). An OpenAI call that passes `max_tokens`
    and moves onto a `gpt-5.6` model, such as one on `gpt-4-0613`, is held the same way.
  - Read `audit` or `fix-llm`'s Tier B before you trust a clean `migrate` result or a closed Mendr
    pull request.
- **Anthropic's `max_tokens` is treated as model-dependent when the replacement is in a family a
  sampling rule names.** That family is `claude-opus-4-8` for Claude 2, Claude 3 Opus, Opus 4 and
  Opus 4.1, and now also `claude-sonnet-5-5` for Sonnet 4.5.
  - Such a call that passes `max_tokens` goes to review (`coupled_param_unverified`) instead of
    being patched. This now happens in Python as well as TypeScript.
  - Those Opus models are already past their shutdown dates, so these calls already fail.
  - The finding's sentence says the replacement "may not accept the parameter `max_tokens`". For a
    Sonnet 4.5 call that also passes `temperature`, it names `max_tokens` and not `temperature`.
    The record's quarantine reason does name sampling parameters.
- **In Python, a swap the guard does not hold keeps every parameter as written.** Python has no
  parameter pass. The guard does not read:
  - keys a caller passes through a function's `**kwargs`. Example: `def ask(messages, **kwargs)`
    calling `create(model="gpt-4-0613", …, **kwargs)`, invoked with `max_tokens=256`, is swapped to
    `gpt-5.6-sol`;
  - a dict it cannot see (`**self.params`, a call result);
  - a parameter nested in another argument. Example: `extra_body={"max_tokens": 256}` is swapped
    with the key kept;
  - a key added to the dict in another function;
  - a model passed on under another name: a local copy (`m = MODEL`), a function parameter fed at a
    call (`ask(MODEL, [])`), an attribute a constructor sets from one (`Bot(MODEL)` with
    `self.model = model`), or a name imported from another module. Each is swapped to
    `gpt-5.6-sol` with `max_tokens=256` kept;
  - a class attribute read through an object outside its class (`cfg.model` for a dataclass
    field).

  Separately, a call whose old model is already under the same rule stays Tier A and keeps its
  parameter: `o3-mini` with `max_tokens=256` is swapped to `gpt-5.6-sol` with `max_tokens` kept.
  The rule says the old model rejected that request too. Check Python swaps by hand.
- **In TypeScript, the same rule-already-applied case lands its parameter fix only where the fix can
  read the model.** Shapes where it cannot:
  - a request whose model is `this.model` (example: a class field `model = 'o3-mini'` and
    `create({ model: this.model, max_tokens: 256 })` is swapped with `max_tokens` kept);
  - a fallback or a ternary;
  - a model-like key other than `model`;
  - a `let` that is assigned again. Example: `let model = 'o3-mini'; if (cheap) model = 'gpt-4.1'`
    with `model: model, max_tokens: 256` is swapped to `gpt-5.6-sol` with `max_tokens` kept.
    v0.5.9-alpha also renamed it to `max_completion_tokens`.
- **In TypeScript, a request that reads a copy of the model under another name is not read.**
  Example: `const model = 'gpt-4-0613'` used by one call with no parameters, and
  `const m = model; create({ model: m, max_tokens: 5 })` in another function. The const is a Tier A
  swap and the second request keeps `max_tokens`. Check such calls by hand.
- **In TypeScript, the parameter check does not read keys spread into a request.**
  `const defaults = { max_tokens: 256 }; create({ model: 'gpt-4-0613', ...defaults, messages })` is
  a Tier A swap to `gpt-5.6-sol` with `max_tokens` kept, on both builds. So is
  `...{ max_tokens: 256 }` written in the call. Python reads the same keys:
  `create(model="gpt-4-0613", **defaults)` is held (`param_behaviour_change`). Check by hand any
  TypeScript swap whose request spreads in options.
- **Calls in other files are not read.** A declaration is linked only to requests in its own file.
  Example: `export const MODEL = 'gpt-4-0613'` in `models.ts` is used there by a call with no
  parameters, and imported into `chat.ts` by a call that passes `max_tokens`. The const is a Tier A
  swap, and the `chat.ts` request keeps `max_tokens`. Check such calls by hand. The same limit
  means a gateway-prefixed const imported from another file does not hold the calls that use it.
  Example: `export const GW_MODEL = 'openai/o3-mini'` in `models.ts`, used in `chat.ts` as
  `create({ model: GW_MODEL, fallbacks: [{ model: 'o3-mini', max_tokens: 6 }] })`. The nested
  `max_tokens` is renamed, while the same call with the const declared in its own file is left as
  written.
- **Held-call shapes the parameter pass cannot tie yet** are listed in the README ("Held calls: what
  is and is not protected"). A parameter rule can still edit these:
  - the held call's model read as `this.model`, or the held id under a model-like key other than
    `model`;
  - a nested request reached by indexing, a property read, a callback, or a call inside the
    arguments;
  - a request built in a variable whose model is not a literal written in that object
    (`const req = { model: MODEL, … }`), or spread in from one;
  - a second, unheld model value inside a held call, which can still be swapped.
- **Some live calls are still reported as data (Tier C).** Read the Tier C list for ids you know are
  called. Each example below is Tier C on both builds:
  - a config object declared in another file and read through a property path
    (`config.integrations.chatGPT.model`);
  - a request body built in a variable and passed through `JSON.stringify` to a raw `fetch`;
  - a runtime fallback returned from a helper (`return process.env.MODEL ?? 'o4-mini'`) and passed
    as `model: pickModel()`;
  - a positional constructor argument (`new OpenAiCompletionProvider(modelName || 'gpt-4-turbo', {})`);
  - a model kept under another key and read back (`opts.modelName`).
- **`satisfies` or `<T>` around a model value or a call's argument hides the call from the
  scanner.**
  - `model: 'gpt-4-0613' satisfies string` is reported as data.
  - A proxy call written `create(<any>{ model: 'o3-mini', max_tokens: 256, … })` is reported as data,
    not held, and its `max_tokens` is renamed.
- **A Tier B call with an unverified replacement still gets parameter edits.** `o1-mini` with
  `max_tokens` is `replacement_unverified` with "no patch generated" for the model id. But
  `max_tokens` is still renamed in that call.
- **The parameter pass has no surface rules of its own.** A sample or proxy call on a model that is
  not retiring is not held, and a parameter rule can still apply to it.
- **A gateway-prefixed id loses its record in `fix-llm`** when it sits behind an `as` cast
  (`type_cast_masked`). It shows as unverified with no entry id; `audit` names the record.
- **In Python, a file that names a local proxy host holds every client in it.** A direct SDK call in
  such a file is held for review (`surface_capped`).
- **Fine-tunes, not covered yet:**
  - A fine-tune id in a config file (`.env`, YAML, JSON) is still a Tier C catalog reference under
    its base model's row, with that row's date.
  - `audit` describes a fine-tune that joins its base model's row (no `ft-` row covers it) with the
    generic wording for a held call. It is still held and never swapped.
- **The parameter checks cannot reach a GPT-6 replacement,** because no parameter rule names that
  family. That is why `gpt-5.3-codex` is review only for every call.
- **A Live API entry can become automatic later.**
  - `gemini-2.0-flash-live-001`, `gemini-live-2.5-flash-preview` and
    `gemini-3.1-flash-live-preview` are held only because models.dev does not list
    `gemini-3.8-live` yet.
  - Once it does, a maintainer re-stamps them with `mendr verify-registry --write`.
  - They become automatic fixes when that change merges and is published. Nothing re-stamps them
    by itself.
- **Some automatic swaps go to a model other than the one the provider names now.** Anthropic's
  deprecations page names `claude-sonnet-5-5` as the replacement for `claude-3-sonnet-20240229`,
  `claude-3-5-sonnet-20240620`, `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219` and
  `claude-sonnet-4-20250514`. mendr swaps those ids, and their aliases, to `claude-sonnet-4-6` as
  Tier A fixes. Anthropic lists Sonnet 4.6 as active, retiring no sooner than 2027-02-17.
  `chatgpt-4o-latest` goes to `gpt-5.6-sol`, where OpenAI's page names `gpt-5.1-chat-latest`.
  `mendr check-dates` prints both as warnings. Whether to move the Sonnet records to Sonnet 5.5,
  which would make them review only, is not decided yet.
- **Not yet in the registry, so calls to these get no finding:**
  - `deep-research-pro-preview-12-2025`, which shuts down on 2026-10-23 and is passed as an `agent`
    value the scanner does not read as a model call.
  - 33 ids waiting in the candidate queue (`registries/candidates.json`), all past the shutdown
    dates their rows give. Examples: `gpt-5.1-codex`, `gpt-5.2-codex`, `codex-mini-latest`,
    `o3-deep-research`, `imagen-4.0-generate-001`, and the aliases `gpt-4o-mini-realtime-preview`
    and `gpt-4o-mini-audio-preview`.
- **`fix-llm`'s Tier A count can be lower than the edits `--write` applies,** because it locates
  parameter sites before the swap.
- **`migrate --skip-verify` can run out of memory at Node's default heap on very large
  repositories.** Not re-tested for this release.
- **A registry with two records for one model id can be handled two ways.**
  - None ships, but one is possible through `MENDR_REGISTRY_FILE`.
  - Then `audit` can hold the id under one record while `migrate` swaps it under the other.
  - `fix-llm` and `watch` read only the bundled registry.
- **Some report wording is still wrong.** The reason codes and tiers are right.
  - `audit`'s human report calls a held proxy call "a code default or call not traced to a provider
    request".
  - In an example tree, a non-provider call such as an Express `res.json({ model: … })` is printed
    with the rule "the id is passed to a real provider request here".
  - The `platform_blocked` sentence says "deployment key" where the scanner also matches a
    deployment-named variable.
  - An untraced model value in a file that does make a supported SDK call still prints "no
    supported SDK call or parameter sink was found in this file". This happens in Python, and in
    TypeScript for a model read through a property path of an object in the same file.
  - The audit issue lists a held call at a verified SDK call site as "code literal (use not
    proven)". Every call this release newly holds, fine-tunes included, gets that label.
  - Every `gpt-5.3-codex` finding prints a registry reason saying "Python has no parameter guard".
    Python has one since this release. The record is still review only, because no parameter rule
    names the GPT-6 family.
- **The App's install recovery has not been checked against live GitHub.** Its tests use a fake
  GitHub, and the post-deploy smoke check does not run it. GitHub's docs confirm that
  `GET /repos/{owner}/{repo}/installation` needs only the App's JWT, but they don't say when it
  returns 404. Step 2 (the scoped token mint) is the guard that does not depend on that.
- **Install recovery brings back the installation, not the data the old database held.** Runs,
  migration reports, approvals, acknowledgements and audit-log entries stored before the move on
  2026-10-10 are gone. An approval made in the App before then has to be made again, and a
  repository's run history starts with its next scan.
- **A variable named exactly `TOKEN` is not redacted.** It never was.

---

## Evidence

Run on the release tree (`release/v0.5.10-alpha` at `e8aa5c7`, which is main at `7dbd97c` plus the
stamp) on 2026-10-11 UTC. The v0.5.9-alpha build was made in a separate directory from
`git archive v0.5.9-alpha`.

- **Version pins:** `node scripts/check-pins.mjs` reports OK, with the release pins at
  `v0.5.10-alpha`. Its delivery-staleness rule did not run, because the tag does not exist yet.
- **Registry format:** `npm run validate:registry` reports 0 violations across 219 model-id records
  (223 entries).
- **Registry comparison** (`registries/llm-deprecations.json` at `v0.5.9-alpha` and at `e8aa5c7`):
  - 26 model-id records added and none removed; the other 193 are identical field for field.
  - Records passing the four-field gate: 135 and 135.
  - Three parameter rules changed (Anthropic's `temperature`, `top_p`, `top_k`); OpenAI's
    `max_tokens` rule is unchanged.
- **Bundled stamp:** `2026-10-11T02:08:07Z`, `sha256:e0464cc70ab44d9d`, 223 entries. The hash
  matches the committed file's bytes.
- **Dates and rules against the live pages:** `mendr check-dates` checked 219 model-id entries
  against 3 provider pages: 173 confirmed, 21 inferred from a stated snapshot, 0 failing, and 25 not
  judged (18 cite a page the check does not read, 7 carry no date). It also printed 18 warnings for
  a confirmed date whose replacement is not one the page names (Known issues). `mendr check-rules`
  confirms 26 of 26 quoted sentences on 6 pages. Both exit 0.
- **Release-build probes.** These used `fix-llm --offline --skip-gates`, `audit --offline --json`,
  `audit --issue-body` and `--previous-body`, `migrate --offline --skip-verify`,
  `migrate --offline --json` and `watch --offline --json`. They ran on scratch projects outside the
  repository, on both builds. Every before/after row and gate exit code in sections 1 to 5 and every
  code example in Known issues comes from these runs, except the two Sonnet 4.5 reasons marked as
  pinned by the test suite. The claims that registry refresh already brings a change come from
  v0.5.9-alpha runs on the new registry, fetched with `MENDR_REGISTRY_REFRESH=on` (snapshot
  `sha256:e0464cc70ab44d9d`) or passed with `MENDR_REGISTRY_FILE`.
- **App deploy:** the `app-deploy` run for #56's merge (38103952500) passed its smoke check. That
  check waits until the deployed commit answers on `mendr-app.onrender.com`.
- **Tests:** the full suite on the stamped tree passes 2087 tests in 117 files; the App suite passes 235 tests in 18 files, and its typecheck is clean.
- **Review:** one agent drafted these notes from the code and probes, and three independent checks compared every claim with the release build, the registry and v0.5.9-alpha. All 36 of their corrections are applied.
