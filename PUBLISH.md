# publishing mendr

## where things stand

- the repo is public. done.
- all the work is on `main` (the engine, the github action, the landing page, the launch kit). done, pushed.
- the name is `mendr`. it's free on npm, and the taken mendr.com domain doesn't affect the package or a hosted site.

what's left is the stuff only you can do, because it touches your npm account and your identity. each one is a single command or click.

## 1. publish the cli to npm

```sh
npm login
npm publish --access public
```

run this from the repo root. `prepublishOnly` builds and runs the tests first, so a broken build won't publish. then check it on a clean install:

```sh
npx mendr@latest fix-llm .
```

it should print a scan result, not "command not found".

## 2. tag the action so `@v1` resolves

```sh
git tag v1
git push origin v1
```

now `uses: ajitheee/mendr/mendr-action@v1` in someone's workflow resolves to this code. when you ship changes later, move the tag: `git tag -f v1 && git push -f origin v1`.

## 3. the landing page on vercel

the `vercel.json` in the repo tells vercel to skip the build and serve `site/`, so the deploy that was failing should now succeed on its own once it picks up the new commit on `main`. if it still errors, open the vercel project settings and either clear any "Output Directory" override (let vercel.json win) or set Output Directory to `site` and Framework Preset to "Other". the url will be something like `mendr-xxxx.vercel.app`; that's the link to put in your posts.

note: this is only for the marketing page. the cli itself is not a vercel deploy, it ships through npm in step 1.

## 4. then launch

everything in `launch/` is ready. publish the npm package before you post the Show HN (day 3) so `npx mendr` works for anyone who reads it. the DMs work even before you publish, because they offer to run mendr on the person's repo and send them the diff.

## the one command a stranger runs

```sh
npx mendr fix-llm .
```
