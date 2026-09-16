`co3.py:49-60`:

```python
    def identify_interlocutor_with_gpt3(self, prompt):
        response = openai.Completion.create(
            model="gpt-3.5-turbo-instruct",
            prompt=prompt,
            temperature=0,
            max_tokens=16,
            ...
            echo=True # XXX: to get the full output
        )
```

OpenAI lists `gpt-3.5-turbo-instruct` for shutdown on **2026-09-28** — 12 days from today (filing this 2026-09-16). Source: https://developers.openai.com/api/docs/deprecations. After that date, requests naming that model stop being served.

It is not dead code. Path to it, each hop read rather than inferred (line numbers are call sites, not definitions):

`co3.py:403` `if __name__ == '__main__'` → `main(args)` → `CO3.run()` → the per-row loop at `co3.py:114` → `_collect_dialogue` called at `co3.py:125` → `_generate_dialogue` called at `co3.py:238` → `set_prompt_for_dialogue` called at `co3.py:159` → `identify_interlocutor_with_gpt3` called at `co3.py:80`.

That last hop is the `else` branch of the test at `co3.py:72`. `speakers` is always built with all three keys at `co3.py:158` (`{'x': data_input['x'], 'y': data_input['y'], 'z': data_input['z']}`), so the `'y' in speakers.keys()` half is always true and the branch turns entirely on `data_input['y']` being an empty string. I haven't measured how many ATOMIC10x rows have an empty `y`, so I can't tell you what share of a run lands here — you'd know that far better than I would. But the call is on the normal path, not behind a flag.

Worth flagging separately: this id is hardcoded and is not governed by `--model`. Passing a current model on the command line still hits this call.

Second exposure, same date. The `--model` default at `co3.py:420-423`:

```python
    parser.add_argument('--model',
                        type=str,
                        default='gpt-3.5-turbo-1106',
                        help='which LLM to use')
```

That value reaches `openai.ChatCompletion.create(model=self.args.model, ...)` at `agents/gpt.py:87-90` with no reassignment in between — `co3.py:37-38` constructs `ChatGPTBaseAgent(args.__dict__)`, and the `if not hasattr(self.args, 'model')` guard at `agents/gpt.py:71` is false because argparse always populates it. `gpt-3.5-turbo-1106` is also the id in the documented run command at `README.md:42`. Same 2026-09-28 shutdown.

What I am deliberately not claiming:

- `gpt-4-0613` at `agents/gpt.py:72` has a dated shutdown, but I don't believe it is live here — it sits behind the `hasattr(self.args, 'model')` guard above, which is never true on the only construction path, so the assignment never runs. Not part of this report.
- `text-davinci-003` at `agents/gpt.py:14` is reached (that guard tests `'engine'`, and `'engine'` appears nowhere else in the repo as an args key, so the guard is always true and it overwrites `args.model` on the `GPT3BaseAgent` path — looks like the key is a typo for `'model'`), but it has no dated deadline, so I'm making no dated claim about it. Might be worth its own look.
- Nothing else in the repo.

Also honest about the state of things: `environment.yml` pins `openai==0.27.6` and the code uses the v0.x surface, so the repo is already on an old SDK and anyone running it today has other work to do first. That doesn't change the finding — the request still resolves to the same model id and will start failing after the 28th.

Checked on `main`, latest push 2026-01-23.

On a PR: happy to open one, but I won't pick the replacement model — that's a cost and behaviour call, and it's yours. `identify_interlocutor_with_gpt3` passes `echo=True` ("to get the full output") and the return value is used as a prompt downstream at `co3.py:80`, so that call site isn't a one-line id swap and the substitution could change the generated data. If you decide what you want it to be, I'll do the mechanical part.

*Found with a scanner I run that checks pinned model ids against published provider shutdown dates; it flagged this one for human review and would not change it automatically.*