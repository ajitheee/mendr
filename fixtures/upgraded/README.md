# fixtures/upgraded (state t1 — the SDK was upgraded, code not yet migrated)

A self-contained TypeScript project that reproduces the exact moment Mendr is
built for: the dependency was upgraded, its types changed, and the repo's own
source has NOT caught up.

- `src/types.ts` declares `DemoCharge.card` with the **new** field
  `cardholder_name` (the upgraded SDK shape). `name` is gone.
- `src/receipt.ts` and `src/fraud.ts` still read the **old** `charge.card.name`.

## This fixture does NOT compile as-is — on purpose

Running `tsc` here fails with two `TS2339` errors ("Property 'name' does not
exist on type ...") because the un-migrated code references a field the upgraded
type no longer has. That is state t1, the breakage Mendr detects.

After Mendr applies the rename codemod (`.name` -> `.cardholder_name`) the code
compiles again AND the test in `src/receipt.test.ts` passes. That is what makes
this the fixture whose gates **pass**, so the rename keeps its Tier A label.

## Reproduce

```
npm install                       # installs stripe + typescript (dev)
node ../../dist/cli.js fix . --from ../../specs/demo-vA.json --to ../../specs/demo-vB.json
```

The gate summary should read `type-check: pass, tests: pass` and the rename
stays **Tier A**.
