# Show HN

post in the US morning. then live in the thread all day and answer every comment fast. requires the npm package to be published first.

**title**

Show HN: Mendr, a CLI that auto-fixes your code when an LLM model gets retired

**body**

i kept getting bitten by llm api breaks. a model id gets retired and every call 404s, or openai decides o1 needs max_completion_tokens instead of max_tokens and your requests start 400ing. the annoying part was never knowing it happened. it was going and fixing every call site by hand.

mendr is a local cli that does the fixing. you point it at a repo and it finds the dead model ids and the per-model param breaks. then it rewrites the call sites and only shows you the change after it passes type-check and your tests. it never writes to your working tree on its own, it emits a unified diff you read first. `npx mendr fix-llm .` to try it, and there's a github action if you want it to open the PR for you in CI.

the part i cared most about getting right is precision. it's call-site aware, so it only swaps a model string when it's actually an argument to a recognized llm call, not when the same id is sitting in a pricing table or a model-picker array. for param fixes it traces the model arg at each call site and only strips or renames a param if that specific model needs it, so a claude-opus call gets temperature removed while a sibling haiku call keeps it.

i validated it on 26 real public repos. after making it call-site aware it made 0 wrong edits. an earlier blind string-swap version made 8 wrong edits out of 17 fired, which is exactly what pushed me to build the guardrails and the test gate. 76 tests now. detection is a maintained deprecation registry checked against the providers' live model catalogs, since retirements don't show up in any openapi spec.

honest about the limits. it's typescript/js first today, python isn't scanned yet. it only catches inline literal model strings and one-hop consts, so env-var or concatenated model names are invisible on purpose, i'd rather miss one than corrupt your code. coverage is openai, anthropic and google model ids and coupled params, plus stripe renames.

it's brand new and i have no users yet, just the one production breakage that made me build it. if you've been bitten by a model retirement or the max_tokens rename, i'll run it against your repo and send you the diff. and i'd genuinely like to hear how you handle this today, because 'wait for it to 400 in prod' seems to be the common answer and that's rough.
