import type { AppConfig } from '../config.js';
import type { ManifestCredentials } from '../github/api.js';
import type { Repo, RunRecord, RunSummary } from '../store/types.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const CSS = `
:root{color-scheme:light dark;--fg:#1a1c1e;--muted:#5d6570;--bg:#fbfbf9;--line:#d9dbd6;--card:#ffffff;--patch:#b3261e;--review:#a15c00;--info:#3d5a80;--ok:#2e6b3a;--accent:#0f6b5c}
@media (prefers-color-scheme:dark){:root{--fg:#e6e7e3;--muted:#9aa2ab;--bg:#131516;--line:#2b2f33;--card:#1b1e21;--patch:#ff8a80;--review:#ffb74d;--info:#90b4e8;--ok:#7fd39b;--accent:#4fc3a1}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 64px}header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:24px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:28px 0 8px}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{background:var(--card);border:1px solid var(--line);padding:12px;overflow-x:auto;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor}
.patch{color:var(--patch)}.review{color:var(--review)}.info{color:var(--info)}.ok{color:var(--ok)}
a{color:var(--accent)}button,.btn{background:var(--accent);color:#fff;border:0;padding:8px 14px;border-radius:4px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px;margin:12px 0}
form.inline{display:inline}
`;

export function layout(title: string, body: string, opts: { login?: string | null } = {}): string {
  const who = opts.login
    ? `<span class="muted">signed in as <strong>${esc(opts.login)}</strong></span> <form class="inline" method="post" action="/auth/logout"><button type="submit">Sign out</button></form>`
    : `<a class="btn" href="/auth/login">Sign in with GitHub</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><header><h1><a href="/" style="text-decoration:none;color:inherit">Mendr</a> <span class="muted" style="font-weight:400">· ${esc(title)}</span></h1><div>${who}</div></header>${body}</main></body></html>`;
}

function pill(counts: RunSummary['counts']): string {
  const parts: string[] = [];
  if (counts.patch) parts.push(`<span class="pill patch">${counts.patch} patch eligible</span>`);
  if (counts.review) parts.push(`<span class="pill review">${counts.review} review required</span>`);
  if (counts.informational) parts.push(`<span class="pill info">${counts.informational} informational</span>`);
  if (!parts.length) parts.push('<span class="pill ok">nothing found</span>');
  return parts.join(' ');
}

export function homePage(input: { config: AppConfig; configured: boolean; login: string | null; rows: { repo: Repo; latest: RunSummary | null }[] }): string {
  const { config, configured, login, rows } = input;
  const setup = configured
    ? ''
    : `<div class="card"><strong>Not configured yet.</strong> Create the GitHub App from its manifest at <a href="/setup">/setup</a>, put the printed credentials in the environment, and restart.</div>`;
  const install = configured && config.githubAppSlug ? `<p><a class="btn" href="${esc(config.githubWebUrl)}/apps/${esc(config.githubAppSlug)}/installations/new">Install on a repository</a></p>` : '';
  let list: string;
  if (!login) {
    list = `<p class="muted">Sign in to see the repositories where the App is installed and that you can access.</p>`;
  } else if (!rows.length) {
    list = `<p class="muted">No installed repository is visible to you yet. Install the App on a repository, then add the upload step to its audit workflow.</p>`;
  } else {
    list = `<table><thead><tr><th>Repository</th><th>Latest run</th><th>Result</th></tr></thead><tbody>${rows
      .map(({ repo, latest }) => {
        const when = latest ? `<a href="/r/${esc(repo.fullName)}/runs/${latest.id}">${esc(latest.receivedAt.slice(0, 16).replace('T', ' '))}</a> <span class="muted">${esc(latest.ref.replace(/^refs\/heads\//, ''))} @ ${esc(latest.sha.slice(0, 7))}</span>` : '<span class="muted">no run received yet</span>';
        return `<tr><td><a href="/r/${esc(repo.fullName)}">${esc(repo.fullName)}</a></td><td>${when}</td><td>${latest ? pill(latest.counts) : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }
  const body = `${setup}<p>This service receives the evidence your own CI run produces with <code>mendr audit --json</code>, writes a <em>Mendr audit</em> check on the commit, and keeps the findings here. It never clones or stores your code. <a href="https://github.com/ajitheee/mendr/blob/main/TRUST.md">What leaves your infrastructure</a>.</p>${install}<h2>Repositories</h2>${list}`;
  return layout('overview', body, { login });
}

export function setupPage(input: { manifest: string; target: string; configured: boolean; appUrl: string }): string {
  const warn = input.configured ? `<div class="card"><strong>Already configured.</strong> Creating another App here would produce a second set of credentials; only continue if you mean to replace it.</div>` : '';
  const body = `${warn}<p>GitHub will create the App from this manifest and redirect back here with its credentials. The App asks for <code>checks: write</code> and <code>metadata: read</code> only; it cannot read repository contents.</p>
<form method="post" action="${esc(input.target)}"><input type="hidden" name="manifest" value="${esc(input.manifest)}"><button type="submit">Create the GitHub App</button></form>
<p class="muted">Creating it for an organization instead? Open <code>/setup?org=&lt;org-login&gt;</code>.</p>
<h2>Manifest</h2><pre>${esc(JSON.stringify(JSON.parse(input.manifest), null, 2))}</pre>
<p class="muted">Public URL used: <code>${esc(input.appUrl)}</code>. If that is wrong, set <code>APP_URL</code> and reload before creating.</p>`;
  return layout('setup', body);
}

export function credentialsPage(c: ManifestCredentials): string {
  const env = [
    `GITHUB_APP_ID=${c.id}`,
    `GITHUB_APP_SLUG=${c.slug}`,
    `GITHUB_CLIENT_ID=${c.clientId}`,
    `GITHUB_CLIENT_SECRET=${c.clientSecret}`,
    `GITHUB_WEBHOOK_SECRET=${c.webhookSecret}`,
    `GITHUB_PRIVATE_KEY="${c.pem.replace(/\r?\n/g, '\\n')}"`,
  ].join('\n');
  const body = `<div class="card"><strong>Shown once.</strong> These credentials are not stored by this server. Copy them into the deployment's environment now, then restart it.</div>
<pre>${esc(env)}</pre>
<p>App page on GitHub: <a href="${esc(c.htmlUrl)}">${esc(c.htmlUrl)}</a>. After restarting, install it on a repository from there (or from the overview).</p>`;
  return layout('credentials', body);
}

export function installedPage(config: AppConfig): string {
  const body = `<div class="card"><strong>Installed.</strong> Now let the repository's audit workflow send its evidence here.</div>
<p>Add <code>id-token: write</code> to the workflow's permissions and this step after <code>mendr audit</code> writes its JSON:</p>
<pre>${esc(`      - name: Send audit evidence to Mendr
        env:
          MENDR_APP_URL: ${config.appUrl}
        run: |
          TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${config.oidcAudience}" | jq -r .value)
          curl -sS --fail-with-body -X POST "$MENDR_APP_URL/api/ingest" \\
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
            --data-binary @mendr-audit.json`)}</pre>
<p class="muted">The token proves which repository and run the evidence came from; there is no shared secret to store. Only the JSON is sent.</p>
<p><a class="btn" href="/">Back to the overview</a></p>`;
  return layout('installed', body);
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<div class="card"><strong>${esc(title)}.</strong> ${esc(message)}</div><p><a href="/">Back</a></p>`);
}

export function runsPage(repo: Repo, runs: RunSummary[], login: string): string {
  const rows = runs.length
    ? runs
        .map(
          (r) =>
            `<tr><td><a href="/r/${esc(repo.fullName)}/runs/${r.id}">${esc(r.receivedAt.slice(0, 19).replace('T', ' '))}</a></td><td><span class="muted">${esc(r.ref.replace(/^refs\/heads\//, ''))}</span> @ <code>${esc(r.sha.slice(0, 7))}</code></td><td>${pill(r.counts)}</td><td>${r.checkRunUrl ? `<a href="${esc(r.checkRunUrl)}">check</a>` : '<span class="muted">no check</span>'}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="muted">No runs received yet.</td></tr>`;
  const body = `<h2>${esc(repo.fullName)}</h2><table><thead><tr><th>Received</th><th>Commit</th><th>Result</th><th>Check run</th></tr></thead><tbody>${rows}</tbody></table>`;
  return layout(repo.fullName, body, { login });
}

const LABEL: Record<string, string> = { patch: 'PATCH ELIGIBLE', review: 'REVIEW REQUIRED', monitor: 'informational' };
const CLASS: Record<string, string> = { patch: 'patch', review: 'review', monitor: 'info' };

export function runPage(repo: Repo, run: RunRecord, login: string): string {
  const invs = [...run.report.investigations].sort((a, b) => rank(a.decision) - rank(b.decision));
  const rows = invs
    .map((inv) => {
      const locs = inv.locations.selectors
        .slice(0, 8)
        .map((l) => `<div><code>${esc(l.file)}:${l.line}</code> <span class="muted">${esc(l.disposition ?? l.tier ?? '')}</span></div>`)
        .join('');
      const more = inv.locations.selectors.length > 8 ? `<div class="muted">… ${inv.locations.selectors.length - 8} more</div>` : '';
      const ev = inv.retirementEvidence;
      return `<tr><td><span class="pill ${CLASS[inv.decision]}">${LABEL[inv.decision]}</span></td><td><strong>${esc(inv.model)}</strong><div class="muted">${esc(inv.provider)}${ev?.shutdownDate ? ` · shutdown ${esc(ev.shutdownDate)}` : ''}</div></td><td>${locs}${more}</td><td>${esc(inv.nextAction ?? inv.reason ?? '')}</td></tr>`;
    })
    .join('');
  const body = `<h2><a href="/r/${esc(repo.fullName)}">${esc(repo.fullName)}</a> <span class="muted">· ${esc(run.ref.replace(/^refs\/heads\//, ''))} @ ${esc(run.sha.slice(0, 7))}</span></h2>
<p>${pill(run.counts)} <span class="muted">· conclusion <code>${esc(run.conclusion)}</code> · received ${esc(run.receivedAt.slice(0, 19).replace('T', ' '))}${run.actor ? ` · by ${esc(run.actor)}` : ''}</span></p>
<p>${run.checkRunUrl ? `<a href="${esc(run.checkRunUrl)}">Check run on GitHub</a> · ` : ''}<a href="/api/runs/${run.id}">Evidence JSON</a> · <a href="/app/?run=${run.id}">Open in the investigation workspace</a> <span class="muted">(loads this run directly)</span></p>
<table><thead><tr><th>Decision</th><th>Model</th><th>Locations</th><th>Next action</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No investigations in this run.</td></tr>'}</tbody></table>`;
  return layout(`${repo.fullName} run ${run.id}`, body, { login });
}

function rank(d: string): number {
  return d === 'patch' ? 0 : d === 'review' ? 1 : 2;
}
