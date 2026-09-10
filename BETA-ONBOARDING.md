# Mendr beta — partner onboarding

Mendr continuously monitors the AI models your repositories call, explains the
risk when a provider retires one, and prepares a validated migration pull
request for a person to approve. The scan and the migration run in **your** CI;
the hosted App never reads your code. This page is everything a partner needs:
five minutes to connect, what you will see, what to do when something looks
off, and how to get your data out.

## Before you start (2 minutes)

- A GitHub repository (TypeScript, JavaScript or Python) with GitHub Actions
  enabled. Private is fine.
- Permission to install a GitHub App on it (repository admin, or an org owner).
- Nothing else: no API key, no agent, no config file.

## Connect (5 minutes)

1. Open **https://mendr-app.onrender.com** and click **Connect GitHub**.
2. Install the App and select the repositories to monitor. The App asks for
   `checks: write` and `metadata: read` only.
3. Back on the overview, click **Set up the audit** next to the repository.
   GitHub's own editor opens with one workflow file filled in
   (`.github/workflows/mendr-audit.yml`). Read it, commit it.
   One repository setting lets the migration open its pull request later:
   Settings → Actions → General → **Allow GitHub Actions to create and approve
   pull requests**. Do it now; it takes ten seconds.
4. The first scan runs within about two minutes. The overview shows the result;
   the commit gets a **Mendr audit** check.

From then on the repository is scanned on every push, every pull request and
once a day, so a retirement announced tomorrow shows up tomorrow without anyone
changing anything.

## What you will see

- **Overview:** one row per repository — the last completed scan and its result,
  a newer attempt that did not complete (never in its place), and whether
  monitoring is active or quiet.
- **Run page:** each finding as six parts — possible cause, evidence linked into
  the code, confidence boundary, migration evidence, next action, ownership.
- **Results are honest:** `nothing found` only after a completed scan against a
  fresh registry. `inconclusive` means Mendr could not prove absence (stale
  registry, or too little analyzed). `audit failed` means the scan did not
  complete. None of these ever overwrite an earlier finding.

## Approve a migration

On a **patch eligible** finding, click **Approve migration to …**. Your own CI
verifies the swap on a throwaway copy (type-check, build, your tests), pushes
one branch and opens **one pull request for review**; the finding shows every
step live and the change itself. **Mendr never merges** in the beta and never
touches your default branch. You review and merge; the next completed scan
marks the finding resolved.

Optional: grant the App `Actions: read and write` and an approval starts your
workflow immediately. That permission lets the App start or cancel workflow
runs and nothing else — no contents, no pull requests, no code. Without it the
workflow's own schedule picks approvals up (hourly on a public repository,
every three hours on a private one).

## Private repositories: what leaves your CI

Only what the workflow sends: findings with file paths, line numbers,
classifications and redacted snippets of a few lines; after a migration, the
outcome, the gate results, the file paths touched and the diff of the swap
itself — never whole files, never a clone. It is stored encrypted at rest.
You can delete a repository's data at any time from its page; uninstalling
the App purges everything. Full detail: [TRUST.md](TRUST.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| The workflow fails with HTTP 403 from the App ("not installed") | The repository is not on the App installation | GitHub → Settings → Applications → Mendr audit → Select repositories → add it → Save. The next run succeeds. |
| The result reads `inconclusive` with zero findings | The registry the scan used was not provably fresh, or too little of the repository was analyzed | Keep `MENDR_REGISTRY_REFRESH: 'on'` in the workflow (the generated file has it). Open the run page: the reason is stated. |
| No scan for more than a day ("quiet") | GitHub paused the schedule (it does so on public repositories with no activity for 60 days), or the workflow was disabled | Actions tab → the `mendr audit` workflow → Enable. Any push also triggers a scan. |
| An approval stays `queued` | No migration workflow is listening, or the App may not start workflows | The run page's Migration card says which. Add the workflow file once if missing; grant `Actions: read and write` for instant starts, or wait for the schedule. |
| Migration `not verified — nothing applied` | Your tests or build failed on the throwaway copy with the swap applied | Open the workflow run log in Actions; the gate that failed is named. Nothing was changed anywhere. |
| "GitHub Actions is not permitted to create or approve pull requests" — verified, branch pushed, no PR | A repository setting (GitHub's default) | Settings → Actions → General → tick **Allow GitHub Actions to create and approve pull requests** → Save. Then cancel the approval on the finding and approve again, or open the pull request from the branch yourself (the finding links to it). |
| No pull request although verification passed | Branch protection blocks the workflow's push, or `contents: write` / `pull-requests: write` was removed from the migrate job | Check the run log; restore the job's permissions from the generated file. |
| A finding you fixed still shows | Only a **completed** scan against a fresh registry confirms a resolution | Wait for the next scan (or push). The run page will show "Resolved since run N". |
| You want the data gone | — | Repository page → **Delete stored data**, or uninstall the App. Both are immediate. |

## What we measure during the beta

Installation completion · time to first audit · incorrect exposure
classifications · missed dependencies · migration preparation success ·
duplicate pull requests · how failed/inconclusive results are presented ·
whether the finding page is understood without explanation · uninstall and
deletion behaviour.

Tell us what you saw — a screenshot of anything confusing is the most useful
thing you can send. Non-sensitive feedback: open an issue at
https://github.com/ajitheee/mendr/issues. Security issues: report privately
via https://github.com/ajitheee/mendr/security/advisories/new.
