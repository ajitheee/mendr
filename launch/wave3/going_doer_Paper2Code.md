`o3-mini` and `o4-mini` are both on OpenAI's shutdown list for **2026-10-23** (source: https://developers.openai.com/api/docs/deprecations). After that date, calls naming them return `404 model_not_found`. Both are hardcoded as defaults here, and the first one is what the documented Quick Start runs.

## `o3-mini` — reached by the documented Quick Start

`scripts/run.sh:3`

```sh
GPT_VERSION="o3-mini"
```

That value is passed as `--gpt_version ${GPT_VERSION}` into `1_planning.py` (run.sh:28), `2_analyzing.py` (:41) and `3_coding.py` (:47). In `1_planning.py`, argparse binds it at line 12, line 23 assigns `gpt_version = args.gpt_version`, and line 249 calls `api_call(trajectories, gpt_version)`, landing in `api_call` at 216-222:

```python
def api_call(msg, gpt_version):
    if "o3-mini" in gpt_version:
        completion = client.chat.completions.create(
            model=gpt_version,
            reasoning_effort="high",
            messages=msg
        )
```

Identical bodies at `2_analyzing.py:138-150` and `3_coding.py:136-148`. `scripts/run_latex.sh:3` sets the same variable.

So on 2026-10-23, `cd scripts && bash run.sh` fails at the planning stage for anyone who has not edited `GPT_VERSION`.

## `o3-mini` — also reached by the documented eval commands

Both evaluation snippets in the README (the ref-free block and the ref-based block) invoke `python eval.py` **without** `--gpt_version`. That falls through to `eval.py:243`:

```python
argparser.add_argument('--gpt_version', type=str, default="o3-mini")
```

which reaches the live request at `eval.py:116-138`. Copy-pasting either README command after 2026-10-23 fails with no flag involved.

The same `"o3-mini"` default is set at `2_analyzing.py:14`, `3_coding.py:14` and `3.1_coding_sh.py:13`, so running those directly hits it too.

## `o4-mini` — a default in a script nothing invokes

`codes/4_debugging.py:109-114`

```python
parser.add_argument(
    "--model",
    type=str,
    default="o4-mini",
    help="OpenAI chat model used for debugging.",
)
```

`args.model` has exactly one consumer in that file — `model=args.model` in the `client.chat.completions.create(...)` at line 249 — so the default is a real selector, not a string. To be clear about its reach, though: `4_debugging.py` is not called by any script in `scripts/` and is not mentioned in the README, so it is only hit by running it directly. Lower impact than the two above; flagging it because it is the same date and the same one-line fix.

None of these is behind a version check, an env override, or a fallback.

## Things I am deliberately *not* reporting

A grep of this repo turns up plenty of other retiring ids, and they are all fine:

- `gpt-4-0613` in `codes/utils.py` is a member of the `tokens_per_message` set at :327 and the recursive fallback at :346 — tiktoken boilerplate inside `num_tokens_from_messages`, which never touches an `openai` client. Nothing to fix.
- The retiring ids in the `cal_cost` price table (`utils.py:153-237`, e.g. `o3-2025-04-16` at :209) are a lookup table, not model selection.

I also have not run the pipeline against your account — this is about the published shutdown date, not about anything failing today.

Checked at `ba91699` ("Fix README typo", 2026-03-25), current HEAD.

## Offer

If it is useful, I can send a mechanical PR: the two shell variables plus the five argparse defaults (`2_analyzing.py:14`, `3_coding.py:14`, `3.1_coding_sh.py:13`, `eval.py:243`, `4_debugging.py:112`) changed to whatever id you name, nothing else touched. I have not picked a replacement because these are reasoning-model call sites using `reasoning_effort="high"` — cost per run and output behaviour both move with that choice, and the README quotes a specific per-run cost, so it seems like your call rather than mine. If you would rather not pin a new id at all, the smaller change is to drop the hardcoded defaults and fail with a clear message when `--gpt_version` / `--model` is unset. Either way, the report above stands on its own.

*Method, for disclosure: I run a scanner that checks pinned model ids against published shutdown dates. It missed these at first — it was treating a CLI `default=` as documentation rather than as the value the program runs with — and this repository is what showed me the gap; it reports them for review now. Every line above I confirmed by reading the files.*