# wave 2 DMs · cold prospects (Polar/Apollo research run, 2026-08-19)

unlike wave 1, these are COLD. nobody here has filed an issue about mendr's problem; they were picked because the research shows a direct OpenAI/Anthropic/Google API call in their product, weighted to voice and real-time agents. that's the sharpest ICP cut we have, a dead model id in a voice stack doesn't fail a batch job, it breaks a live customer call.

rule before every send: click the evidence link and confirm it's real and still says what the research claims. never cite evidence you haven't seen with your own eyes. if the link is dead or the claim is off, skip or rewrite, don't send.

if they reply and want more, the proof points to lean on: zero wrong edits across 26 real repos, it reproduced the exact fix i shipped in my own production app when gemini-2.0-flash retired, and it runs with one command, `npx mendr fix-llm <repo-or-github-url>`. the registry has dated retirements for all three providers, the near ones being oct 23 (openai kills gpt-4, gpt-3.5-turbo, gpt-4-turbo, o3-mini, o4-mini) and dec 11 (gpt-5 family).

ordered hottest first: voice infra with explicit OpenAI Realtime / model-name evidence, then the eval platforms (complementary framing, compare notes, not a sale), then the rest.

---

## 1. Retell AI · voice infra
person: Zexia Zhang, co-founder & CTO · linkedin.com/in/zexia-zhang
why: their own docs list live model replacements ("gpt-4o-realtime → replaced with gpt-realtime-1.5") · evidence: docs.retellai.com model replacements page

> hey zexia, when your docs swapped gpt-4o-realtime for gpt-realtime-1.5, did someone hand-edit every call site or did you have tooling for it? asking because the next forced migration lands oct 23, when openai shuts down gpt-4, gpt-4-turbo and o3-mini, and in a voice stack a stale model id means a dead customer call. i built mendr, a cli that finds retired model ids, rewrites them and verifies the change with your type checks and tests. happy to run it on your repo, or any public one, and just send you the diff. no signup.

## 2. Vida · voice infra (telecom)
person: Mark Lilien, CTO · linkedin.com/in/marklilien
why: public FreeSWITCH module opens a websocket to api.openai.com/v1/realtime?model=gpt-4o-realtime-preview · evidence: github.com/VIDA-Global/mod_openai_s2s

> hi mark, what happens to a carrier call in flight when openai retires gpt-4o-realtime-preview, the id your mod_openai_s2s module hardcodes in its websocket url? the oct 23 shutdowns of gpt-4, gpt-4-turbo and the o-minis show how quickly these dates arrive. i built mendr, a cli that finds retired model ids in a repo, rewrites them and verifies the edit compiles and passes tests. since mod_openai_s2s is public i can run it today and send you the diff, nothing needed from your side.

## 3. Thoughtly · voice + omnichannel
person: Alex Casella, co-founder & CTO · linkedin.com/in/axcasella
why: technical write-up says transcribed text "goes to a large language model (currently using GPT-4)", plus gpt-realtime-2 over raw websockets · evidence: ZenML LLMOps DB, Thoughtly architecture entry

> hey alex, is gpt-4 still the model behind your transcription-to-response path? the zenml write-up on thoughtly's architecture says it is, and openai kills gpt-4 on oct 23 along with gpt-4-turbo and gpt-3.5-turbo. if any live call path still pins that id, it fails with a caller on the line. i built mendr, a cli that finds retired model ids across a codebase, rewrites them and verifies the change against your tests. i can point it at your repo, or any public one, and just send the diff. no signup, no call needed.

## 4. telli · voice + omnichannel
person: Seb Hapte-Selassie, co-founder & CTO · linkedin.com/in/sebhs
why: public repo pins gpt-4o and the already-retired gemini-2.0-flash in shipped code · evidence: github.com/telli-ai/voicemail-detector

> hi seb, does voicemail-detector still reflect production? it pins gemini-2.0-flash, which google already retired, next to gpt-4o on the openai side. i hit the same gemini retirement in my own app, which is why i built mendr, a cli that finds retired model ids, rewrites them and verifies the fix with tests. openai's oct 23 shutdowns of gpt-4 and gpt-4-turbo are the next round of this. voicemail-detector is public, so i can run it right now and send you the diff. want me to?

## 5. VoiceRun · voice infra
person: Derek Caneja, co-founder & CTO · linkedin.com/in/derekcaneja
why: primfunctions.completions is a managed client fanning out to openai, anthropic and google directly · evidence: docs.voicerun.com completions page

> hey derek, when a provider retires a model id, does that surface inside primfunctions.completions or in each customer's agent code? you fan out to openai, anthropic and google under one interface, so i'm curious where the pinned strings actually live. openai retires gpt-4, gpt-4-turbo and the o-minis on oct 23, and every stale id becomes a dead call. i built mendr, a cli that finds retired ids in a repo, rewrites them and verifies the edit with type checks and tests. want me to run it on a repo of yours, or any public one, and send over the diff?

## 6. Bolna · voice infra (india)
person: Prateek Sachan, founder & CTO · linkedin.com/in/prateek-sachan
why: BYO keys for all three providers with pinned ids like gpt-5.4-mini, claude-sonnet-5, gemini-2.5-flash · evidence: bolna.ai/docs OpenAI provider page

> hi prateek, when a customer's byok agent pins gpt-5.4-mini or claude-sonnet-5 and the provider retires that id, whose problem is it, yours or theirs? your docs let people wire their own openai, anthropic and google keys, so the dead id could live on either side. openai's oct 23 shutdown of gpt-4 and gpt-4-turbo will test that boundary. i built mendr, a cli that scans a repo for retired model ids, rewrites them and verifies the change. i can run it on your codebase or any public repo and send the diff back, one command, no account.

## 7. Synthflow AI · voice agents (enterprise)
person: Sassun Mirzakhan-Saky, co-founder & CTO · synthflow.ai/authors/sassun-mirzakhan-saky (no linkedin in the research)
why: announcement says they route across "GPT-4.1, 5, and 5.1" in real time, gpt-5 family retires dec 11 · evidence: synthflow.ai BELL framework announcement

> hey sassun, what happens to synthflow's mid-call routing across gpt-4.1, gpt-5 and gpt-5.1 on dec 11, when openai retires the whole gpt-5 family? the oct 23 wave that takes out gpt-4 and gpt-4-turbo is the dress rehearsal for it. i built mendr, a cli that finds retired model ids across a codebase, rewrites them and verifies the change against your type checks and tests. glad to run it over your repo, or any public one, and send you the diff, nothing to sign up for.

## 8. Ringg AI · voice agents
person: Kali Charan Vemuru, co-founder & head of engineering · linkedin.com/in/kali-charan-vemuru
why: shipped GPT-4.6 Luna as an in-product option and their explainer references building with OpenAI's Realtime API · evidence: Ringg "GPT-4.6 in Ringg Agents" post

> hi kali, how many places in the ringg codebase pin model strings like the gpt-4.6 luna id you just shipped, or the realtime models from your explainer? old ids tend to hide in fallback paths and test fixtures, and openai retires gpt-4, gpt-4-turbo and both o-minis on oct 23. i built mendr, a cli that finds retired model ids, rewrites them and verifies the edit compiles and passes tests. happy to run it on your repo or any public one and just send the diff over. one npx command, no signup.

## 9. Newo · voice agents (smb)
person: Alex Novitsky, founder & CTO · linkedin.com/in/alex-novitsky-911483aaf
why: docs pin provider ids (google, openai, anthropic) and models (gemini25_flash, gpt4o) per skill for Gen()/GenStream() · evidence: docs.newo.ai skills / model config

> hey alex, when openai or google retires an id like gpt4o or gemini25_flash, do your 15k live agents pick that up from a central registry or does someone edit skill configs by hand? your docs show the model pinned per skill for gen() and genstream(), which is a lot of surface area. openai's oct 23 retirements of gpt-4 and gpt-4-turbo put a date on the question. i built mendr, a cli that finds dead model ids in code, rewrites them and verifies the change. i could run it against your repo, or any public one you pick, and send the diff. no account needed.

## 10. Coval · voice eval/QA (complementary, compare notes)
person: Brooke Hopkins, founder & CEO · linkedin.com/in/bnhop
why: docs say coval connects directly to OpenAI Realtime (gpt-realtime-2) and Gemini Live on customers' behalf · evidence: docs.coval.ai OpenAI Realtime connection page

> hi brooke, when coval's sims catch a provider retiring a model id like gpt-realtime-2, what do your customers actually do in the next hour? i built mendr, a cli that covers that step, finding the retired id in their code, rewriting it and verifying the fix. feels complementary rather than competitive, you catch the drift, mendr patches the call sites. with openai's oct 23 retirements coming, i suspect we're watching the same failure from two sides. up for comparing notes? i can also run it on any public repo and send you the diff as a demo.

## 11. Cekura · voice eval/QA (complementary, compare notes)
person: Shashij Gupta, co-founder & CTO · linkedin.com/in/shashij-gupta-671aa614a
why: sub-processors page names the OpenAI and Anthropic APIs, YC profile adds GPT/Claude/Gemini · evidence: cekura.ai/sub-processors

> hey shashij, when a customer's agent breaks because openai or anthropic retired the underlying model id, does that show up in cekura's sims as quality drift or as a hard failure? your sub-processors page lists both providers plus gemini, so you'll see it from every side. i built mendr, a cli that fixes the code half, finding retired ids, rewriting them and verifying the change. you surface the regression, mendr repairs the call site, so it reads complementary to me. openai retiring gpt-4 and gpt-4-turbo on oct 23 should produce plenty of both. keen to compare notes if you are.

## 12. Hamming AI · voice eval/QA (complementary, compare notes)
person: Sumanyu Sharma, founder & CEO · linkedin.com/in/sumanyusharma
why: staff backend posting lists the stack as OpenAI + Anthropic behind an LLM-enabled QA platform · evidence: Ashby, Staff Backend Engineer posting

> hi sumanyu, do hamming's simulated calls flag a retired model id before a customer's production does? your staff backend posting lists openai and anthropic behind the platform, so you're exposed to both retirement calendars. i built mendr, a cli that does the repair side, finding dead ids in code, rewriting them and verifying the edit. hamming detects, mendr fixes, which is why this is a compare-notes message, not a pitch. openai's oct 23 shutdown of gpt-4 and gpt-4-turbo should be a busy week for both of us. i can demo on any public repo and just send the diff if useful.

## 13. Toma · voice agents (auto)
person: Anthony Krivonos, co-founder & chief technician · github.com/anthonykrivonos (no linkedin in the research)
why: founder post lists public LLM APIs (openai, anthropic, google) at hundreds of calls a second, plus self-hosted openai-compatible endpoints · evidence: Anthony Krivonos stack post

> hey anthony, with hundreds of llm calls a second spread across openai, anthropic, google and your self-hosted openai-compatible endpoints, how do you keep the pinned model ids consistent when a provider retires one? dates like oct 23, when openai kills gpt-4, gpt-4-turbo and o3-mini, tend to find every forgotten fallback string. i built mendr, a cli that scans a repo for retired ids, rewrites them and verifies with your type checks and tests. want me to run it on a toma repo, or any public one, and send back the diff? no signup.

## 14. Regal.ai · contact center
person: Rebecca Greene, co-founder & CTO · linkedin.com/in/rebecca-greene-31b98513
why: developer docs recommend GPT-4o Mini as the default model, with GPT-4.1, Claude and Gemini selectable · evidence: developer.regal.ai LLM models page

> hi rebecca, when openai retires a model id, what happens to regal customer agents still pinned to it? your docs recommend gpt-4o mini as the default with gpt-4.1, claude and gemini selectable, which means a lot of per-agent model strings in the wild. oct 23 makes it concrete, that's when gpt-4, gpt-4-turbo and gpt-3.5-turbo go dark. i built mendr, a cli that finds retired ids in code, rewrites them and verifies the change passes tests. if useful i can run it against a repo you choose, yours or any public one, and send the diff over. nothing to sign up for.

## 15. Flip · voice agents (vertical)
person: Joe Garlick, lead architect · linkedin.com/in/joe-garlick-b8b8b1117
why: release notes describe call transcripts embedded in a prompt "submitted to OpenAI's LLM", multi-provider in production · evidence: flipcx.com AI CSAT release

> hey joe, which model id is flip's transcript pipeline pinned to these days? your release notes describe embedding call transcripts in a prompt submitted to openai's llm, and pipelines like that are where old ids quietly linger. openai retires gpt-4, gpt-4-turbo and gpt-3.5-turbo on oct 23, so anything still pinned to that era stops working mid-call. i built mendr, a cli that finds retired model ids, rewrites them and verifies the edit against your tests. glad to run it on a flip repo or any public one and simply send you the diff. one command, no account.

## 16. SuperDial · voice agents (healthcare)
person: Harrison Caruthers, co-founder & CTO · linkedin.com/in/harrison-caruthers-88777792
why: engineering talk write-up says superdial relies on openai with explicit fallback mechanisms, alongside deepgram and pipecat · evidence: Opus Research SuperDial technical blueprint

> hi harrison, do superdial's fallback mechanisms cover a retired model id, or just timeouts and rate limits? the opus research write-up says you lean on openai with explicit fallbacks for payer calls, and a dead id fails every request, so logic keyed on transient errors won't catch it. openai shuts down gpt-4, gpt-4-turbo and the o-minis on oct 23. i built mendr, a cli that finds retired ids in a repo, rewrites them and verifies the fix. happy to point it at your codebase, or any public repo, and send you the diff. zero setup on your end.

## 17. Spara · GTM agents (voice + chat)
person: Zander Pease, co-founder & CTO · linkedin.com/in/alexanderpease
why: product page says spara trains and evaluates a pipeline of openai models per customer, eng posting adds anthropic · evidence: Ashby Senior AI Engineer posting

> hey zander, when openai retires a model, how many of spara's per-customer pipelines need re-pinning at once? your product page says you train and evaluate a pipeline of openai models per company, with anthropic in the stack per your eng posting. oct 23 is the next such date, gpt-4, gpt-4-turbo and gpt-3.5-turbo all go dark. i built mendr, a cli that finds retired model ids across a codebase, rewrites them and verifies the change. if you're curious i can run it on a repo of yours or any public one and just send you the diff. no signup, no deck.

## 18. Attention · revenue AI (calls)
person: Matthias Wickenburg, co-founder & CTO · linkedin.com/in/matthias-wickenburg-5117288b
why: workflow docs expose "Ask OpenAI (ChatGPT)" and "Ask Anthropic (Claude)" as first-class action steps · evidence: docs.attention.com action steps

> hi matthias, are the model ids behind your ask openai and ask anthropic workflow steps pinned in code or configurable per workflow? when openai retires gpt-4, gpt-4-turbo and o3-mini on oct 23, any step still pointing at an old id starts erroring inside customer workflows, which is an ugly place to debug. i built mendr, a cli that finds retired model ids, rewrites them and verifies the edit with type checks and tests. i can run it on your repo, or any public repo you name, and send over the diff. nothing to sign up for on your side.

## 19. Liberate · voice agents (insurance)
person: Ryan Eldridge, co-founder & CTO · linkedin.com/in/ryan-eldridge-6776381
why: official OpenAI select partner bringing "OpenAI's frontier models" into regulated insurance workflows · evidence: liberate.ai OpenAI select partner announcement

> hey ryan, how do you handle model-version changes inside regulated claims workflows, where a carrier presumably wants to know exactly which model touched a claim? liberate ships openai frontier models with core-system write-back, and openai's oct 23 retirements of gpt-4 and gpt-4-turbo will force that migration whether the paperwork is ready or not. i built mendr, a cli that finds retired model ids, rewrites them and verifies the change, leaving a reviewable diff that doubles as the audit trail. want me to run it on a repo you pick, yours or any public one, and send the diff? one command.

## 20. Listen Labs · AI voice interviews
person: Florian Juengermann, co-founder & CTO · linkedin.com/in/juengermann
why: engineering blog details a key-swapping proxy in front of the Claude Agent SDK forwarding to api.anthropic.com · evidence: listenlabs.ai/blog Claude Agent SDK proxy post

> hi florian, does the key-swap proxy in front of your claude agent sdk setup also pin the claude model ids, or do those live in each interview pipeline? anthropic retires models on dated schedules just like openai does, and with under 20 engineers a forced migration lands on whoever is on call that week. i built mendr, a cli that finds retired model ids, rewrites them and verifies the change with your tests, anthropic ids included. i can run it on any repo you point me at, a public one works fine, and send you the diff. no signup involved.

---

## send sequence (4 per day, hottest first, weekdays only)

- day 1 · thu aug 21: Retell (Zexia), Vida (Mark), Thoughtly (Alex C), telli (Seb)
- day 2 · fri aug 22: VoiceRun (Derek), Bolna (Prateek), Synthflow (Sassun), Ringg (Kali)
- day 3 · mon aug 24: Newo (Alex N), Coval (Brooke), Cekura (Shashij), Hamming (Sumanyu)
- day 4 · tue aug 25: Toma (Anthony), Regal (Rebecca), Flip (Joe), SuperDial (Harrison)
- day 5 · wed aug 26: Spara (Zander), Attention (Matthias), Liberate (Ryan), Listen Labs (Florian)

tracking: this file is the tracker, when a dm goes out append [sent m/d] to that company's heading, and change it to [replied m/d] when they answer.
