# personalized DMs

each one cites the person's real issue. lead with the question, offer the diff. don't blast them all at once, follow the day-by-day order in README.md.

---

## day 1

### Vysp3r (airi) — email dev@vysp3r.com / GitHub
why: airi #2249 is the exact max_completion_tokens param break mendr fixes, and his email is public. highest intent plus reachable.

> hey, saw airi #2249 where openai validation blows up on the models that now demand max_completion_tokens. how are you handling that right now, hardcoding per-model or catching the 400 and retrying? i built a little cli called mendr that renames that param only on the models that need it, and it traces the model arg at each call site so it leaves the ones still on max_tokens alone. it already fixed the same class of break in my own app. happy to run it against airi and just send you the diff if it's useful, no signup or anything.

### azanux / Charles Azanlekor (Grydl) — X @cazanlekor
why: filed embabel #1759 and is hand-removing retired Gemini 2.0 ids right now, at a real company.

> saw #1759 where you're pulling the retired gemini 2.0 ids out by hand. how often does that come up for you at grydl, basically every time google retires something? i made a cli, mendr, that does that swap automatically and only touches the actual model call sites, then gates the change on type-check and tests before it shows you a diff. it never writes to your tree unless you want it to. want me to run it on embabel-agent and send the diff so you can see if it'd have saved you the manual pass?

### valentinfrlch (ha-llmvision) — GitHub
why: solo dev across 10+ providers who documented two failure modes in #617 plus an earlier Gemini v1beta 404. every provider change breaks his end-users.

> hey, #617 caught my eye, groq's maverick deprecation and the gpt-oss content-shape 400 hitting you in the same issue, and you'd already eaten the gemini v1beta 404 earlier. across 10+ providers how do you even keep up, is it mostly reacting once a user reports their automation broke? i built mendr to catch the retirements and the param/shape breaks before the 400. want me to point it at llmvision and send you whatever it finds? genuinely no strings.

---

## day 2

### evalstate / Shaun Smith (fast-agent, ~3.9k stars) — GitHub
why: framework author hit by the Azure max_tokens/max_completion_tokens split in #461. one silent param rename breaks all his users at once.

> fast-agent #461, the azure max_tokens vs max_completion_tokens split biting the gpt-5-nano+ endpoints. right now are you hand-encoding which endpoints need which param? that per-model matrix is the exact thing i've been maintaining. mendr resolves the model at each call site and only renames the param where that model needs it, so a framework doesn't have to learn it from 400s. i know maintainers usually want to own this in-house, so no pressure, but if it's useful i can just send you the rules i've got as a registry.

### decolua (9router) — GitHub
why: builds an LLM router that eats every provider param flip. PR #1054 is the max_completion_tokens switch 400ing his model tests.

> 9router #1054, openai now forcing max_completion_tokens and 400ing your model tests. as a router you eat every one of these param flips, so how are you keeping the matrix current, manually per provider? mendr tracks which models need which param and rewrites the call sites conditionally, gated on your tests so nothing lands red. might save you chasing each one down. want me to run it against 9router and show you what it'd change?

### llm-exe — GitHub
why: TS library whose defaults broke on the Gemini retirement in #231. clean auto-fix target.

> llm-exe #231, google's gemini-2.0-flash and -lite retirement breaking your library defaults. since it's a ts library, how are you deciding when to bump the default vs let users override it? i built mendr, it's ts-native, and it opens the tested fix pr for exactly this kind of retirement. it won't touch model ids that are sitting in data like config tables or arrays, only the ones in an actual call. want a diff against llm-exe to see if it's worth anything to you?

---

## day 4

### talibilat / Mohammed Talib (Factor, limit-bar) — X @talibilatt / LinkedIn
why: building a model-deprecation tracker, so he lives in this pain daily. complementary (he tracks, mendr fixes).

> you're building limit-bar to track deprecations and price changes, so you basically live in this stuff. quick question, once you know a model's dead, how much of the pain is the finding vs actually going and fixing every call site? that second half is what i've been working on. mendr auto-rewrites the code (model id swaps, per-model param renames) and only calls it a fix once it passes type-check and tests. feels like our two things are complementary more than competing. would you be up for comparing notes?

### Sudharsana V. (Reps.ai, llm-model-deprecation) — dev.to comment / GitHub
why: strongest raw buying signal on the sheet. felt a prod outage badly enough to build a flag-only tracker.

> read your post about prod breaking on a model deprecation, the one that pushed you to build llm-model-deprecation. where does the cli stop for you, is it flag-only or do you also try to patch the code? i went at the fixing half. mendr takes a dead id or a per-model param break and rewrites the call sites, gated on tests so it never lands a red diff. curious where yours hits its limit at reps.ai, and honestly whether the auto-fix part would help or just get in the way.

### danny-avila (LibreChat) — GitHub / LibreChat Discord
why: google retiring gemini-2.0-flash blew up defaultModels for thousands of self-hosters (#12444). logo/design-partner even if he tolerates it with config PRs.

> saw #12444 where google retiring gemini-2.0-flash blew up defaultModels for a bunch of self-hosters. keeping those defaults valid across five providers has to be a constant treadmill, how are you tracking which ids are about to die? i made a cli that opens the bump pr before the model actually retires, with the swap already verified against type-check and tests. would something like that be worth wiring into librechat, or do the config PRs from contributors already cover it well enough?

---

## day 6

### evilpan (gptcli) — email i@pppan.net / X @evilpan_
why: ships code calling the retired gemini-2.0-flash, so an imminent 404, and has strong public contact.

> heads up, gptcli still calls gemini-2.0-flash which google's retired, so it'll 404 on new keys. are you planning to swap it manually or wait for someone to file it? i built mendr, a cli that opens the tested swap pr the moment a model goes dead, and it only touches real call sites, not a model id that's being used as a plain string somewhere. happy to just run it on gptcli and send you the diff if that's easier than doing it by hand.

### yohkuri / Yohsuke Kurita (cz-git) — GitHub
why: popular dev tool broke on the max_completion_tokens param change (#261). specific, mechanical, TS.

> cz-git #261, the ai request failing on models that now need max_completion_tokens. do you want to special-case that per model, or is it just annoying to keep track of which ones need it? mendr does the param rename only on the models that require it and verifies against tests before showing a diff, so your ai commits stop 400ing without you babysitting the list. happy to run it on cz-git and send you the change if it helps.

### archer-eric (simonw/llm) — GitHub
why: reported the exact o1 max_tokens rejection on a very popular tool (#724).

> saw #724 on simonw/llm, o1 rejecting max_tokens in favor of max_completion_tokens. are you patching that yourself or waiting on upstream? i made a cli, mendr, that renames the param only on the models that actually need it so it leaves the older ones alone, and it checks the change compiles and passes tests first. curious if that per-model param break hits you often enough to be worth a tool, or if it's rare enough that hand-fixing is fine.

---

## day 7

### bootrecords / Stefan Tiwari (alcemy, opencrabs) — GitHub
why: hit the max_completion_tokens split in #1059 and works at a company, so a better paid-pilot bet.

> opencrabs #1059, being forced onto max_completion_tokens. how are you handling that at alcemy, one hardcoded switch or per-model? i built mendr to apply that rename conditionally, only where the model needs it, and gate it on tests so nothing lands red. if it'd save you the manual pass i can run it on opencrabs and send you the diff to look at.

### stevechoi0222 (DeepTutor, HKUDS) — GitHub
why: marked #54 high-severity himself: gpt-5.x/o1/o3/4o all rejecting hardcoded max_tokens.

> saw you marked DeepTutor #54 high-severity, gpt-5.x, o1, o3 and 4o all rejecting the hardcoded max_tokens. are you going through and swapping those by hand right now? mendr does that per-model, only touching the calls whose model actually needs max_completion_tokens, verified against type-check and tests before it shows any diff. want me to run it on deeptutor and just send you what it'd change?
