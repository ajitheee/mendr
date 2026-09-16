# v0.5.1-alpha

One fix. It is the kind that matters most here, because it is not a missed finding — it is a
wrong **"clean"**.

## A command-line default is a selector, not documentation

`going-doer/Paper2Code`, 4,954 stars, audited as **NO EXPOSURE IN COMPLETED SURFACES**. Its
documented Quick Start is `bash run.sh`, and neither README evaluation command passes
`--gpt_version`. Every one of those paths runs `o3-mini`, which OpenAI retires on 2026-10-23.

```python
parser.add_argument('--gpt_version', type=str, default="o3-mini")
```

The literal was found. It was filed in the same bucket as a docstring.

Two rules had to miss it independently. One looks for a model-named **assignment target**, and
a bare `add_argument(...)` statement has none. The other tests the surrounding name against
`/model/i` — which `--gpt_version` fails, while naming a model exactly.

TypeScript had the identical hole, and had it twice. The rule for commander's positional default
existed, gated on the same `/model/i` flag-name test, and knew nothing of the yargs spelling
where the default is a `default:` property rather than a positional argument. So this also read
as clean:

```ts
yargs.option('gptVersion', { type: 'string', default: 'o3-mini' })
// ... model: argv.gptVersion
```

Both now key on the **call** rather than on the option's name. By that point the value already
matches a registry id, so the question is not "is this a model" but "is this the id that runs
when the flag is omitted" — and for a CLI default it is, whatever the flag is called.

Both cap at **review, and are never swap-eligible.** The path from parsed argv to a provider
request is not traced, and Tier A exists precisely so that nothing untraced gets rewritten
unattended.

## What was measured before shipping it

- Paper2Code now reports exposure: `o3-mini` and `o4-mini` at review — and the **17**
  tokenizer- and price-table entries stay informational. It did not over-correct.
- All twelve repositories in `VALIDATION-2026-09-15.md` produce **byte-identical** output
  before and after: same conclusions, same tallies. Zero false positives introduced.
- **1,150 tests**, up from 1,135. The fifteen new ones include `choices=`, `help=`, the flag
  spec itself, and an explicit assertion that neither rule can reach Tier A.

## The uncomfortable part, written down

`VALIDATION-2026-09-15.md` gains an addendum, because this narrows what that document proved.

Its recall check narrowed 4,116 occurrences of a retiring id to 75 candidates using a pattern
filter, then verified the survivors. That design can find an id sorted into the wrong bucket. It
cannot find a whole **position** the classifier misreads, because such a literal is correctly
excluded as data at every step. A recall search built from the scanner's own notion of a
candidate inherits the scanner's blind spots.

The corpus could not have caught this either: not one CLI option across those twelve
repositories carries a model id as its default. Twelve repositories agreeing proves less than it
appears to when they share a shape.

This was found by reading one repository by hand. That method keeps working.

## Registry

Unchanged — 158 entries, `sha256:8241d681b80651cd`, the same content the live snapshot carries.
The bundled stamp was deliberately **not** regenerated for this release: the rollback floor
already sits below the published snapshot, and re-stamping would have raised it above, making
every install treat the live registry as a rollback until the next publish completed.

## Upgrading

Bump both `uses:` lines together:

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@v0.5.1-alpha
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@v0.5.1-alpha
```

Nothing in your configuration changes. If your project selects its model through a command-line
flag, expect findings that were previously silent — as review candidates, never as automatic
edits.
