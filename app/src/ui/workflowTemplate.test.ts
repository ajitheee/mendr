import { describe, expect, it } from 'vitest';
import { auditWorkflowYaml, MENDR_AUDIT_WORKFLOW_PATH, newWorkflowFileUrl, setupWorkflowUrl } from './workflowTemplate.js';

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
