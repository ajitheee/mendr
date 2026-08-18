# publishing mendr

these are the steps only you can do, because they touch your npm and github accounts. i've set everything up so each one is a single command or a single click. do them in order.

## 1. push this branch

```sh
git push -u origin ship/installable-cli
```

then open a PR into main and merge it (or fast-forward main locally and push). the engine changes and the github action live on this branch.

## 2. check the npm name is free

```sh
npm view mendr
```

if it returns "npm ERR! 404", the name `mendr` is free and you're good. if it returns a package, the name is taken, so scope it: change `"name": "mendr"` in package.json to `"@ajitheee/mendr"` (publishConfig.access is already set to public), and update the `npx mendr` references in README.md, launch/, and mendr-action to `npx @ajitheee/mendr`.

## 3. publish to npm

```sh
npm login
npm publish --access public
```

`prepublishOnly` builds and runs the tests first, so a broken build won't publish. after it's up, sanity-check on a clean machine or a temp dir:

```sh
npx mendr@latest fix-llm .
```

it should print a scan result, not "command not found".

## 4. make the repo public

flip github.com/ajitheee/mendr to public in the repo settings. the repository, homepage, and bugs links in package.json only work for strangers once it's public, and the github action is consumed as `ajitheee/mendr/mendr-action@v1`, which also needs it public.

## 5. tag the action so `@v1` resolves

```sh
git tag v1
git push origin v1
```

now `uses: ajitheee/mendr/mendr-action@v1` in someone's workflow resolves to this code. when you ship changes later, move the tag: `git tag -f v1 && git push -f origin v1`.

## 6. then launch

everything in launch/ is ready. publish before you post the Show HN (day 3) so `npx mendr` works for anyone who reads it. the DMs work even before you publish, because they offer to run mendr on the person's repo and send them the diff.

## the one command a stranger runs

```sh
npx mendr fix-llm .
```
