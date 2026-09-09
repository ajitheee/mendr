import { describe, expect, it } from 'vitest';
import {
  auditWorkflowYaml,
  MENDR_AUDIT_WORKFLOW_PATH,
  MENDR_MIGRATE_WORKFLOW_PATH,
  migrateActionsUrl,
  migrateWorkflowYaml,
  newWorkflowFileUrl,
  setupMigrateWorkflowUrl,
  setupWorkflowUrl,
} from './workflowTemplate.js';

const OPTS = { appUrl: 'https://app.example', audience: 'mendr', mendrSpec: 'v0.3.0-alpha', defaultBranch: 'trunk' };

describe('auditWorkflowYaml', () => {
  const yaml = auditWorkflowYaml(OPTS);

  it('is least-privilege: contents:read + id-token:write, no write scopes or secrets', () => {
    expect(yaml).toContain('contents: read');
    expect(yaml).toContain('id-token: write');
    expect(yaml).not.toMatch(/^\s+contents: write/m);
    expect(yaml).not.toMatch(/^\s+pull-requests: write/m);
    expect(yaml).not.toContain('${{ secrets.'); // no repository secret is read
  });

  it('sends only the audit JSON to this App, proven by OIDC (no shared secret)', () => {
    expect(yaml).toContain('MENDR_APP_URL: https://app.example');
    expect(yaml).toContain('audience=mendr');
    expect(yaml).toContain('/api/ingest');
    expect(yaml).toContain('--data-binary @mendr-audit.json');
    expect(yaml).toContain('audit . \\');
  });

  it('keeps GitHub ${{ }} expressions literal and pins the CLI to a ref', () => {
    expect(yaml).toContain("${{ vars.MENDR_SPEC || 'v0.3.0-alpha' }}");
    expect(yaml).toContain('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(yaml).toContain('branches: [trunk]');
    expect(yaml).toContain('persist-credentials: false');
  });

  it('runs on a daily schedule as well as push/PR/manual, so an idle repo still re-scans', () => {
    // The daily run is what catches a newly announced retirement when no code
    // has changed. Off-the-hour, because GitHub throttles :00 schedules.
    expect(yaml).toMatch(/^\s+schedule:\n\s+- cron: '\d{1,2} \d{1,2} \* \* \*'/m);
    expect(yaml).not.toMatch(/cron: '0 /); // never on the hour
    expect(yaml).toContain('pull_request: {}');
    expect(yaml).toContain('workflow_dispatch: {}');
  });

  it('turns the signed registry refresh on VISIBLY (an env var an older pinned release ignores)', () => {
    // An unknown env var is harmless to v0.3.0-alpha; an unknown flag would fail
    // it. The comment block discloses the one extra outbound GET.
    expect(yaml).toContain("MENDR_REGISTRY_REFRESH: 'on'");
    expect(yaml).toMatch(/^# NETWORK:/m);
    expect(yaml).not.toContain('--refresh-registry');
  });

  it('delivers the evidence BEFORE failing the step on an inconclusive or failed audit', () => {
    // A zero-finding scan on a stale registry exits 3. The report must still
    // reach the App (so the dashboard never shows a stale "last good run" as
    // current), and the step must still fail truthfully afterwards.
    const post = yaml.indexOf('/api/ingest');
    const status = yaml.indexOf('MENDR_STATUS=$?');
    const exit = yaml.indexOf('exit $MENDR_STATUS');
    expect(status).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(status);
    expect(exit).toBeGreaterThan(post);
    expect(yaml).toContain('if [ -s mendr-audit.json ]; then'); // a usage error (no report) posts nothing
  });

  it('retries the upload so a sleeping App or a blip does not lose evidence (the POST is idempotent per attempt)', () => {
    expect(yaml).toMatch(/curl -sS --fail-with-body --retry 4 --retry-delay 5 --retry-all-errors --max-time 120 -X POST "\$MENDR_APP_URL\/api\/ingest"/);
    expect(yaml).toMatch(/TOKEN=\$\(curl -sS --retry 3 --retry-delay 2 --retry-all-errors/);
  });
});

describe('newWorkflowFileUrl / setupWorkflowUrl', () => {
  it('deep-links to GitHub\'s prefilled new-file editor with the workflow path and content', () => {
    const url = newWorkflowFileUrl('https://github.com', 'acme/api', 'trunk', 'name: mendr audit\n');
    expect(url.startsWith('https://github.com/acme/api/new/trunk?')).toBe(true);
    expect(url).toContain(`filename=${encodeURIComponent(MENDR_AUDIT_WORKFLOW_PATH)}`);
    expect(url).toContain(`value=${encodeURIComponent('name: mendr audit\n')}`);
  });

  it('setupWorkflowUrl embeds the generated workflow for the repo and branch', () => {
    const url = setupWorkflowUrl({ ...OPTS, webUrl: 'https://github.com', repoFullName: 'acme/api' });
    expect(url).toContain('/acme/api/new/trunk?');
    // the encoded value round-trips to the actual workflow
    const value = decodeURIComponent(new URL(url).searchParams.get('value')!);
    expect(value).toBe(auditWorkflowYaml(OPTS));
  });
});

describe('migrateWorkflowYaml / setupMigrateWorkflowUrl — carrying out approvals made in the App', () => {
  const yaml = migrateWorkflowYaml({ mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example' });

  it('runs on a schedule and when the App starts it — never on push — with the two write scopes the branch and the PR need plus id-token', () => {
    expect(yaml).toMatch(/^\s+schedule:\n\s+- cron: '17 \* \* \* \*'/m); // hourly on a public repo
    expect(yaml).toMatch(/^\s+workflow_dispatch:\n\s+inputs:\n\s+approval:/m);
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
    expect(yaml).toMatch(/permissions:\n  contents: write\n  pull-requests: write\n  id-token: write\n/);
    expect(yaml).not.toMatch(/^\s+(issues|actions|checks): /m);
    expect(yaml).not.toContain('${{ secrets.');
    expect(yaml).toContain('app-url: https://app.example'); // approvals come from, and progress goes to, THIS App
    expect(yaml).toContain("approval-gated: 'true'"); // only what a person approved
    expect(yaml).toContain('approval: ${{ inputs.approval }}');
  });

  it('checks less often on a private repository, where every check costs Actions minutes', () => {
    const priv = migrateWorkflowYaml({ mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example', private: true });
    expect(priv).toMatch(/- cron: '17 \*\/3 \* \* \*'/);
    expect(priv).toContain('every three hours on a private repo');
  });

  it('pins the action and the CLI it runs to the same release', () => {
    expect(yaml).toContain('uses: ajitheee/mendr/mendr-action@v0.3.0-alpha');
    expect(yaml).toContain('mendr-spec: github:ajitheee/mendr#v0.3.0-alpha');
    expect(yaml).not.toContain('@main');
  });

  it('says what it does and does not do, in the file the customer commits', () => {
    expect(yaml).toMatch(/never touches your default branch/);
    expect(yaml).toMatch(/auto-merge only if you chose that when you approved/);
    expect(yaml).toMatch(/ONLY if the verdict is `verified`/);
    expect(yaml).toMatch(/nothing approved ends in seconds/);
  });

  it('deep-links to the prefilled editor at the migration path, and to the Actions page', () => {
    const url = setupMigrateWorkflowUrl({ webUrl: 'https://github.com', repoFullName: 'acme/api', defaultBranch: 'trunk', mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example' });
    expect(url.startsWith('https://github.com/acme/api/new/trunk?')).toBe(true);
    expect(url).toContain(`filename=${encodeURIComponent(MENDR_MIGRATE_WORKFLOW_PATH)}`);
    expect(decodeURIComponent(new URL(url).searchParams.get('value')!)).toBe(yaml);
    expect(migrateActionsUrl('https://github.com/', 'acme/api')).toBe('https://github.com/acme/api/actions/workflows/mendr-migrate.yml');
  });
});
