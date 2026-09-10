# mendr v0.4.7-alpha — a refused pull request is reported, never silent

Supersedes `v0.4.6-alpha`; every earlier pin keeps working unchanged.

## What changed

**A refused pull request is reported, never silent.** GitHub's default
repository setting forbids Actions from creating pull requests ("GitHub
Actions is not permitted to create or approve pull requests"). Until now the
action died at that point and the App never heard back, so the approval sat
on "running". Now the action reports `pr-blocked` (the verified change is
already on the branch), the job summary and the finding name the exact setting
to flip — Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests — with a link to open the pull request by hand, and the
approval closes with that truth. Any other unexpected failure after the
verdict is reported as `error` naming the step it died at.

**Cancel a running approval.** A run that died without reporting no longer
blocks the finding: Cancel works while running too, and the person can approve
again.

**Said up front.** The generated workflow's header, the App's installed page
and `BETA-ONBOARDING.md` name the one repository setting a partner must flip.

## Upgrading

- **New connections:** nothing to do; the App generates the caller pinned to
  `v0.4.7-alpha`.
- **Repositories on the short caller:** bump the two `uses:` lines to
  `@v0.4.7-alpha` (or take the file from the App's one-click setup again).

## Verification

- 1,031 scanner tests and 151 App tests. New: the App's `pr-blocked` rendering
  and whitelist (`branch`), cancelling a running approval, the caller's header
  naming the setting. Found on the first real approval on `mendr-demo`.

## Known limits

- `watch` and `fix-llm` still use the bundled registry.
- The diff of an approved migration arrives with the final report.
