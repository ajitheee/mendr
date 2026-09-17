`tinytroupe/config.ini:18-22`

```ini
# The main text generation model, used for agent responses
MODEL=gpt-5-mini

# Reasoning model is used when precise reasoning is required, such as when computing detailed analyses of simulation properties.
REASONING_MODEL=o3-mini
```

The same id is hardcoded as the fallback in `tinytroupe/__init__.py:98-100`:

```python
self._config["reasoning_model"] = config["OpenAI"].get(
    "REASONING_MODEL", "o3-mini"
)
```

OpenAI retires `o3-mini` on **2026-10-23** — 36 days from today (2026-09-17). Source: https://developers.openai.com/api/docs/deprecations

### It reaches the API, it isn't a leftover string

1. `MANIFEST.in:1` (`recursive-include tinytroupe *.ini`) plus `include-package-data = true` in `pyproject.toml:7` ship `tinytroupe/config.ini` with every install, and `tinytroupe/utils/config.py:120-124` raises if it's missing. A user config in cwd only overrides the keys it actually sets (`config.py:131-133`), so an install that doesn't set `REASONING_MODEL` keeps `o3-mini`; if the key were absent entirely, `__init__.py:99` supplies the literal anyway. No other `config.ini` in the repo sets `REASONING_MODEL`.
2. `tinytroupe/experimentation/proposition.py:432-436` returns `config_manager.get("reasoning_model")`.
3. `proposition.py:171` and `:286` do `model = self._model(self.use_reasoning_model)` and pass it into `LLMChat(..., model=model)` at `:219` and `:369`.
4. `LLMChat` collects that as a `**model_params` entry (`utils/llm.py:144`, `:192`) and hands it to `client().send_message(...)` at `llm.py:553`, which builds `chat_api_params` at `clients/openai_client.py:266-284` and calls `_raw_model_call(model, chat_api_params)` at `:332`.
5. `_raw_model_call` (`openai_client.py:403`) takes the reasoning branch at `:409` — `_is_reasoning_model` is `"o1" in model or "o3" in model` (`:459`) — strips `stream`/`temperature`/`top_p`/penalties and sets `reasoning_effort`, then issues the request at one of the two provider call sites in that function:

```python
# openai_client.py:435
if "response_format" in chat_api_params:
    ...
    result_message = self.client.beta.chat.completions.parse(**chat_api_params)   # :449
    ...
else:
    ...
    return self.client.chat.completions.create(**chat_api_params)                 # :457
```

Proposition evaluation takes the `:449` branch: `LLMChat` sets `response_format` to `{"type": "json_object"}` at `llm.py:421` for its `bool` (`proposition.py:216`) and `int` (`:365`) output types, and `send_message` forwards it into `chat_api_params` at `openai_client.py:280-281`.

### Scope, stated accurately

`use_reasoning_model` defaults to `False` (`proposition.py:25`), and nothing in the repo sets it to `True` — no test, no example, no notebook. So this does not affect the default agent loop. It is, however, a public constructor parameter, documented at `proposition.py:49` as "whether to use a reasoning model to evaluate the proposition" and published in the API docs under `docs/api/tinytroupe/experimentation/`, so anyone who opts in after 2026-10-23 gets a hard failure from a model OpenAI no longer serves. Worth noting the asymmetry too: `MODEL` in that same file has been moved forward to `gpt-5-mini` while `REASONING_MODEL` was left at `o3-mini`.

One thing I am deliberately not reporting: the other retired ids in this codebase (`gpt-4-0613`, `gpt-4-32k-0314`, `gpt-4-32k-0613`, `gpt-3.5-turbo-16k-0613`) all live in the tiktoken table inside `_count_tokens` at `openai_client.py:580-614`, or in test fixtures. Those are data and docstrings, not provider requests, and they need no action.

Checked against `main` at `a6244b35` (Release 0.7.0, 2026-03-28). `REASONING_MODEL=o3-mini` is also unchanged on `development`. SUPPORT.md asks for a duplicate search first; I searched issues in all states for `deprecated`, `retirement`, `shutdown`, `o3-mini`, and `REASONING_MODEL` and found nothing on this — the only `o3-mini` hit is #41, which is about local LLMs.

Happy to open a one-line PR changing the default and updating the comment, but picking the replacement is a cost and behaviour judgement. Your note on #142 about `-mini` tiers being chosen because TinyTroupe makes a lot of model calls suggests that choice has constraints I can't see from outside, so I'd rather you name the id — tell me which one and I'll send the PR.

*Found with a scanner I run that checks pinned model ids against published provider shutdown dates; it flagged this one for human review rather than changing it.*