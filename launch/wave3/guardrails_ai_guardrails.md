**Describe the bug**

`guardrails/llm_providers.py:149` binds a model id that OpenAI has scheduled for shutdown:

```python
145 class LiteLLMCallable(PromptCallableBase):
146     def _invoke_llm(
147         self,
148         text: Optional[str] = None,
149         model: str = "gpt-3.5-turbo",
150         messages: Optional[List[Dict]] = None,
151         *args,
152         **kwargs,
153     ) -> LLMResponse:
```

That bound default flows unmodified into a real provider request 59 lines later:

```python
208         response = completion(
209             model=model,
210             *args,
211             **kwargs,
212         )
```

where `completion` is `litellm.completion` (imported at `llm_providers.py:170`).

OpenAI lists `gpt-3.5-turbo` for shutdown on **2026-10-23** — 36 days from today (2026-09-17). Source: https://developers.openai.com/api/docs/deprecations

After that date, any caller that lands on this default gets a hard provider error, surfaced as `PromptCallableException` (`guardrails/classes/llm/prompt_callable.py:36`).

**To Reproduce**

No RAIL spec needed — this is a runtime-arguments case.

```python
from guardrails import Guard
from litellm import completion

guard = Guard()
guard(completion, messages=[{"role": "user", "content": "hello"}])   # no model=
```

The default is reached, not dormant:

1. `guard.py:623-624` — `if llm_api is not None or kwargs.get("model") is not None: api = get_llm_ask(llm_api, *args, **kwargs)`. The first disjunct is satisfied by `llm_api=completion` alone.
2. `llm_providers.py:526-527` — `if llm_api == completion or (llm_api is None and kwargs.get("model")): return LiteLLMCallable(*args, **kwargs)`. Again the first disjunct requires no model, so `LiteLLMCallable` is built with no `"model"` key in `init_kwargs` (`get_llm_ask` injects only `temperature=0`, line 521).
3. `classes/llm/prompt_callable.py:30-34` — `self._invoke_llm(*self.init_args, *args, **self.init_kwargs, **kwargs)`. Neither dict carries `model`, so Python binds the signature default.
4. Line 149 binds `"gpt-3.5-turbo"`; lines 208-212 send it.

I also checked that nothing upstream supplies a model first: no code under `guardrails/` assigns into `kwargs["model"]`, calls `kwargs.update({"model": ...})`, or uses `setdefault("model", ...)` on this path, and `guardrails/run/` never sets a `model` key at all. The only other `model` references inside `_invoke_llm` are the two tracing dicts at `:184` and `:198`, which read `model` but never set it. And I replicated the signature plus the dispatch against a stub `completion` to confirm what actually goes out: `gpt-3.5-turbo`.

**Expected behavior**

Either the default resolves to a model with no published shutdown date, or `model` becomes required on this path so the failure is a clear argument error at call time rather than a provider error that starts on 2026-10-23.

**Libraries used w/ versions:**

`guardrails-ai==0.11.0` (latest release at time of filing). I read the file at tag `v0.11.0` and on `main` @ `06d0ff2c` — the line numbers above are identical in both, so this is in the released wheel and not only on `main`.

**Environment details:**

Not environment-specific — this is a static read of the source, and the trigger is the calendar, not the platform.

**Additional context**

Two things that may widen the fix:

- The async twin has no `model` parameter at all (`llm_providers.py:633-641`, `AsyncLiteLLMCallable.invoke_llm(self, text=None, instructions=None, messages=None, *args, **kwargs)`), and its `acompletion(*args, **kwargs)` call passes through whatever the caller gave. So for identical caller input with no `model=`, the sync path substitutes `gpt-3.5-turbo` and the async path leaves the choice to litellm — the two diverge today, independently of the date.
- The same id is recommended in the project's own docs: the docstrings at `llm_providers.py:162` and `:650` both show `model="gpt-3.5-turbo"`, as do several notebooks under `docs/how_to_guides/` (`streaming.ipynb`, `streaming_structured_data.ipynb`, `async_streaming.ipynb`, `remote_validation_inference.ipynb`).

One thing I checked and am deliberately *not* reporting, so it doesn't get swept in: the `gpt-4` / `gpt-4-0613` occurrences in `utils/openai_utils/streaming_utils.py:37-42` are the verbatim OpenAI-cookbook token-counting table. They compute locally via `tiktoken`, never touch the network, and nothing in the repo imports that module — a retirement cannot break them.

I searched open and closed issues and PRs for prior reports of model retirement before filing and found none. (#1638 / `update-hub-retirement-date` is about the Guardrails Hub sunset, not OpenAI model deprecations.)

Happy to open a PR for the mechanical part — making `model` explicit, or raising at construction when it's absent. Which model id should replace the default is a cost and behaviour decision for this project, so I'd leave that choice to you rather than pick one in a patch.

*Found with a scanner I run that checks pinned model ids in source against published provider shutdown dates; it flagged this one for human review rather than changing it.*