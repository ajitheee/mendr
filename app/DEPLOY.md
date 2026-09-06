# Deploying the Mendr GitHub App

There are **two separate deployments**, and conflating them is the confusion to
avoid:

| | What | Where | Has `/setup`? | `/app/` shows |
|---|---|---|---|---|
| **Marketing site** | `site/` static HTML | Vercel (`vercel.json`) | No | the paste-JSON demo prototype |
| **The App** | `app/` — Node + Postgres | a container host (this guide) | **Yes** | the workspace, reading from `/api` |

So on the Vercel domain, `/setup` 404s and `/app` is a static demo — that is
expected. `/setup` and the GitHub-connected workspace live on the **App's own
domain**, which you deploy below.

The App is designed so creating the GitHub App is one click from `/setup`; you
never hand-craft a manifest or paste a private key into code.

---

## 1. Deploy the service (Render — simplest Docker + Postgres)

1. Push the repo (it contains [`render.yaml`](../render.yaml)).
2. In Render → **New → Blueprint** → pick this repo. Render reads `render.yaml`,
   provisions a free Postgres, builds the web service from `app/Dockerfile`,
   generates `SESSION_SECRET`, and links `DATABASE_URL`.
3. When the first deploy is up, copy the service URL (e.g.
   `https://mendr-app.onrender.com`) and set two env vars in the dashboard:
   - `APP_URL` = that URL (no trailing slash).
   - `MENDR_DATA_KEY` = a 32-byte key. Generate one:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
   Redeploy so both take effect.

`/healthz` should return `{"ok":true,...,"store":"postgres"}`.

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
from step 2. `MENDR_CLI_SPEC` pins the scanner the scaffolded workflow runs
(default `v0.3.0-alpha`). Optional: `MENDR_RETENTION_DAYS`, `MAX_RUNS_PER_REPO`.

The App warns loudly at boot if `DATABASE_URL` (falls back to in-memory) or
`MENDR_DATA_KEY` (plaintext storage) is missing — neither is acceptable for a
production deployment holding private-repo findings.
