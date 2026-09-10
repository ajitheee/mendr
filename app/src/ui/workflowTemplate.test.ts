import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditWorkflowYaml,
  MENDR_AUDIT_WORKFLOW_PATH,
  MENDR_MIGRATE_WORKFLOW_PATH,
  migrateActionsUrl,
  migrateWorkflowYaml,
  newWorkflowFileUrl,
  REUSABLE_AUDIT,
  REUSABLE_MIGRATE,
  setupMigrateWorkflowUrl,
  setupWorkflowUrl,
} from './workflowTemplate.js';

const OPTS = { appUrl: 'https://app.example', audience: 'mendr', mendrSpec: 'v0.3.0-alpha', defaultBranch: 'trunk' };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The `with:` keys a caller job passes, and the `inputs:` a reusable workflow declares — read as text, no YAML library needed. */
function withKeys(job: string): string[] {
  const marker = '    with:\n';
  const at = job.indexOf(marker);
  if (at < 0) return [];
  return [...job.slice(at + marker.length).matchAll(/^      ([a-z-]+): /gm)].map((m) => m[1]!);
}
function declaredInputs(reusable: string): { names: string[]; required: string[] } {
  const block = reusable.slice(reusable.indexOf('    inputs:'), reusable.indexOf('\njobs:'));
  const names = [...block.matchAll(/^      ([a-z-]+):$/gm)].map((m) => m[1]!);
  const required = names.filter((n) => new RegExp(`^      ${n}:\\n(?:        .*\\n)*?        required: true`, 'm').test(block));
  return { names, required };
}

describe('auditWorkflowYaml — one short file, two jobs, each calling a reusable workflow at the pinned release', () => {
  const yaml = auditWorkflowYaml(OPTS);
  const auditJob = yaml.slice(yaml.indexOf('\n  audit:'), yaml.indexOf('\n  migrate:'));
  const migrateJob = yaml.slice(yaml.indexOf('\n  migrate:'));

  it('is short enough for GitHub\'s prefilled editor (the full two-job file was 9.6 KB and was refused)', () => {
    const url = setupWorkflowUrl({ ...OPTS, webUrl: 'https://github.com', repoFullName: 'acme/some-longer-repository-name', mendrSpec: 'v0.10.12-alpha', private: true });
    expect(Buffer.byteLength(url)).toBeLessThan(6000); // GitHub refuses around 8 KB; keep a margin
    expect(Buffer.byteLength(yaml)).toBeLessThan(3800);
    expect(yaml).toContain('Allow GitHub Actions to create and approve pull requests'); // the one setting a partner must flip
  });

  it('the audit job is least-privilege: contents:read + id-token:write, no write scopes; no secrets anywhere', () => {
    expect(auditJob).toMatch(/permissions:\n\s+contents: read.*\n\s+id-token: write/);
    expect(auditJob).not.toMatch(/^\s+contents: write/m);
    expect(auditJob).not.toMatch(/^\s+pull-requests: write/m);
    expect(yaml).not.toMatch(/^permissions:/m); // scopes are per job, never workflow-wide
    expect(yaml).not.toContain('${{ secrets.'); // no repository secret is read
  });

  it('both jobs call the reusable workflows at the SAME pinned release, never a branch', () => {
    expect(auditJob).toContain(`uses: ${REUSABLE_AUDIT}@v0.3.0-alpha`);
    expect(migrateJob).toContain(`uses: ${REUSABLE_MIGRATE}@v0.3.0-alpha`);
    expect(yaml).not.toContain('@main');
    expect(yaml).toContain('https://github.com/ajitheee/mendr/blob/v0.3.0-alpha/TRUST.md');
  });

  it('the migrate job carries out approvals: its own write scopes, never on a push or pull request', () => {
    expect(migrateJob).toMatch(/permissions:\n\s+contents: write.*\n\s+pull-requests: write.*\n\s+id-token: write\n/);
    expect(migrateJob).toContain("if: github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && github.event.schedule == '17 * * * *')");
    expect(migrateJob).toContain('app-url: https://app.example');
    expect(migrateJob).toContain('approval: ${{ inputs.approval }}');
    // and the audit job never runs on the approvals schedule
    expect(auditJob).toContain("if: github.event_name != 'schedule' || github.event.schedule == '37 6 * * *'");
  });

  it('passes the App and the OIDC audience to the audit; nothing else is needed (the CLI pin lives in the reusable workflow)', () => {
    expect(withKeys(auditJob)).toEqual(['app-url', 'audience']);
    expect(auditJob).toContain('app-url: https://app.example');
    expect(auditJob).toContain('audience: mendr');
    expect(withKeys(migrateJob)).toEqual(['app-url', 'approval']);
  });

  it('checks for approvals less often on a private repository', () => {
    const priv = auditWorkflowYaml({ ...OPTS, private: true });
    expect(priv).toMatch(/- cron: '17 \*\/3 \* \* \*'/);
    expect(priv).toContain("github.event.schedule == '17 */3 * * *'");
    expect(priv).not.toContain("'17 * * * *'");
  });

  it('runs on a daily schedule as well as push/PR/manual, so an idle repo still re-scans', () => {
    // The daily run is what catches a newly announced retirement when no code
    // has changed. Off-the-hour, because GitHub throttles :00 schedules.
    expect(yaml).toMatch(/^\s+schedule:\n\s+- cron: '37 6 \* \* \*'.*\n\s+- cron: '17 \* \* \* \*'/m);
    expect(yaml).not.toMatch(/cron: '0 /); // never on the hour
    expect(yaml).toContain('pull_request: {}');
    expect(yaml).toContain('branches: [trunk]');
    expect(yaml).toMatch(/^\s+workflow_dispatch:\n\s+inputs:\n\s+approval:/m);
  });

  it('keeps GitHub ${{ }} expressions literal', () => {
    expect(yaml).toContain('${{ inputs.approval }}');
    expect(yaml).not.toContain('undefined');
  });

  it('says what it does and does not do, in the file the customer commits', () => {
    expect(yaml).toMatch(/never your code/);
    expect(yaml).toMatch(/never merges/);
    expect(yaml).toMatch(/^# SUPPLY CHAIN:/m);
  });
});

describe('the caller and the reusable workflows agree (the contract lives in this repository)', () => {
  const audit = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'reusable-audit.yml'), 'utf8');
  const migrate = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'reusable-migrate.yml'), 'utf8');
  const yaml = auditWorkflowYaml(OPTS);
  const auditJob = yaml.slice(yaml.indexOf('\n  audit:'), yaml.indexOf('\n  migrate:'));
  const migrateJob = yaml.slice(yaml.indexOf('\n  migrate:'));

  it('every `with:` the caller passes is a declared input, and every required input is passed', () => {
    expect(audit).toMatch(/^on:\n  workflow_call:/m);
    expect(migrate).toMatch(/^on:\n  workflow_call:/m);
    const a = declaredInputs(audit);
    const m = declaredInputs(migrate);
    for (const k of withKeys(auditJob)) expect(a.names).toContain(k);
    for (const k of withKeys(migrateJob)) expect(m.names).toContain(k);
    for (const r of a.required) expect(withKeys(auditJob)).toContain(r);
    for (const r of m.required) expect(withKeys(migrateJob)).toContain(r);
    for (const r of m.required) expect(withKeys(migrateWorkflowYaml({ mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example' }))).toContain(r);
  });

  it('the reusable audit sends only the audit JSON to the App, proven by OIDC, after which it still fails truthfully', () => {
    expect(audit).toContain('MENDR_APP_URL: ${{ inputs.app-url }}');
    expect(audit).toContain('audience=$MENDR_AUDIENCE');
    expect(audit).toContain('/api/ingest');
    expect(audit).toContain('--data-binary @mendr-audit.json');
    expect(audit).toContain('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(audit).toContain('persist-credentials: false');
    expect(audit).toContain('MENDR_SPEC: ${{ vars.MENDR_SPEC || inputs.mendr-spec }}'); // the repo variable still overrides the pin
    expect(audit).toContain("MENDR_REGISTRY_REFRESH: ${{ inputs.registry-refresh }}");
    const post = audit.indexOf('/api/ingest');
    const status = audit.indexOf('MENDR_STATUS=$?');
    const exit = audit.indexOf('exit $MENDR_STATUS');
    expect(status).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(status);
    expect(exit).toBeGreaterThan(post);
    expect(audit).toMatch(/curl -sS --fail-with-body --retry 4 --retry-delay 5 --retry-all-errors --max-time 120 -X POST/);
    expect(audit).not.toContain('${{ secrets.');
  });

  it('the reusable migration is approval-gated and pins the action and the CLI to one release', () => {
    expect(migrate).toContain("approval-gated: 'true'");
    expect(migrate).toContain('app-url: ${{ inputs.app-url }}');
    expect(migrate).toContain('approval: ${{ inputs.approval }}');
    expect(migrate).toMatch(/uses: ajitheee\/mendr\/mendr-action@(v[\d.]+-alpha|[0-9a-f]{40})\n/);
    const action = /mendr-action@(\S+)/.exec(migrate)![1];
    expect(migrate).toContain(`mendr-spec: github:ajitheee/mendr#${action}`);
    expect(migrate).not.toContain('@main');
    expect(migrate).toMatch(/permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+id-token: write\n/);
    expect(migrate).not.toContain('${{ secrets.');
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

describe('migrateWorkflowYaml / setupMigrateWorkflowUrl — the standalone file for repositories connected before the one-file setup', () => {
  const yaml = migrateWorkflowYaml({ mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example' });

  it('runs on a schedule and when the App starts it — never on push — with exactly the scopes the branch and the PR need', () => {
    expect(yaml).toMatch(/^\s+schedule:\n\s+- cron: '17 \* \* \* \*'/m); // hourly on a public repo
    expect(yaml).toMatch(/^\s+workflow_dispatch:\n\s+inputs:\n\s+approval:/m);
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
    expect(yaml).toMatch(/permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+id-token: write\n/);
    expect(yaml).not.toMatch(/^\s+(issues|actions|checks): /m);
    expect(yaml).not.toContain('${{ secrets.');
    expect(yaml).toContain(`uses: ${REUSABLE_MIGRATE}@v0.3.0-alpha`);
    expect(yaml).toContain('app-url: https://app.example');
    expect(yaml).toContain('approval: ${{ inputs.approval }}');
    expect(yaml).not.toContain('@main');
  });

  it('checks less often on a private repository, where every check costs Actions minutes', () => {
    const priv = migrateWorkflowYaml({ mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example', private: true });
    expect(priv).toMatch(/- cron: '17 \*\/3 \* \* \*'/);
    expect(priv).toContain('every three hours on a private repo');
  });

  it('says what it does and does not do, in the file the customer commits', () => {
    expect(yaml).toMatch(/never touches your default branch/);
    expect(yaml).toMatch(/never merges/);
    expect(yaml).toMatch(/ONLY if the verdict is `verified`/);
    expect(yaml).toMatch(/Nothing approved\n# = nothing done, in seconds/);
  });

  it('deep-links to the prefilled editor at the migration path, and to the Actions page', () => {
    const url = setupMigrateWorkflowUrl({ webUrl: 'https://github.com', repoFullName: 'acme/api', defaultBranch: 'trunk', mendrSpec: 'v0.3.0-alpha', appUrl: 'https://app.example' });
    expect(url.startsWith('https://github.com/acme/api/new/trunk?')).toBe(true);
    expect(url).toContain(`filename=${encodeURIComponent(MENDR_MIGRATE_WORKFLOW_PATH)}`);
    expect(decodeURIComponent(new URL(url).searchParams.get('value')!)).toBe(yaml);
    expect(Buffer.byteLength(url)).toBeLessThan(6000);
    expect(migrateActionsUrl('https://github.com/', 'acme/api')).toBe('https://github.com/acme/api/actions/workflows/mendr-migrate.yml');
  });
});
