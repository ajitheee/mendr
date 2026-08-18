# X posts

three posts, spread across the week (see README). no links in the main post, drop the link in the first reply for reach.

---

## X post 1 — day 5

a model id gets retired and every call 404s. openai flips o1 to max_completion_tokens and your requests 400. knowing it broke is the easy part. going and fixing every call site by hand is the part that eats your afternoon.

built a cli that does the fixing, gated on your tests. dm me if this keeps biting you.

---

## X post 2 — day 7

most 'api change' tools just alert you. cool, now i know my prod is already broken.

mendr actually rewrites the call sites. it swaps the dead model id and renames the param only on the models that need it, and it won't show you the diff until it passes type-check and tests. ts/js today.

---

## X post 3 — day 6

honest question for people building on openai/anthropic/gemini: how are you handling model retirements right now?

is it 'pin the snapshot and pray' or 'wait for the 400 in prod and swap it by hand'? asking because i built a thing to auto-fix it and i want to know what people actually do today.
