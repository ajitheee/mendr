import { isConfigured, type AppConfig } from '../config.js';
import type { ManifestCredentials } from '../github/api.js';
import { approvalVersion, type Acknowledgement, type Approval, type MigrationRecord, type Repo, type RunRecord, type RunSummary } from '../store/types.js';
import { prNumber } from '../ingest/migrationReport.js';
import { setupWorkflowUrl } from './workflowTemplate.js';
import { registryFreshnessLine, registryFreshnessOf } from '../ingest/registry.js';
import { migrationWorkflowPresent } from '../ingest/migration.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// The App wears the same design system as the landing page (site/index.html):
// ivory ground with faint cobalt/amber/jade tints, carbon ink, hairline rules,
// Instrument Sans for prose and IBM Plex Mono for every data value. It is a
// DASHBOARD, though, not a brochure — summary before detail, state encoded in
// form (a solid tag outranks a tinted one), no motion, one committed light look.
//
// State language, shared with the landing page's tags:
//   solid amber   PATCH ELIGIBLE  — the strongest claim wears the heaviest mark
//   amber tint    REVIEW REQUIRED / inconclusive (a withheld verdict)
//   slate tint    informational   — catalog, docs, fixtures: data, not a dependency
//   jade tint     nothing found / verified
//   red tint      audit failed / retired
const CSS = `
:root{color-scheme:light;
  --ivory:#F4F1EA;--ivory-2:#EEEAE0;--data:#FAF8F3;--carbon:#0B0D10;--ink-2:#33383f;--grey:#747B89;--grey-2:#9aa0a9;
  --cobalt:#315CFF;--amber:#D88916;--jade:#15805D;--red:#B0392C;--hair:#DED7C7;--hair-2:#E7E1D4;
  --sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --maxw:1040px}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--carbon);font-family:var(--sans);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background:radial-gradient(42% 34% at 82% 16%,rgba(49,92,255,.10),transparent 62%),radial-gradient(40% 38% at 14% 60%,rgba(216,137,22,.08),transparent 62%),radial-gradient(34% 32% at 62% 98%,rgba(21,128,93,.06),transparent 62%),var(--ivory);
  background-attachment:fixed}
a{color:var(--cobalt);text-decoration:none}a:hover{text-decoration:underline}
code,pre{font-family:var(--mono)}code{font-size:.88em;color:var(--carbon)}
header.top{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--ivory) 90%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--hair)}
.nav{max-width:var(--maxw);margin:0 auto;padding:16px clamp(18px,4vw,40px);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.mark{display:inline-flex;align-items:center;gap:11px;font-weight:600;font-size:1.06rem;letter-spacing:-.01em;color:var(--carbon)}.mark:hover{text-decoration:none}
.mark .sig{width:16px;height:16px;position:relative;flex:none}
.mark .sig::before{content:"";position:absolute;left:5px;top:1px;bottom:1px;width:2px;background:var(--cobalt)}
.mark .sig::after{content:"";position:absolute;left:5px;top:7px;width:9px;height:2px;background:var(--amber)}
.crumb{font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--grey);padding-left:16px;border-left:1px solid var(--hair)}
.who{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:.92rem;color:var(--grey)}
.who strong{color:var(--carbon);font-weight:500}
main{max-width:var(--maxw);margin:0 auto;padding:36px clamp(18px,4vw,40px) 72px}
h2{margin:34px 0 12px;font-weight:600;font-size:1.3rem;line-height:1.2;letter-spacing:-.015em}
main>h2:first-child{margin-top:0}
h2 a{color:inherit}
p{max-width:66ch;margin:0 0 14px}
.lede{color:var(--grey);font-size:1.05rem}
.muted{color:var(--grey)}
.label,.finding .lbl{font-family:var(--mono);font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--grey)}
.btn{display:inline-flex;align-items:center;gap:9px;font-family:var(--mono);font-size:.84rem;font-weight:500;padding:11px 16px;border-radius:2px;background:var(--carbon);color:var(--ivory);border:0;cursor:pointer;text-decoration:none;line-height:1.2;transition:opacity .14s}
.btn:hover{opacity:.86;text-decoration:none}
.btn.danger{background:var(--red)}
.tlink,.linkbtn{font-family:var(--mono);font-size:.84rem;color:var(--carbon);text-decoration:none;border-bottom:1px solid var(--hair);padding-bottom:2px;background:none;border-top:0;border-left:0;border-right:0;cursor:pointer;line-height:1.2}
.tlink:hover,.linkbtn:hover{border-bottom-color:var(--cobalt);color:var(--cobalt);text-decoration:none}
form.inline{display:inline}
.card,.finding{background:rgba(250,248,243,.55);backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);border:1px solid rgba(255,255,255,.55);box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 16px 46px -22px rgba(11,13,16,.2);border-radius:14px;padding:18px 20px;margin:14px 0}
@media (prefers-reduced-transparency:reduce){.card,.finding{background:var(--data);backdrop-filter:none;-webkit-backdrop-filter:none;border-color:var(--hair)}}
.card p:last-child{margin-bottom:0}
pre{background:var(--data);border:1px solid var(--hair);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:.82rem;line-height:1.65;margin:12px 0}
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th{text-align:left;padding:0 12px 10px;font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--grey-2);font-weight:500;border-bottom:1px solid var(--hair)}
td{padding:14px 12px;border-bottom:1px solid var(--hair);vertical-align:top}
td:first-child,th:first-child{padding-left:0}
.pill,.chip{display:inline-block;font-family:var(--mono);font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:3px;white-space:nowrap;line-height:1.5}
.pill.patch{color:var(--ivory);background:var(--amber)}
.pill.review{color:var(--amber);background:rgba(216,137,22,.12)}
.pill.info,.chip{color:var(--grey);background:rgba(116,123,137,.12)}
.pill.ok,.chip.ok{color:var(--jade);background:rgba(21,128,93,.12)}
.chip.warn{color:var(--amber);background:rgba(216,137,22,.12)}
.pill.bad,.chip.bad{color:var(--red);background:rgba(176,57,44,.12)}
ul.plain{margin:6px 0 0;padding-left:18px}ul.plain li{margin:4px 0}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0 18px}
.finding{position:relative;padding-left:24px}
.finding::before{content:"";position:absolute;left:0;top:16px;bottom:16px;width:2px;background:var(--hair)}
.finding.patch::before{background:var(--amber)}.finding.review::before{background:var(--amber);opacity:.5}.finding.monitor::before{background:var(--grey-2)}
.finding .bar{margin:0 0 6px}
.finding h3{margin:0;font-family:var(--mono);font-size:1.02rem;font-weight:500;letter-spacing:-.01em}
.finding .part{margin-top:12px}
.finding .lbl{margin-bottom:4px}
.locrow{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:3px 0}
.finding .loc{font-family:var(--mono);font-size:.84rem;color:var(--cobalt)}
.finding .part .muted{font-size:.9rem}
.ackform{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.ackform input{font-family:var(--sans);font-size:.9rem;padding:9px 11px;border:1px solid var(--hair);border-radius:2px;background:var(--data);color:var(--carbon);min-width:200px}
.ackform input:focus{outline:2px solid var(--cobalt);outline-offset:1px}
.ackclear{display:inline;margin-left:6px}
.approve{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.approve select{font-family:var(--sans);font-size:.9rem;padding:9px 11px;border:1px solid var(--hair);border-radius:2px;background:var(--data);color:var(--carbon)}
.approve select:focus{outline:2px solid var(--cobalt);outline-offset:1px}
.timeline{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:3px}
.timeline li{font-size:.9rem}
.timeline .t{font-family:var(--mono);font-size:.72rem;color:var(--grey);margin-right:8px}
.foot{max-width:var(--maxw);margin:0 auto;padding:22px clamp(18px,4vw,40px) 40px;border-top:1px solid var(--hair);display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-family:var(--mono);font-size:.74rem;color:var(--grey)}
.foot .fl{display:flex;gap:20px;flex-wrap:wrap}.foot a{color:var(--grey)}.foot a:hover{color:var(--carbon);text-decoration:none}
`;

const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23F4F1EA'/><line x1='30' y1='24' x2='30' y2='76' stroke='%23315CFF' stroke-width='7'/><line x1='30' y1='50' x2='68' y2='50' stroke='%23D88916' stroke-width='7'/></svg>";

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">';

const GITHUB_MARK =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.53.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02 0 2.05.14 3 .4 2.29-1.55 3.3-1.23 3.3-1.23.65 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.28 0 .32.21.7.82.58C20.57 22.29 24 17.8 24 12.5 24 5.87 18.63.5 12 .5Z"/></svg>';

export function layout(title: string, body: string, opts: { login?: string | null } = {}): string {
  const who = opts.login
    ? `<span>signed in as <strong>${esc(opts.login)}</strong></span><form class="inline" method="post" action="/auth/logout"><button type="submit" class="linkbtn">Sign out</button></form>`
    : `<a class="btn" href="/auth/login">${GITHUB_MARK} Sign in with GitHub</a>`;
  const foot =
    '<footer class="foot"><span>mendr · the scan runs in your CI; only findings reach here</span>' +
    '<span class="fl"><a href="https://github.com/ajitheee/mendr/blob/main/TRUST.md">What leaves your infrastructure</a>' +
    '<a href="https://github.com/ajitheee/mendr/blob/main/SECURITY.md">Security</a><a href="https://github.com/ajitheee/mendr">GitHub</a></span></footer>';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="icon" href="${FAVICON}">${FONTS}<style>${CSS}</style></head><body>` +
    `<header class="top"><div class="nav"><a class="mark" href="/"><span class="sig"></span> mendr</a><span class="crumb">${esc(title)}</span><div class="who">${who}</div></div></header>` +
    `<main>${body}</main>${foot}</body></html>`
  );
}

function pill(counts: RunSummary['counts'], conclusion?: string): string {
  const parts: string[] = [];
  // A run that did not conclude must never wear the green "nothing found":
  // inconclusive and failed audits say so first, whatever they counted.
  if (conclusion === 'inconclusive') parts.push('<span class="pill review">inconclusive</span>');
  else if (conclusion === 'audit_failed') parts.push('<span class="pill bad">audit failed</span>');
  if (counts.patch) parts.push(`<span class="pill patch">${counts.patch} patch eligible</span>`);
  if (counts.review) parts.push(`<span class="pill review">${counts.review} review required</span>`);
  if (counts.informational) parts.push(`<span class="pill info">${counts.informational} informational</span>`);
  if (!parts.length) parts.push('<span class="pill ok">nothing found</span>');
  return parts.join(' ');
}

export interface RepoRow {
  repo: Repo;
  /** The newest run, whatever it concluded — the latest attempt. */
  latest: RunSummary | null;
  /** The newest run whose scan completed — what the result rests on. */
  latestCompleted: RunSummary | null;
  /** The repo's default branch, for the one-click setup link. */
  defaultBranch: string;
}

const HOUR = 3_600_000;
/** The generated workflow runs at least daily; more than this much silence is worth a look. */
const QUIET_AFTER_MS = 26 * HOUR;

/** How long ago, for humans: "just now", "3 h ago", "2 d ago". */
function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < HOUR) return 'just now';
  if (ms < QUIET_AFTER_MS) return `${Math.round(ms / HOUR)} h ago`;
  return `${Math.floor(ms / (24 * HOUR))} d ago`;
}

/** Is the daily monitoring alive? Proven by evidence arriving, not by a schedule existing. */
function monitoringChip(latest: RunSummary | null, now: Date): string {
  if (!latest) return '<span class="chip">not connected</span>';
  const ms = now.getTime() - Date.parse(latest.receivedAt);
  if (!Number.isFinite(ms) || ms <= QUIET_AFTER_MS) return `<span class="chip ok">active</span> <span class="muted">${esc(ago(latest.receivedAt, now))}</span>`;
  const days = Math.floor(ms / (24 * HOUR));
  return `<span class="chip warn" title="No run in ${days} days. The daily workflow may be paused — GitHub pauses schedules on a public repository with no activity for 60 days.">quiet · ${days} d</span>`;
}

const ATTEMPT_LABEL: Record<string, string> = { inconclusive: 'inconclusive', audit_failed: 'audit failed' };

/** The one-click "add the audit workflow" link for a repo, or '' when the App is unconfigured. */
function setupLink(config: AppConfig, fullName: string, defaultBranch: string): string {
  if (!isConfigured(config)) return '';
  const url = setupWorkflowUrl({
    webUrl: config.githubWebUrl,
    repoFullName: fullName,
    appUrl: config.appUrl,
    audience: config.oidcAudience,
    mendrSpec: config.mendrSpec,
    defaultBranch,
  });
  return `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Set up the audit</a>`;
}

export function homePage(input: { config: AppConfig; configured: boolean; login: string | null; rows: RepoRow[]; now?: Date }): string {
  const { config, configured, login, rows } = input;
  const now = input.now ?? new Date();
  const setup = configured
    ? ''
    : `<div class="card"><strong>Not configured yet.</strong> Create the GitHub App from its manifest at <a href="/setup">/setup</a>, put the printed credentials in the environment, and restart.</div>`;
  const install = configured && config.githubAppSlug ? `<p><a class="btn" href="${esc(config.githubWebUrl)}/apps/${esc(config.githubAppSlug)}/installations/new">Install on a repository</a></p>` : '';
  let list: string;
  if (!login) {
    list = `<p class="muted">Sign in to see the repositories where the App is installed and that you can access.</p>`;
  } else if (!rows.length) {
    list = `<p class="muted">No installed repository is visible to you yet. Install the App on a repository, then set up its audit from here.</p>`;
  } else {
    list = `<div class="tbl"><table><thead><tr><th>Repository</th><th>Last completed scan</th><th>Result</th><th>Monitoring</th></tr></thead><tbody>${rows
      .map(({ repo, latest, latestCompleted, defaultBranch }) => {
        const runLink = (r: RunSummary) =>
          `<a href="/r/${esc(repo.fullName)}/runs/${r.id}">${esc(r.receivedAt.slice(0, 16).replace('T', ' '))}</a> <span class="muted">${esc(r.ref.replace(/^refs\/heads\//, ''))} @ ${esc(r.sha.slice(0, 7))}</span>`;
        // The newest COMPLETED scan is what the result rests on. A newer attempt
        // that did not complete (inconclusive, failed) is shown beneath it — never
        // in its place, and never hidden.
        const attempt =
          latest && (!latestCompleted || latest.id !== latestCompleted.id)
            ? `<div class="muted" style="margin-top:4px;font-size:.9rem">latest attempt <a href="/r/${esc(repo.fullName)}/runs/${latest.id}">${esc(latest.receivedAt.slice(0, 16).replace('T', ' '))}</a> · ${esc(ATTEMPT_LABEL[latest.conclusion] ?? latest.conclusion)}</div>`
            : '';
        // A repo with no run yet is not connected: its first audit needs the
        // workflow, so offer the one-click setup instead of "no run received".
        const when = latestCompleted ? runLink(latestCompleted) + attempt : latest ? `<span class="muted">none yet</span>${attempt}` : setupLink(config, repo.fullName, defaultBranch);
        const result = latestCompleted
          ? pill(latestCompleted.counts, latestCompleted.conclusion)
          : latest
            ? pill(latest.counts, latest.conclusion)
            : '<span class="muted">no run yet — add the workflow</span>';
        return `<tr><td><a href="/r/${esc(repo.fullName)}">${esc(repo.fullName)}</a></td><td>${when}</td><td>${result}</td><td>${monitoringChip(latest, now)}</td></tr>`;
      })
      .join('')}</tbody></table></div>
<p class="muted" style="font-size:.9rem;margin-top:12px">Connected repositories are scanned on every push and pull request, and daily at 06:37 UTC, by the generated workflow. A repository with no run for more than a day is marked quiet — check that its workflow is enabled.</p>`;
  }
  const body = `${setup}<p class="lede">Connect a repository and Mendr keeps its retiring-AI-model findings current here, with a <em>Mendr audit</em> check on every commit. The scan runs in your own CI; the App never clones or stores your code. <a href="https://github.com/ajitheee/mendr/blob/main/TRUST.md">What leaves your infrastructure</a>.</p>${install}<h2>Repositories</h2>${list}`;
  return layout('overview', body, { login });
}

export function setupPage(input: { manifest: string; target: string; configured: boolean; appUrl: string }): string {
  const warn = input.configured ? `<div class="card"><strong>Already configured.</strong> Creating another App here would produce a second set of credentials; only continue if you mean to replace it.</div>` : '';
  const body = `${warn}<p>GitHub will create the App from this manifest and redirect back here with its credentials. The App asks for <code>checks: write</code> and <code>metadata: read</code> only; it cannot read repository contents.</p>
<form method="post" action="${esc(input.target)}"><input type="hidden" name="manifest" value="${esc(input.manifest)}"><button type="submit" class="btn">Create the GitHub App</button></form>
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

export function installedPage(_config: AppConfig): string {
  const body = `<div class="card"><strong>Installed.</strong> One step left to connect a repository: add the audit workflow.</div>
<p>On the overview, each installed repository has a <strong>Set up the audit</strong> button. It opens GitHub's own new-file editor with the workflow filled in — you read it and commit it. The App writes nothing to your repo; the scan runs in your CI and sends only findings here.</p>
<p><a class="btn" href="/">Go to the overview</a></p>`;
  return layout('installed', body);
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<div class="card"><strong>${esc(title)}.</strong> ${esc(message)}</div><p><a href="/">Back</a></p>`);
}

export function runsPage(repo: Repo, runs: RunSummary[], login: string, setupUrl?: string): string {
  if (!runs.length) {
    const cta = setupUrl
      ? `<div class="card"><strong>Not connected yet.</strong> Add the audit workflow to start receiving runs. <a class="btn" href="${esc(setupUrl)}" target="_blank" rel="noopener">Set up the audit</a><p class="muted" style="margin:10px 0 0">Opens GitHub's new-file editor with the workflow filled in. You commit it; the scan runs in your CI.</p></div>`
      : `<p class="muted">No runs received yet.</p>`;
    return layout(repo.fullName, `<h2>${esc(repo.fullName)}</h2>${cta}`, { login });
  }
  const rows = runs
    .map(
      (r) =>
        `<tr><td><a href="/r/${esc(repo.fullName)}/runs/${r.id}">${esc(r.receivedAt.slice(0, 19).replace('T', ' '))}</a></td><td><span class="muted">${esc(r.ref.replace(/^refs\/heads\//, ''))}</span> @ <code>${esc(r.sha.slice(0, 7))}</code></td><td>${pill(r.counts, r.conclusion)}</td><td>${r.checkRunUrl ? `<a href="${esc(r.checkRunUrl)}">check</a>` : '<span class="muted">no check</span>'}</td></tr>`,
    )
    .join('');
  const del = `<h2>Stored data</h2><p class="muted">Delete every stored run for this repository now. Uninstalling the App does this automatically; this is the same, on demand.</p><form method="post" action="/r/${esc(repo.fullName)}/delete" onsubmit="return confirm('Delete all stored findings for ${esc(repo.fullName)}? This cannot be undone.')"><button type="submit" class="btn danger">Delete stored data</button></form>`;
  const body = `<h2>${esc(repo.fullName)}</h2><div class="tbl"><table><thead><tr><th>Received</th><th>Commit</th><th>Result</th><th>Check run</th></tr></thead><tbody>${rows}</tbody></table></div>${del}`;
  return layout(repo.fullName, body, { login });
}

const LABEL: Record<string, string> = { patch: 'PATCH ELIGIBLE', review: 'REVIEW REQUIRED', monitor: 'INFORMATIONAL' };
const CLASS: Record<string, string> = { patch: 'patch', review: 'review', monitor: 'info' };

type Loc = RunRecord['report']['investigations'][number]['locations']['selectors'][number];
type Inv = RunRecord['report']['investigations'][number];

/** A GitHub blob deep link to an exact line — "Open in GitHub". */
function blobUrl(webUrl: string, fullName: string, sha: string, file: string, line: number): string {
  const path = String(file).replace(/^\.?\//, '').replace(/\\/g, '/');
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/blob/${sha}/${path}#L${line}`;
}

/** The GitHub tree at the scanned commit. */
function treeUrl(webUrl: string, fullName: string, sha: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/tree/${sha}`;
}

/** The Actions page for the audit workflow — "Rerun audit" (Run workflow lives there). */
export function workflowRunsUrl(webUrl: string, fullName: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${fullName}/actions/workflows/mendr-audit.yml`;
}

/** Links for the migration workflow: the one-time add (GitHub's prefilled editor) and its Actions page. */
export interface MigrateLinks {
  setupUrl: string;
  runUrl: string;
}

/**
 * Everything a finding card needs, gathered once per page: the run and repo,
 * what mendr-action last reported, who acknowledged what, the latest approval
 * per finding, and whether the repository's migration workflow is listening.
 */
export interface CardContext {
  repo: Repo;
  run: RunRecord;
  webUrl: string;
  migrate: MigrateLinks | undefined;
  migration: MigrationRecord | null;
  acks: Map<string, Acknowledgement> | undefined;
  /** The latest approval per `${provider}/${model}`, whatever its status. */
  approvals: Map<string, Approval> | undefined;
  /** When the repo's migration workflow last asked for approvals (null: never). */
  migrateSeenAt: string | null;
  /** What the scanner saw in .github/workflows (null: an older report). */
  workflowPresent: boolean | null;
  now: Date;
}

const GATE_LABEL = { typeCheck: 'type-check', build: 'build', tests: 'tests', eval: 'eval' } as const;
const GATE_GLYPH: Record<string, string> = { pass: '✓', fail: '✗', inconclusive: '?', 'not-configured': '—' };

function gatesLine(m: MigrationRecord): string {
  const g = m.report.gates;
  if (!g) return '';
  return (Object.keys(GATE_LABEL) as (keyof typeof GATE_LABEL)[]).map((k) => `${GATE_LABEL[k]} ${GATE_GLYPH[g[k]] ?? '?'}`).join(' · ');
}

function prLink(m: MigrationRecord): string {
  return m.prUrl ? `<a href="${esc(m.prUrl)}" target="_blank" rel="noopener">PR ${esc(prNumber(m.prUrl))} ↗</a>` : '';
}

/**
 * One line for what mendr-action last reported: the verdict first, then the
 * evidence behind it. "verified" here means the sandbox gates passed and a PR
 * exists — never that anything was merged or that behavior was tested unless
 * an eval ran.
 */
function migrationStatus(m: MigrationRecord): string {
  const when = `${esc(m.receivedAt.slice(0, 16).replace('T', ' '))} from <code>${esc(m.sha.slice(0, 7))}</code>`;
  const gates = gatesLine(m);
  switch (m.outcome) {
    case 'migration-proposed':
      return `<span class="chip ok">verified</span> ${prLink(m)}${gates ? ` · ${gates}` : ''} · ${when}${m.report.behavioralTested ? '' : ' · <span class="muted">behavior not tested</span>'}`;
    case 'not-verified':
      return `<span class="chip warn">not verified — nothing applied, no PR</span>${gates ? ` · ${gates}` : ''} · ${when}`;
    case 'clean':
      return `<span class="chip ok">nothing to migrate</span> · ${when}`;
    default:
      return `<span class="chip bad">migration run failed — nothing applied</span> · ${when}`;
  }
}

/** The "Migration" card: is the repository's migration workflow listening, and what did it last do. */
function migrationCard(ctx: CardContext, patchCount: number): string {
  const { migrate, migration, migrateSeenAt, workflowPresent } = ctx;
  if (!migrate || (patchCount === 0 && !migration)) return '';
  const listening = migrateSeenAt
    ? `<span class="chip ok">migration workflow active</span><span class="muted">last checked for approvals ${esc(ago(migrateSeenAt, ctx.now))}</span>`
    : workflowPresent === true
      ? `<span class="chip ok">migration workflow present</span><span class="muted">it checks for your approvals hourly, and at once when Mendr may start it</span>`
      : workflowPresent === false
        ? `<span class="chip warn">migration workflow not added yet</span><a class="btn" href="${esc(migrate.setupUrl)}" target="_blank" rel="noopener">Add it once ↗</a><span class="muted">GitHub's editor opens with the workflow filled in — read it and commit it</span>`
        : `<span class="chip">migration workflow not seen yet</span><a class="tlink" href="${esc(migrate.setupUrl)}" target="_blank" rel="noopener">add it if you haven't ↗</a>`;
  const status = migration ? `<div class="part"><div class="label">Latest migration run</div><div>${migrationStatus(migration)}</div></div>` : '';
  return `<div class="card" id="migrate"><div class="label">Migration</div>
<p>Approve a migration on a finding below and your own CI carries it out: Mendr verifies the swap on a throwaway copy — type-check, build, your tests — and opens <strong>one pull request</strong> only if it all passes. It never touches your default branch, and merges only if you choose that when you approve. The App gains no access to your code: it records your decision and what your CI reports back.</p>
<div class="bar">${listening}</div>${status}</div>`;
}

const STAGE_LABEL: Record<string, string> = {
  queued: 'queued',
  dispatched: 'workflow started',
  claimed: 'picked up by your CI',
  verifying: 'verifying on a throwaway copy',
  verified: 'verified',
  'not-verified': 'not verified — nothing applied',
  applying: 'applying the swap',
  pushed: 'branch pushed',
  pr: 'pull request open',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** The decision on a patch-eligible finding: the Approve form, or the approval's status and timeline. */
function approvalPart(inv: Inv, ctx: CardContext, approval: Approval | null, back: string, replacement: string): string {
  const repoName = esc(ctx.repo.fullName);
  const inFlight = !!approval && (approval.status === 'queued' || approval.status === 'running');
  if (approval && (inFlight || approval.status === 'done')) {
    const last = approval.events[approval.events.length - 1];
    const head =
      approval.status === 'queued'
        ? `<span class="chip warn">queued</span> <span class="muted">${approval.dispatchedAt ? 'workflow started — waiting for your CI to pick it up' : 'starts when your CI next checks (within the hour)'}</span>`
        : approval.status === 'running'
          ? `<span class="chip warn">running</span> <span class="muted">${esc(STAGE_LABEL[last?.stage ?? 'claimed'] ?? '')}</span>`
          : `<span class="chip ok">done</span> <span class="muted">${esc(last?.detail ?? '')}</span>`;
    const events = approval.events
      .map((e) => `<li><span class="t">${esc(e.at.slice(11, 16))}</span>${esc(STAGE_LABEL[e.stage] ?? e.stage)}${e.detail ? ` <span class="muted">— ${esc(e.detail)}</span>` : ''}</li>`)
      .join('');
    const cancel =
      approval.status === 'queued'
        ? `<form method="post" action="/r/${repoName}/approve/cancel" class="ackclear"><input type="hidden" name="id" value="${approval.id}"><input type="hidden" name="back" value="${esc(back)}"><button class="linkbtn" type="submit">Cancel</button></form>`
        : '';
    const mode = approval.mode === 'auto-merge' ? 'pull request, merged when checks pass' : 'pull request for review';
    return `<div data-approval="${approval.id}" data-version="${esc(approvalVersion(approval))}">Approved by <strong>${esc(approval.approvedBy)}</strong> on ${esc(approval.createdAt.slice(0, 16).replace('T', ' '))} · ${esc(mode)}${approval.replacement ? ` · to <code>${esc(approval.replacement)}</code>` : ''} · ${head}${cancel}<ol class="timeline">${events}</ol></div>`;
  }
  // Failed or cancelled earlier, or never approved: offer the decision, with the
  // earlier outcome stated — never hidden.
  const lastDetail = approval?.events[approval.events.length - 1]?.detail;
  const earlier = approval
    ? `<div class="muted" style="margin-bottom:6px">Earlier approval by ${esc(approval.approvedBy)} on ${esc(approval.createdAt.slice(0, 10))}: <span class="chip${approval.status === 'failed' ? ' bad' : ''}">${esc(approval.status)}</span>${lastDetail ? ` — ${esc(lastDetail)}` : ''}</div>`
    : '';
  if (!ctx.migrate) return earlier;
  const listening = !!ctx.migrateSeenAt || ctx.workflowPresent !== false;
  if (!listening) {
    return `${earlier}<div class="muted">To approve migrations from here, <a class="tlink" href="${esc(ctx.migrate.setupUrl)}" target="_blank" rel="noopener">add the migration workflow once ↗</a> — GitHub's editor opens with it filled in; read it and commit it. It then checks for your approvals hourly.</div>`;
  }
  const hidden = `<input type="hidden" name="provider" value="${esc(inv.provider)}"><input type="hidden" name="model" value="${esc(inv.model)}"><input type="hidden" name="replacement" value="${esc(replacement)}"><input type="hidden" name="back" value="${esc(back)}">`;
  return `${earlier}<form method="post" action="/r/${repoName}/approve" class="approve">${hidden}<select name="mode" aria-label="What to do once the migration verifies"><option value="pr">open a pull request for review</option><option value="auto-merge">open a pull request and merge it when checks pass</option></select><button class="btn" type="submit">Approve migration to ${esc(replacement)}</button></form><div class="muted">Your CI verifies the swap on a throwaway copy — type-check, build, your tests — and opens the pull request only if it all passes. Mendr never touches your default branch.</div>`;
}

/**
 * A resolution is confirmed by evidence, never by an event: a model that was
 * actionable in the previous run and is absent from THIS run — and only when
 * this run is a completed scan on a fresh registry, so absence means absence.
 */
function resolvedCard(run: RunRecord, previous: RunRecord | null, migration: MigrationRecord | null): string {
  if (!previous) return '';
  const completed = run.conclusion === 'no_exposure_in_completed_surfaces' || run.conclusion === 'exposure_detected';
  if (!completed || registryFreshnessOf(run.report).freshness !== 'fresh') return '';
  const now = new Set(run.report.investigations.filter((i) => i.decision !== 'monitor').map((i) => `${i.provider}/${i.model}`));
  const gone = previous.report.investigations.filter((i) => i.decision !== 'monitor' && !now.has(`${i.provider}/${i.model}`));
  if (!gone.length) return '';
  const items = gone
    .map((i) => {
      const swap = migration?.report.migrations.find((s) => s.from === i.model);
      const via = swap && migration?.prUrl ? ` — via ${prLink(migration)}` : '';
      return `<li><code>${esc(i.model)}</code> (${esc(i.provider)}) no longer found${via}</li>`;
    })
    .join('');
  return `<div class="card"><div class="label">Resolved since run ${previous.id}</div>
<p>Confirmed by this completed scan of <code>${esc(run.sha.slice(0, 7))}</code> against a fresh registry — not by a merge event.</p>
<ul class="plain">${items}</ul></div>`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * While an approval is in flight the page keeps itself current: every 5 s it
 * asks the App for the approval's version (status + event count, over the same
 * signed-in session) and reloads once it changes. Plain script, no library.
 */
const LIVE_SCRIPT = [
  '<script>(function(){',
  "var live=[].slice.call(document.querySelectorAll('[data-approval]')).filter(function(e){return /^(queued|running):/.test(e.getAttribute('data-version')||'')});",
  'if(!live.length)return;',
  'function tick(){Promise.all(live.map(function(e){',
  "return fetch('/api/approvals/'+e.getAttribute('data-approval'),{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null})",
  ".then(function(j){return !!j&&j.version!==e.getAttribute('data-version')}).catch(function(){return false})",
  '})).then(function(changed){if(changed.some(Boolean))location.reload();else setTimeout(tick,5000)})}',
  'setTimeout(tick,5000)})()</script>',
].join('');

/** One finding, laid out as the six things a reader needs, in order. */
function findingCard(inv: Inv, ctx: CardContext): string {
  const { repo, run, webUrl, migration } = ctx;
  const key = `${inv.provider}/${inv.model}`;
  const ack = ctx.acks?.get(key) ?? null;
  const approval = ctx.approvals?.get(key) ?? null;
  const ev = inv.retirementEvidence ?? {};
  const decision = inv.decision;
  const anchor = `f-${slug(`${inv.provider}-${inv.model}`)}`;
  const back = `/r/${repo.fullName}/runs/${run.id}#${anchor}`;

  // 1. Possible cause — never "the cause": only runtime evidence could prove that.
  const deadline = ev.shutdownDate
    ? `${ev.status ?? 'retiring'}, shutdown ${esc(ev.shutdownDate)}${typeof ev.daysUntil === 'number' ? ` (${ev.daysUntil < 0 ? `${-ev.daysUntil} days past` : `${ev.daysUntil} days left`})` : ''}`
    : (ev.status ?? 'listed');
  const cause = `<strong>${esc(inv.model)}</strong> (${esc(inv.provider)}) is ${deadline}. If your code calls it, this retired model may be the reason a request is failing.`;

  // 2. Evidence — exact locations, each a link into GitHub.
  const locs = inv.locations.selectors.slice(0, 12);
  const evidence = locs.length
    ? locs
        .map((l: Loc) => {
          const surface = l.surface === 'config' ? `config${l.providerSurface ? ` · ${esc(l.providerSurface)}` : ''}` : `code${l.role ? ` · ${esc(String(l.role).replace(/_/g, ' '))}` : ''}`;
          const read = l.readerTieBack?.proven ? ' · <span class="chip ok">read by code</span>' : '';
          return `<div class="locrow"><a class="loc" href="${esc(blobUrl(webUrl, repo.fullName, run.sha, l.file, l.line))}" target="_blank" rel="noopener">${esc(l.file)}:${l.line} ↗</a><span class="muted">${surface}${read}</span></div>`;
        })
        .join('')
    : '<span class="muted">No proven call site — this model appears only in catalog, docs or fixture data.</span>';
  const more = inv.locations.selectors.length > 12 ? `<div class="muted">… ${inv.locations.selectors.length - 12} more</div>` : '';

  // 3. Confidence boundary — say exactly what is and isn't proven.
  const usage = inv.productionUsage;
  const prod = usage === 'observed' ? '<span class="chip warn">production traffic observed</span>' : usage === 'not_observed' ? '<span class="chip">not seen in the connected source</span>' : '<span class="chip">production traffic not measured</span>';
  const repoConfirmed = locs.length ? '<span class="chip ok">repository usage confirmed</span>' : '<span class="chip">no repository call site</span>';

  // 4. Migration — the evidence (replacement and its verdict), what mendr-action
  //    last reported for THIS model, and the decision: approve here, your CI does
  //    the work. Nothing is ever applied from this page.
  const swap = migration?.report.migrations.find((s) => s.from === inv.model);
  const ran = swap && migration ? `<div style="margin-top:6px">Migration run: ${migrationStatus(migration)}</div>` : '';
  const evidenceLine = ev.replacement
    ? `Replacement <code>${esc(ev.replacement)}</code> — <span class="chip ${ev.replacementVerdict === 'verified' ? 'ok' : 'warn'}">${esc(ev.replacementVerdict ?? 'unstamped')}</span>.${ev.sourceUrl ? ` <a href="${esc(ev.sourceUrl)}" target="_blank" rel="noopener">provider notice ↗</a>` : ''}`
    : 'No safe replacement recommended yet — monitor the provider.';
  const decide = decision === 'patch' && ev.replacement ? approvalPart(inv, ctx, approval, back, ev.replacement) : '';
  const migrationPart = evidenceLine + ran + (decide ? `<div style="margin-top:8px">${decide}</div>` : '');

  // 5. Next action — the CLI's own wording, so the UI never drifts.
  const next = esc(inv.nextAction ?? inv.reason ?? '');

  // 6. Ownership — who has seen this and who owns the follow-up. A note ABOUT
  //    the finding, keyed by repo + model so it follows the finding across runs.
  //    It never moves the status — only a completed scan can — and clearing it
  //    is one click. The acknowledging login comes from the session, not the form.
  const hidden = `<input type="hidden" name="provider" value="${esc(inv.provider)}"><input type="hidden" name="model" value="${esc(inv.model)}"><input type="hidden" name="back" value="${esc(back)}">`;
  const ownership = ack
    ? `<span class="chip ok">acknowledged</span> Acknowledged by <strong>${esc(ack.acknowledgedBy)}</strong> on ${esc(ack.createdAt.slice(0, 10))}${ack.owner ? ` · owner <strong>${esc(ack.owner)}</strong>` : ''}${ack.note ? ` · <span class="muted">“${esc(ack.note)}”</span>` : ''} · <form method="post" action="/r/${esc(repo.fullName)}/ack/clear" class="ackclear">${hidden}<button class="linkbtn" type="submit">Clear</button></form>`
    : `<form method="post" action="/r/${esc(repo.fullName)}/ack" class="ackform">${hidden}<input name="owner" placeholder="owner — a login, team or name" maxlength="80" aria-label="Owner"><input name="note" placeholder="note (optional)" maxlength="400" aria-label="Note"><button class="btn" type="submit">Acknowledge</button></form><div class="muted">Records who owns the follow-up. It does not change the result — only a completed scan can.</div>`;

  const part = (label: string, html: string): string => `<div class="part"><div class="lbl">${label}</div><div>${html}</div></div>`;
  return `<div class="finding ${decision}" id="${anchor}">
    <div class="bar"><span class="pill ${CLASS[decision]}">${LABEL[decision]}</span><h3 style="display:inline">${esc(inv.model)}</h3></div>
    ${part('Possible cause', cause)}
    ${part('Evidence', evidence + more)}
    ${part('Confidence boundary', `${repoConfirmed} ${prod}`)}
    ${part('Migration', migrationPart)}
    ${part('Next action', next)}
    ${part('Ownership', ownership)}
  </div>`;
}

export interface RunPageOptions {
  webUrl: string;
  workflowUrl: string;
  migrate?: MigrateLinks;
  migration?: MigrationRecord | null;
  previous?: RunRecord | null;
  acks?: Map<string, Acknowledgement>;
  /** The latest approval per `${provider}/${model}`, whatever its status. */
  approvals?: Map<string, Approval>;
  migrateSeenAt?: string | null;
  now?: Date;
}

export function runPage(repo: Repo, run: RunRecord, login: string, opts: RunPageOptions): string {
  const invs = [...run.report.investigations].sort((a, b) => rank(a.decision) - rank(b.decision));
  const ctx: CardContext = {
    repo,
    run,
    webUrl: opts.webUrl,
    migrate: opts.migrate,
    migration: opts.migration ?? null,
    acks: opts.acks,
    approvals: opts.approvals,
    migrateSeenAt: opts.migrateSeenAt ?? null,
    workflowPresent: migrationWorkflowPresent(run.report),
    now: opts.now ?? new Date(),
  };
  const card = (i: Inv): string => findingCard(i, ctx);
  const actionable = invs.filter((i) => i.decision !== 'monitor');
  const info = invs.filter((i) => i.decision === 'monitor');
  const migration = migrationCard(ctx, actionable.filter((i) => i.decision === 'patch').length) + resolvedCard(run, opts.previous ?? null, opts.migration ?? null);

  // The registry the verdict rests on, and how current it was. A stale registry
  // is why a zero-finding run reads `inconclusive` rather than clean.
  const reg = registryFreshnessOf(run.report);
  const regChip = reg.freshness === 'unknown' ? '' : ` <span class="chip ${reg.freshness === 'fresh' ? 'ok' : 'warn'}">registry: ${esc(registryFreshnessLine(reg))}</span>`;

  // A run with nothing actionable is only "nothing needs action" when the audit
  // actually concluded that. Inconclusive and failed runs must never read as clean.
  const quiet =
    run.conclusion === 'no_exposure_in_completed_surfaces'
      ? `<div class="card"><strong>Nothing needs action.</strong> ${info.length ? `${info.length} informational reference(s) only.` : 'No retiring model dependencies in the completed surfaces.'}</div>`
      : run.conclusion === 'inconclusive'
        ? `<div class="card"><strong>Inconclusive — not a clean result.</strong> No actionable finding, but this scan cannot prove absence: ${esc(
            reg.freshness === 'stale' ? (reg.reason ?? 'the deprecation registry it used was not provably fresh') : 'too little of the repository was analyzed (see coverage in the evidence JSON)',
          )}.</div>`
        : run.conclusion === 'audit_failed'
          ? '<div class="card"><strong>Audit failed.</strong> A surface did not complete; this result must not be read as clean.</div>'
          : `<div class="card"><strong>Nothing needs action.</strong> ${info.length ? `${info.length} informational reference(s) only.` : ''}</div>`;

  const header = `<h2><a href="/r/${esc(repo.fullName)}">${esc(repo.fullName)}</a> <span class="muted">· ${esc(run.ref.replace(/^refs\/heads\//, ''))} @ <a href="${esc(treeUrl(opts.webUrl, repo.fullName, run.sha))}" target="_blank" rel="noopener">${esc(run.sha.slice(0, 7))} ↗</a></span></h2>
<div class="bar">${pill(run.counts, run.conclusion)} <span class="muted">conclusion <code>${esc(run.conclusion)}</code> · received ${esc(run.receivedAt.slice(0, 19).replace('T', ' '))}${run.actor ? ` · by ${esc(run.actor)}` : ''}</span>${regChip}</div>
<div class="bar">${run.checkRunUrl ? `<a class="btn" href="${esc(run.checkRunUrl)}" target="_blank" rel="noopener">Check run on GitHub ↗</a>` : ''}<a class="btn" href="${esc(opts.workflowUrl)}" target="_blank" rel="noopener">Rerun audit ↗</a><a class="tlink" href="/api/runs/${run.id}">Evidence JSON</a></div>`;

  const body = actionable.length
    ? `${header}${migration}<h2>Action needed (${actionable.length})</h2>${actionable.map(card).join('')}${info.length ? `<h2>Informational (${info.length})</h2><p class="muted">Catalog, documentation or fixture references — not dependencies. No migration action; monitor the provider.</p>${info.map(card).join('')}` : ''}`
    : `${header}${migration}${quiet}${info.map(card).join('')}`;

  return layout(`${repo.fullName} run ${run.id}`, body + LIVE_SCRIPT, { login });
}

function rank(d: string): number {
  return d === 'patch' ? 0 : d === 'review' ? 1 : 2;
}
