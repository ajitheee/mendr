# Deploying the Mendr GitHub App

There are **two separate deployments**, and conflating them is the confusion to
avoid:

| | What | Where | Has `/setup`? |
|---|---|---|---|
| **Marketing site** | `site/` static HTML | Vercel (`vercel.json`) | No — its "Connect GitHub" button and its old `/app` URL redirect to the App |
| **The App** | `app/` — Node + Postgres | a container host (this guide) | **Yes** |

`/setup`, sign-in, the overview and every run page live on the **App's own
domain**, which you deploy below. (The pre-App paste-JSON prototype that once
lived at `/app` is gone.)

The App is designed so creating the GitHub App is one click from `/setup`; you
never hand-craft a manifest or paste a private key into code.

---

## 1. Deploy the service (Render + an external Postgres)

1. Push the repo (it contains [`render.yaml`](../render.yaml)).
2. Create the database **outside Render**: a Postgres that does not expire, for
   example a project on Neon's free plan. Copy its connection string (Neon's
   includes `sslmode=require`). The blueprint provisions no database on
   purpose: Render's free Postgres expires 30 days after creation, then is
   deleted 14 days later.
   - **The provider you pick processes customer data for Mendr.** Add it to
     the Third parties table in [`site/privacy.html`](../site/privacy.html) and
     to "Hosting and subprocessors" in [`TRUST.md`](../TRUST.md), and publish
     both, *before* `DATABASE_URL` points at it: the privacy page promises that
     a provider is added there first.
   - **Neon's free plan has a monthly compute allowance** (100 CU-hours per
     project when this was written: about 400 hours at the smallest size) and
     suspends the database until the next month once it is spent. Its compute
     sleeps after 5 idle minutes, so it runs only while the App uses it, which
     is why Render's health check is `/livez`, a path that never touches the
     database. Traffic around the clock (CI uploads or webhooks every few
     minutes) can still spend the allowance; Neon's console shows what is left.
3. In Render → **New → Blueprint** → pick this repo. Render reads `render.yaml`,
   builds the web service on its native Node runtime in `app/`, and generates
   `SESSION_SECRET`. When it asks for `DATABASE_URL`, paste the connection
   string from step 2.
4. When the first deploy is up, copy the service URL (e.g.
   `https://mendr-app.onrender.com`) and set two env vars in the dashboard:
   - `APP_URL` = that URL (no trailing slash).
   - `MENDR_DATA_KEY` = a 32-byte key. Generate one:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
   Redeploy so both take effect.

`/healthz` should return `{"ok":true,"db":"ok",...,"store":"postgres"}`. If the
database cannot be reached at boot, the service does not start: within 10 s the
log ends with one sentence naming the problem (for example `Cannot reach the
database at DATABASE_URL within 10 s. Check the connection string in the Render
dashboard.`) and the process exits, so Render fails that deploy and keeps the
previous one serving. After boot, each new connection and each query waits at
most 10 s, so if the database goes away, requests fail within 10 s instead of
hanging, and `/healthz` answers `503 {"ok":false,"db":"unavailable",...}`.
Render itself probes `/livez`, which reports only that the process is up: it
never touches the database (see step 2), and restarting the App cannot bring a
lost database back.

> **Moving an existing deployment off Render's Postgres: copy the data first.**
> The App learns about an installation and its repositories from GitHub's
> installation webhooks, which GitHub does not send again. Pointed at an empty
> database, it recovers each installation from GitHub instead: on that
> repository's next CI upload, or when a signed-in user's overview would
> otherwise be empty ([Install recovery](README.md#install-recovery)). Nobody
> has to reinstall. Everything else the database held is gone: stored runs and
> migration reports, approvals, acknowledgements and the audit log. So, in this
> order:
>
> 1. **Make `mendr-db` reachable.** An expired free database cannot be reached
>    until it is upgraded to a paid instance type, and Render deletes it 14
>    days after it expires. Upgrade it within that window; the smallest paid
>    type is enough, and step 4 deletes it.
> 2. **Copy it**, with `pg_dump` 16 or newer (`mendr-db` is Postgres 16) and the
>    database's *External* connection string from its dashboard page:
>    ```bash
>    pg_dump --no-owner --no-privileges --format=custom --file=mendr.dump "<mendr-db external URL>"
>    pg_restore --no-owner --no-privileges --dbname="<new DATABASE_URL>" mendr.dump
>    ```
>    `mendr.dump` holds customer data: delete it once step 3 checks out.
> 3. **Point the App at the copy, straight away.** Render only prompts for
>    `DATABASE_URL` when a Blueprint is first created and keeps an existing
>    value on later syncs, so edit it in the service's **Environment** tab and
>    save (that redeploys). Leave `MENDR_DATA_KEY` as it is: sealed reports open
>    only with the key that sealed them. Anything the App wrote to `mendr-db`
>    between the dump and the redeploy is not in the copy (a CI upload comes
>    back with that repository's next scan, and an install made then is
>    recovered by that scan). Then check that `/healthz` says `"db":"ok"` and a `"decrypt"`
>    other than `"failed"`, that the overview lists your installed
>    repositories, and that the service's **Health Check Path** setting reads
>    `/livez`.
> 4. **Delete `mendr-db`** in the dashboard. Removing it from `render.yaml`
>    does not: Render never deletes a resource because it left the Blueprint.
>
> If Render has already deleted `mendr-db`, there is nothing to copy. The stored
> runs, migration reports, approvals, acknowledgements and audit log are lost.
> The installations are not: each repository's next CI upload is checked with
> GitHub and accepted, with no reinstall. An upload GitHub does not confirm (the
> App is not installed on that repository, the installation is suspended, or the
> repository is outside the installation's selection) gets the same `403 the
> Mendr GitHub App is not installed on <repo>` as before. Tell the accounts that
> installed the App before switching `DATABASE_URL`, so that an empty run
> history and missing approvals are not how they find out.

> **Other hosts.** Any container platform works — the image is a standard
> Dockerfile. **Fly.io:** `fly launch --dockerfile app/Dockerfile` (build context
> the repo root), `fly postgres create` and attach it (sets `DATABASE_URL`), then
> `fly secrets set APP_URL=… SESSION_SECRET=… MENDR_DATA_KEY=…`. **Railway:** new
> service from the repo, root Dockerfile, add a Postgres plugin, set the same env
> vars. Do **not** use Vercel for this service — it is a long-running server with
> a Postgres pool, not serverless; Vercel stays the static site.

## 2. Create the GitHub App (one click)

1. Open `APP_URL/setup`. It shows the App manifest (least privilege:
   `checks: write` + `metadata: read`) and a **Create the GitHub App** button.
   For an org, use `APP_URL/setup?org=<org-login>`.
2. GitHub creates the App and returns to `/setup/callback`, which prints six
   environment lines **once**:
   `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY`.
3. Put those six into the host's env (Render dashboard / `fly secrets set` /
   Railway) and redeploy. They are shown once and never stored by the App.

`/healthz` should now report `"configured":true`.

## 3. Connect a repository and test the flow

1. Open `APP_URL/` and **Sign in with GitHub**.
2. **Install on a repository** (button on the overview, or
   `https://github.com/apps/<slug>/installations/new`).
3. On the overview, each installed repo shows **Set up the audit** — it opens
   GitHub's own new-file editor with the workflow filled in. Commit it. The App
   writes nothing; the scan runs in the repo's CI.
4. When CI runs, it posts findings to `APP_URL/api/ingest` (OIDC-authenticated),
   the App writes a **Mendr audit** check on the commit, and the finding shows on
   the repo's run page (`/r/<owner>/<name>`) with Open-in-GitHub and Rerun.

End-to-end test checklist:

- [ ] `/healthz` → `configured:true`, `store:postgres`
- [ ] sign-in works and shows only repos you can access
- [ ] "Set up the audit" opens GitHub's editor prefilled
- [ ] after a CI run, a check appears on the commit and the run page renders the
      5-part finding
- [ ] uninstalling the App removes the stored findings (privacy)

## Test it locally first (optional)

To validate the Postgres path, schema-on-boot, encryption, and the real GitHub
flow without a cloud account, run the App + Postgres locally and expose it with
a tunnel:

```bash
cd app
docker compose up --build
cloudflared tunnel --url http://localhost:8080   # or: ngrok http 8080
```

Set `APP_URL` to the tunnel's https URL (edit `docker-compose.yml` or pass it in
the environment), restart, and follow steps 2–3 against that URL. See
[`docker-compose.yml`](docker-compose.yml).

## 4. Point the marketing site at the App

Once `APP_URL` is live, update the site's call to action to link to it (e.g. a
"Connect GitHub" button → `APP_URL`), so visitors reach the connected App rather
than the paste-JSON demo. That is a one-line edit in `site/index.html`; keep the
demo reachable if you like, but make the primary CTA the App.

## Environment reference

See [`.env.example`](.env.example). Required in production: `APP_URL`,
`DATABASE_URL`, `SESSION_SECRET`, `MENDR_DATA_KEY`, and the six `GITHUB_*` values
from step 2. The scanner release the generated workflows pin to is compiled into
the App (`MENDR_CLI_SPEC` in `src/config.ts`, bumped with each release) — not an
environment variable, so a deployment can never hand out a stale pin. Optional:
`MENDR_RETENTION_DAYS`, `MAX_RUNS_PER_REPO`.

The App warns loudly at boot if `DATABASE_URL` (falls back to in-memory) or
`MENDR_DATA_KEY` (plaintext storage) is missing — neither is acceptable for a
production deployment holding private-repo findings. A `DATABASE_URL` that is
set but unreachable stops the boot within 10 s with one sentence; it never
leaves the process waiting with nothing in the log.
