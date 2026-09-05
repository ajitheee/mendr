import { describe, expect, it } from 'vitest';
import { auditWorkflowYaml, MENDR_AUDIT_WORKFLOW_PATH, newWorkflowFileUrl, setupWorkflowUrl } from './workflowTemplate.js';

const OPTS = { appUrl: 'https://app.example', audience: 'mendr', mendrSpec: 'v0.2.4-alpha', defaultBranch: 'trunk' };

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
    expect(yaml).toContain("${{ vars.MENDR_SPEC || 'v0.2.4-alpha' }}");
    expect(yaml).toContain('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(yaml).toContain('branches: [trunk]');
    expect(yaml).toContain('persist-credentials: false');
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
