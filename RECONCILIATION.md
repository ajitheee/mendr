# Provider reconciliation runbook (step 4)

Goal: prove `mendr audit`'s MEASURE half matches the provider's own dashboard, on a
**non-empty organization**. This is a human step — the key never leaves your machine
and is never sent to anyone.

Before this runbook existed, the fetchers had bugs that guaranteed a mismatch. Those
are fixed (PR #4). What remains are the *expected* differences, listed below, so a
gap is understood rather than chased.

---

## Key safety

* Use a **read-only usage/cost Admin key**. mendr only issues GET requests to usage
  and cost endpoints — it never invokes a model, never moves money, never reads prompts.
* Pass it via an env var, never an argument (arguments land in shell history):

  ```powershell
  $env:MENDR_PROVIDER_KEY="sk-admin-..."
  ```
* **Never send the key to anyone**, including Claude. Run these commands yourself.
* Revoke the key when the audit is done.

---

## A. OpenAI

Pick a window with real traffic and a **non-empty org** (not a fresh/empty account).

```bash
node dist/cli.js audit . openai --from 2026-07-01 --to 2026-07-31 --json > openai-audit.json
```

Then compare against <https://platform.openai.com/usage> (set the SAME dates).

### Checklist

| # | Check | Where to look | Expected |
|---|---|---|---|
| 1 | **Request totals match** | dashboard "Requests" vs `coverage`/report total requests | Match for Chat Completions + Responses. A dashboard total that is HIGHER is expected if the org uses embeddings/images/audio/moderations (see Expected differences). |
| 2 | **Cost matches** | dashboard Costs page vs report `$` total | Should match the Costs API total for the window. |
| 3 | **Multiple pages fetched** | an org with >31 days or many models | Increase the window past 31 days; confirm results still complete (pagination follows `has_more`/`next_page`, capped at 40 pages). |
| 4 | **Fine-tuned ids** | a `ft:gpt-...` model in usage | The raw id is preserved in `observed`, and the normalized base model is what joins the registry. Both should appear. |
| 5 | **Deprecated models join** | any retiring model in usage | It appears as an investigation with retirement evidence + a deadline. |
| 6 | **Unqueried categories disclosed** | the coverage report's `·` notes | "Chat Completions + Responses only…" must be printed. |
| 7 | **Nothing sensitive in output** | `openai-audit.json` | Grep for your key and for prompt text — neither may appear. |

Quick check for #7:

```bash
grep -c "sk-" openai-audit.json
```

That must print `0`.

### Expected differences (not bugs)

* **Coverage**: mendr queries `/usage/completions` only. Embeddings, images, moderations,
  audio (speech/transcription), vector stores, code interpreter, and file/web-search
  usage are NOT counted, so a dashboard total may legitimately exceed mendr's. The
  Responses API *is* included in the completions endpoint.
* **Two ledgers**: requests/tokens come from the Usage API, dollars from the Costs API.
  OpenAI states these may not tie out exactly; only the Costs figure reconciles to the invoice.
* **Cost-only rows**: models with spend but no completions usage now appear with
  `requests: 0` so the dollar total reconciles.

---

## B. Anthropic

Repeat with a non-empty Anthropic org:

```bash
$env:MENDR_PROVIDER_KEY="sk-ant-admin-..."
node dist/cli.js audit . anthropic --from 2026-07-01 --to 2026-07-31 --json > anthropic-audit.json
```

Compare against the Anthropic Console usage and cost pages.

### Checklist — same seven, with these differences

* **Requests will read 0 — by design.** Anthropic's Messages Usage Report exposes no
  request-count field. mendr reports `0` and discloses "requests: not reported by the
  Anthropic usage API". Do NOT treat that as a mismatch; verify the disclosure prints.
* **Tokens must match**, including cached traffic: mendr sums uncached + cache-read +
  both cache-creation buckets. If the Console shows caching and mendr's input tokens
  are far lower, that's a real bug — report it.
* **Cost must match** the Console Cost page, except **Priority Tier spend**, which the
  cost report excludes.

---

## What to record

For each provider, capture:

1. The window used, and the org (name only — no ids, no keys).
2. Dashboard requests / cost vs mendr requests / cost.
3. Any delta, and which expected difference explains it.
4. Whether all seven checks passed.

Anything unexplained is a bug — capture the numbers and the window, not the key.
