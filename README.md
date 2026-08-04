# Mendr

Mendr is a CLI tool that auto-fixes third-party API breaking changes (Stripe
first) in a target TypeScript repo. It detects a change in a Stripe OpenAPI spec,
finds where the customer's code uses the changed field, generates a patch, runs
gates (typecheck + tests), and outputs a diff.

## Status

**Phase 0 scaffold.** This is a runnable skeleton only — the three subcommands
(`scan`, `check`, `fix`) are stubs that echo their arguments and report which
phase will implement them. No real detection or fix logic exists yet.

## Build & run

```sh
npm install
npm run build
node dist/cli.js --help
```

Other scripts: `npm run dev` (run the CLI via tsx without building),
`npm test` (vitest), `npm start` (run the built CLI).

## Plan

The full implementation plan lives at:
`C:\Users\etaji\.claude\plans\make-a-complete-plan-structured-perlis.md`
