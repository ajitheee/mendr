# Mendr GitHub App

The hosted half of Mendr, kept deliberately small. Your CI runs `mendr audit`
on your own runner; this service receives the JSON that run produces, proves
where it came from, stores the evidence, and writes a **Mendr audit** check on
the commit. It never clones a repository and cannot read one: the App asks
GitHub for `checks: write` and `metadata: read` only. One permission is
optional — `actions: write` — which lets it start your migration workflow the
moment a person approves a migration; that is starting and cancelling workflow
runs, nothing else (no contents, no pull requests, no code).

Status: alpha. It is exercised end to end by tests against a GitHub-shaped
fake (`src/app.test.ts`); the first real installation is a human step below.

## What it does

| Direction | What | Proof |
|---|---|---|
| In, from GitHub | `installation` and `installation_repositories` webhooks, HMAC-signed. They define who may send evidence. GitHub sends each one once, so when the database has lost one (a move to a new database), the App asks GitHub instead: see *Install recovery* below. | `src/github/webhook.ts`, `src/github/installRecovery.ts` |
| In, from your CI | `POST /api/ingest` with the `mendr audit --json` document. Authenticated by the **GitHub Actions OIDC token** of the run: no shared secret, nothing to store in your repository. The token names the repository id, commit, ref and run. | `src/github/oidc.ts` |
| Stored | Installations, repository ids and names, and the sanitized evidence per run: findings, paths, line numbers, classifications, redacted snippets of at most seven lines, line hashes. Every string is re-redacted server-side and snippets are re-capped; the client is not trusted to have done it. | `src/ingest/validate.ts`, `schema.sql` |
| Out, to GitHub | One check run per run attempt, scoped by an installation token limited to that repository and `checks: write`. Conclusion: `action_required` when a PATCH ELIGIBLE finding exists, `neutral` for review-only or inconclusive audits, `success` when nothing needs a human. Annotations at the exact file and line. For a repository the database does not know, the install-recovery lookups below, with the App's JWT and `metadata: read`. | `src/ingest/checkRun.ts`, `src/github/api.ts` |
| Read back | Sign in with GitHub. You see a repository only if the App is installed on it **and** GitHub says you can access it. Your GitHub token lives only in an encrypted cookie; the database holds no user tokens. | `src/app.ts`, `src/auth/session.ts` |

Not in this service: repository contents, clones, pull requests, issues,
telemetry. The full statement is in [TRUST.md](../TRUST.md).

### Install recovery

A lost database no longer means reinstalling. When `POST /api/ingest`,
`POST /api/migrations` or the migration workflow's approvals check arrives with
a verified OIDC token for a repository the database does not know, the App asks
GitHub before refusing it (`src/github/installRecovery.ts`):

1. `GET /repos/{owner}/{repo}/installation` with the App's JWT, for the
   repository the OIDC token names. A 404 is read as "not installed".
2. An installation token limited to the token's `repository_id` and
   `metadata: read`. GitHub will not mint it if the installation does not cover
   that id, so a repository outside the installation's selection is refused
   here even if step 1 answered.
3. `GET /repos/{owner}/{repo}` with that token: GitHub's id must equal the
   token's `repository_id`.

When all three agree, the installation and that repository are stored, the audit
log records `installation_recovered`, and the upload is handled as usual. Every
other answer is the same 403 as before, remembered for that repository id for 5
minutes (1 minute if GitHub or the database did not answer), so refused uploads
do not reach GitHub on every request. A suspended installation is not stored, an
installation the database holds as uninstalled is never brought back, and one it
already knows is not rewritten. The lookup needs the App's id and private key;
without them (local development) the upload is refused as before.

A signed-in user whose overview would be empty also gets the installations of the
App they can access on GitHub (`GET /user/installations` and each one's
repositories, with their own token): the repositories the database lacks are
added. This runs at most once every 10 minutes per user and waits at most 8
seconds for GitHub. Neither path adds a permission: the App still asks for
`checks: write` and `metadata: read`, with `actions: write` optional.

What recovery cannot bring back: stored runs, migration reports, approvals,
acknowledgements and audit-log entries. A repository's run history starts again
with its next scan.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /livez` | Liveness only, and Render's health check: never touches the database, so the probe cannot keep a scale-to-zero Postgres awake. |
| `GET /healthz` | Health including the database (`503` within 10 s when it cannot be reached), whether credentials are configured, which store is in use, encryption at rest. |
| `GET /setup` | Create the GitHub App from its manifest (one click on GitHub). `?org=<login>` creates it under an organization. |
| `GET /setup/callback` | GitHub returns here; the credentials are shown once as environment lines. Not stored. |
| `GET /setup/installed` | Post-install page with the exact workflow step to add. |
| `POST /webhooks/github` | Installation webhooks. |
| `POST /api/ingest` | Evidence from your CI, bearer = Actions OIDC token, audience `mendr`. |
| `GET /auth/login`, `/auth/callback`, `POST /auth/logout` | Sign in with GitHub. |
| `POST /api/migrations` | What `mendr-action` did, bearer = Actions OIDC token (never the diff). |
| `GET /api/me`, `/api/repos`, `/api/repos/:owner/:name/runs`, `/api/runs/:id` | JSON, as linked from the run page ("Evidence JSON"). |
| `GET /`, `/r/:owner/:name`, `/r/:owner/:name/runs/:id` | Overview, run list, run page. |

## Deploy

**Full step-by-step (deploy → create the GitHub App → connect a repo → test):
[DEPLOY.md](DEPLOY.md).** It also explains the two-deployment split (this Node +
Postgres service vs the static marketing site on Vercel): `/setup` and every
signed-in page live here, on this service's own domain; the marketing site's
"Connect GitHub" button and its old `/app` URL both lead here.

The fastest path is the [Render blueprint](../render.yaml) (near one-click, with
an external Postgres such as Neon's free plan for `DATABASE_URL`). The short
version:

1. **Run it somewhere public** with Node 22+ and Postgres. Any container host
   works; the Dockerfile builds from the repository root:

   ```bash
   docker build -f app/Dockerfile -t mendr-app .
   ```

   Set `APP_URL` (the public https URL), `SESSION_SECRET` (32+ random
   characters) and `DATABASE_URL`. Without `DATABASE_URL` the in-memory store
   is used and every restart forgets everything; that is for development only.

2. **Create the GitHub App** by opening `APP_URL/setup` and clicking the
   button. GitHub creates the App from the manifest and sends you back to
   `/setup/callback`, which prints six environment lines. Put them in the
   host's environment and restart. They are shown once and never stored.

3. **Install it** on a repository from the overview page, or from
   `https://github.com/apps/<slug>/installations/new`.

4. **Let the workflow send its evidence.** In the repository's audit workflow
   (the one `mendr audit --install` scaffolds), add `id-token: write` to the
   permissions and this step after the audit writes `mendr-audit.json`:

   ```yaml
   permissions:
     contents: read
     issues: write
     id-token: write   # lets the run prove its origin to Mendr; no secret needed

   # ...
         - name: Send audit evidence to Mendr
           env:
             MENDR_APP_URL: https://app.example.com
           run: |
             TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
               "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=mendr" | jq -r .value)
             curl -sS --fail-with-body -X POST "$MENDR_APP_URL/api/ingest" \
               -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
               --data-binary @mendr-audit.json
   ```

   For pull requests, pass the head commit to the audit so the check lands on
   the PR: `mendr audit . --json --sha "${{ github.event.pull_request.head.sha || github.sha }}" > mendr-audit.json`.
   The next release scaffolds this step automatically.

## Develop locally

```bash
cd app
npm install
npm test
npm run dev            # http://localhost:8080, in-memory store, unconfigured
```

To exercise ingest without a real workflow run, mint a token signed by a local
development key and point the server at that key:

```bash
node scripts/dev-oidc.mjs acme/api 1234 > /tmp/token      # creates .dev/ on first use
OIDC_JWKS_FILE=.dev/oidc-jwks.json OIDC_ISSUER=https://dev.mendr.local npm run dev
```

Then simulate the installation webhook (or insert the repository directly in
the memory store through a test) and post a `mendr audit --json` file with
`Authorization: Bearer $(cat /tmp/token)`. The check-run write will fail
without real App credentials; the response says so and the evidence is kept.

## Configuration

See `.env.example`. `OIDC_JWKS_FILE` and the in-memory store exist for
development and print a warning at boot; do not use either in production.
