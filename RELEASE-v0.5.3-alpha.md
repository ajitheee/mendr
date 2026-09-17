# v0.5.3-alpha

Two fixes. The first one meant Mendr was worst exactly when a customer's news was good.

## A clean repository no longer reads as `inconclusive`

The generated audit workflow ran:

```
mendr audit . --json > mendr-audit.json
```

from the repository root — and **the shell creates that file before mendr starts.** So every run
scanned mendr's own zero-byte output, the config scanner classified it as malformed JSON, and the
fail-closed rule from v0.5.0-alpha turned the run `inconclusive`.

Here is why it went unnoticed. A run **with** findings concludes `exposure_detected` regardless of
parse failures. So the bug could only ever strike a repository that was **clean** — turning every
all-clear into `inconclusive` with a neutral check. The one result a customer most wants was the
one result Mendr could not deliver.

It surfaced the moment the demo repository completed its own loop. The migration pull request was
merged, the repository became clean, and from that commit onward every audit went red. **The pull
request Mendr opened failed the check Mendr opened it with.**

Fixed on both sides, because either alone leaves a hole:

- **The scanner.** An empty file is not malformed configuration. It has no content to misread, so
  it cannot be hiding a model id and its unreadability narrows nothing — the same reasoning that
  already exempts docs and fixtures. A file with **any** content still fails closed, including a
  lone `{`.
- **The workflow.** The report is written to `$RUNNER_TEMP`, outside the scanned tree. Mendr's own
  artifacts have no business in a customer's repository mid-scan.

It reproduced in CI every time and was clean locally every way it was run — branch head,
reconstructed merge commit, `audit .` from the repository root, the exact pinned build via npx,
even a workspace path containing `demo`. Because the report goes to a file, CI was silent about
why. A temporary diagnostic workflow that printed the raw coverage named it in one run.

## The pull request stops repeating itself

Reading the first pull request Mendr ever actually opened showed three things no unit test could
catch, because each is only wrong in combination:

- The behavioural ceiling was stated **twice**, in two voices and two spellings — once as the
  evidence block's blockquote, again under "Also worth knowing" as the CLI's own note. Correct in
  a terminal report where no blockquote exists; in a pull request it reads as a tool that does not
  know what it already told you.
- That note still said **"the sandbox"** — a claim withdrawn in v0.5.1-alpha. Third place it was
  found after being withdrawn: the documents, then the shell scaffold, now a string built in
  `migrate.ts`. Each time the sweep missed a different file type.
- *"Applied the verified migration to 1 file(s) in the working tree"* sat a few lines under *"your
  working tree was never touched."* Both true — one means the CI checkout, the other the
  reviewer's machine — but printed together they read as a contradiction.

## Registry

Unchanged: 158 entries, `sha256:8241d681b80651cd`. The bundled stamp was deliberately **not**
regenerated. The rollback floor already sits below the published snapshot, and re-stamping would
raise it above — making every install treat the live registry as a rollback until the next publish
completed.

## Upgrading

```yaml
uses: ajitheee/mendr/.github/workflows/reusable-audit.yml@v0.5.3-alpha
uses: ajitheee/mendr/.github/workflows/reusable-migrate.yml@v0.5.3-alpha
```

If your repository is clean, this is the release where that finally reports as clean.
