# reddit posts

two posts. the first is a listening question for day 1 (don't lead with the tool, drop it in a comment only if asked). the second is a show-and-tell for day 5.

---

## day 1 — r/LLMDevs (listening post)

**title**

how do you all handle model retirements without it breaking prod?

**body**

genuine question because i keep getting caught by this. a model id gets retired and every call 404s, or openai flips o1 over to max_completion_tokens and requests start 400ing. i've mostly been finding out when something breaks in prod, which is not a great system.

what do you actually do? pin snapshots and hope? put an alert on some deprecation feed? just eat the 400 and swap the id by hand when it happens?

i got annoyed enough that i built a small cli that finds the dead ids and the per-model param breaks in a repo and rewrites the call sites, gated on tests so it won't land anything red. i'll drop it in a comment if anyone wants to poke at it, but honestly i'm more interested in how people are handling this today, because it feels like everyone's quietly reinventing the same duct tape.

---

## day 5 — r/LocalLLaMA (show and tell)

**title**

i built a cli that auto-fixes your code when an llm model gets deprecated

**body**

sharing this because a lot of people here build tooling on hosted models and hit the same wall i did.

every time a provider retires a model id, or renames a param like max_tokens to max_completion_tokens on the newer models, you have to go find every call site and fix it. knowing it broke is the easy part. the tedious part is the fixing.

so i made mendr. it's a local cli, you point it at a repo and it rewrites the dead model ids and the per-model param breaks, then only shows you the diff after it passes type-check and your tests. it never writes to your tree on its own. `npx mendr fix-llm .` to try it.

the thing i spent the most time on is not breaking your code. it's call-site aware, so it won't touch a model id that's sitting in a pricing table or a model-picker list, only the real api calls. and for param fixes it checks which model each call uses before removing anything, so it won't strip temperature off a call that's still allowed to have it.

it's ts/js first, python not yet. it's brand new so i'm running it on real repos before i polish anything. if you've got one that got bitten i'll run it and send you the diff, no signup. and i'd love to hear how you're dealing with this now.
