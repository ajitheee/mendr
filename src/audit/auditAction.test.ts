import { describe, expect, it, beforeEach } from 'vitest';
import { AUDIT_WORKFLOW_YAML } from './installAuditWorkflow.js';
import { AUDIT_CLEAR_MARKER, AUDIT_MARKER } from './issueReport.js';

// TEST THE GENERATED ACTION, NOT A REIMPLEMENTATION.
//
// The upsert only ever executes inside GitHub Actions, so this suite EXTRACTS the
// exact `script:` block the workflow ships and runs it against an in-memory GitHub
// REST mock. A drift between the shipped workflow and these guarantees fails here.
//
// Required scenarios: creation, update, resolution, reopening, concurrent runs,
// API failure, duplicate prevention, and secret redaction.

/** Pull a named `script: |` block-scalar body out of the workflow YAML verbatim. */
function extractGithubScript(afterMarker: string): string {
  const lines = AUDIT_WORKFLOW_YAML.split('\n');
  const anchor = lines.findIndex((l) => l.includes(afterMarker));
  if (anchor === -1) throw new Error(`no step named ${afterMarker}`);
  const start = lines.findIndex((l, i) => i > anchor && l.trim() === 'script: |');
  if (start === -1) throw new Error('no "script: |" block after ' + afterMarker);
  const indent = lines[start].indexOf('script:') + 2;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const UPSERT = extractGithubScript('Upsert the audit issue');

interface MockIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  pull_request?: unknown;
}

class GitHubMock {
  issues: MockIssue[] = [];
  labels = new Set<string>();
  next = 1;
  calls: string[] = [];
  /** Force a specific REST call to throw, to exercise the failure path. */
  failOn: string | null = null;

  private guard(name: string): void {
    this.calls.push(name);
    if (this.failOn === name) {
      const e = new Error(`simulated ${name} failure`) as Error & { status?: number };
      e.status = 500;
      throw e;
    }
  }

  get rest() {
    const self = this;
    return {
      issues: {
        async getLabel({ name }: { name: string }) {
          self.guard('getLabel');
          if (!self.labels.has(name)) {
            const e = new Error('Not Found') as Error & { status?: number };
            e.status = 404;
            throw e;
          }
          return { data: { name } };
        },
        async createLabel({ name }: { name: string }) {
          self.guard('createLabel');
          self.labels.add(name);
          return { data: { name } };
        },
        async listForRepo() {
          self.guard('listForRepo');
          return { data: self.issues };
        },
        async create({ title, body, labels }: { title: string; body: string; labels?: string[] }) {
          self.guard('create');
          const issue: MockIssue = { number: self.next++, title, body, state: 'open', labels: labels ?? [] };
          self.issues.push(issue);
          return { data: issue };
        },
        async update({ issue_number, body, state }: { issue_number: number; body?: string; state?: string }) {
          self.guard('update');
          const issue = self.issues.find((i) => i.number === issue_number);
          if (!issue) throw new Error('no such issue');
          if (body !== undefined) issue.body = body;
          if (state) issue.state = state as 'open' | 'closed';
          return { data: issue };
        },
        async addLabels({ issue_number, labels }: { issue_number: number; labels: string[] }) {
          self.guard('addLabels');
          const issue = self.issues.find((i) => i.number === issue_number);
          if (issue) for (const l of labels) if (!issue.labels.includes(l)) issue.labels.push(l);
          return { data: {} };
        },
      },
    };
  }

  async paginate(fn: () => Promise<{ data: MockIssue[] }>): Promise<MockIssue[]> {
    return (await fn.call(this.rest.issues)).data;
  }
}

interface RunOpts {
  body: string;
  openCount: number;
  closable: boolean;
}

/** Execute the shipped upsert script against the mock. */
async function runUpsert(gh: GitHubMock, opts: RunOpts): Promise<string[]> {
  const logs: string[] = [];
  const meta = { issue: { openCount: opts.openCount, closable: opts.closable } };
  const files: Record<string, string> = { '/json': JSON.stringify(meta), '/body': opts.body };
  const fakeRequire = (mod: string): unknown => {
    if (mod === 'fs') return { readFileSync: (p: string) => files[p] ?? '' };
    throw new Error(`unexpected require(${mod})`);
  };
  const fn = new Function(
    'require', 'process', 'github', 'context', 'core',
    `return (async () => { ${UPSERT} })();`,
  );
  await fn(
    fakeRequire,
    { env: { MENDR_JSON: '/json', MENDR_BODY: '/body', MENDR_NUMBER: '' } },
    { rest: gh.rest, paginate: gh.paginate.bind(gh) },
    { repo: { owner: 'o', repo: 'r' } },
    { info: (m: string) => logs.push(m), setOutput: () => {} },
  );
  return logs;
}

/** A realistic Mendr body: the marker, an optional clear marker, and the state block. */
const STATE_BLOCK = '<!-- mendr-audit:state\n{"v":1,"open":[],"history":[]}\n-->';
const bodyWith = (extra = '', clear = false): string =>
  `${AUDIT_MARKER}\n${clear ? AUDIT_CLEAR_MARKER + '\n' : ''}## Mendr audit\n${extra}\n${STATE_BLOCK}`;

/** A body that only QUOTES the marker (e.g. someone pasted it) — must NOT be hijacked. */
const impostorBody = `Someone pasted our marker here: ${AUDIT_MARKER} — please help`;

describe('audit action — issue lifecycle', () => {
  let gh: GitHubMock;
  beforeEach(() => { gh = new GitHubMock(); });

  it('CREATION: the first run with exposure opens exactly one issue', async () => {
    await runUpsert(gh, { body: bodyWith('one finding'), openCount: 1, closable: false });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].state).toBe('open');
    expect(gh.issues[0].labels).toContain('mendr-audit');
  });

  it('DUPLICATE PREVENTION: a second run updates the SAME issue, never a second one', async () => {
    await runUpsert(gh, { body: bodyWith('v1'), openCount: 1, closable: false });
    await runUpsert(gh, { body: bodyWith('v2'), openCount: 1, closable: false });
    await runUpsert(gh, { body: bodyWith('v3'), openCount: 2, closable: false });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].body).toContain('v3');
  });

  it('UPDATE: an identical body is left untouched (no edit-history noise)', async () => {
    await runUpsert(gh, { body: bodyWith('same'), openCount: 1, closable: false });
    const logs = await runUpsert(gh, { body: bodyWith('same'), openCount: 1, closable: false });
    expect(logs.join(' ')).toContain('already current');
  });

  it('DUPLICATE PREVENTION: the issue is found by MARKER even if the label was removed', async () => {
    await runUpsert(gh, { body: bodyWith('v1'), openCount: 1, closable: false });
    gh.issues[0].labels = []; // a maintainer removed it
    await runUpsert(gh, { body: bodyWith('v2'), openCount: 1, closable: false });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].labels).toContain('mendr-audit'); // self-healed
  });

  it('DUPLICATE PREVENTION: a pull request carrying the marker is never mistaken for the issue', async () => {
    gh.issues.push({ number: 99, title: 'a PR', body: bodyWith('pr'), state: 'open', labels: [], pull_request: {} });
    await runUpsert(gh, { body: bodyWith('v1'), openCount: 1, closable: false });
    expect(gh.issues.filter((i) => !i.pull_request)).toHaveLength(1);
  });

  it('RESOLUTION: zero findings with every required surface complete closes the issue', async () => {
    await runUpsert(gh, { body: bodyWith('one finding'), openCount: 1, closable: false });
    await runUpsert(gh, { body: bodyWith('all clear', true), openCount: 0, closable: true });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].state).toBe('closed');
    expect(gh.issues[0].body).toContain(AUDIT_CLEAR_MARKER);
  });

  it('RESOLUTION IS GATED: zero findings but a skipped surface keeps the issue OPEN', async () => {
    await runUpsert(gh, { body: bodyWith('one finding'), openCount: 1, closable: false });
    const logs = await runUpsert(gh, { body: bodyWith('scan skipped'), openCount: 0, closable: false });
    expect(gh.issues[0].state).toBe('open');
    expect(logs.join(' ')).toContain('required surface did not complete');
  });

  it('REOPENING: exposure returning reopens the SAME issue Mendr closed', async () => {
    await runUpsert(gh, { body: bodyWith('finding'), openCount: 1, closable: false });
    await runUpsert(gh, { body: bodyWith('all clear', true), openCount: 0, closable: true });
    expect(gh.issues[0].state).toBe('closed');
    const logs = await runUpsert(gh, { body: bodyWith('it is back'), openCount: 1, closable: false });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].number).toBe(1); // the SAME issue
    expect(gh.issues[0].state).toBe('open');
    expect(logs.join(' ')).toContain('Reopened');
  });

  it('REOPENING RESPECTS HUMANS: an issue a human closed is not reopened', async () => {
    await runUpsert(gh, { body: bodyWith('finding'), openCount: 1, closable: false });
    gh.issues[0].state = 'closed'; // closed by a human; no CLEAR marker
    await runUpsert(gh, { body: bodyWith('still there'), openCount: 1, closable: false });
    expect(gh.issues[0].state).toBe('closed');
  });

  it('never opens an empty issue when there is nothing to report', async () => {
    const logs = await runUpsert(gh, { body: bodyWith('clear', true), openCount: 0, closable: true });
    expect(gh.issues).toHaveLength(0);
    expect(logs.join(' ')).toContain('nothing to open');
  });

  it('CONCURRENT RUNS: an issue created between locate and upsert is updated, not duplicated', async () => {
    // Simulate a racing run having already created the issue after step 1 found none.
    gh.issues.push({ number: 7, title: 'Mendr', body: bodyWith('from the other run'), state: 'open', labels: ['mendr-audit'] });
    await runUpsert(gh, { body: bodyWith('mine'), openCount: 1, closable: false });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].number).toBe(7);
    expect(gh.issues[0].body).toContain('mine');
  });

  it('API FAILURE: an update error propagates (the job fails loudly, no silent success)', async () => {
    await runUpsert(gh, { body: bodyWith('v1'), openCount: 1, closable: false });
    gh.failOn = 'update';
    await expect(runUpsert(gh, { body: bodyWith('v2'), openCount: 1, closable: false })).rejects.toThrow(/simulated update/);
    expect(gh.issues).toHaveLength(1); // and no duplicate was created
  });

  it('API FAILURE: a label-add failure is tolerated, not fatal', async () => {
    await runUpsert(gh, { body: bodyWith('v1'), openCount: 1, closable: false });
    gh.issues[0].labels = [];
    gh.failOn = 'addLabels';
    const logs = await runUpsert(gh, { body: bodyWith('v2'), openCount: 1, closable: false });
    expect(logs.join(' ')).toContain('Could not re-add label');
    expect(gh.issues[0].body).toContain('v2'); // the update still landed
  });
});

// Regressions for the defects the adversarial review confirmed.
describe('audit action — adversarial-review regressions', () => {
  let gh: GitHubMock;
  beforeEach(() => { gh = new GitHubMock(); });

  it('does NOT reopen a human-closed issue on the zero-findings/incomplete-surface path', async () => {
    await runUpsert(gh, { body: bodyWith('finding'), openCount: 1, closable: false });
    gh.issues[0].state = 'closed'; // a human closed it; no CLEAR marker
    await runUpsert(gh, { body: bodyWith('scan skipped'), openCount: 0, closable: false });
    expect(gh.issues[0].state).toBe('closed'); // must stay closed
  });

  it('does not rewrite the issue when nothing changed on ANY branch', async () => {
    await runUpsert(gh, { body: bodyWith('x'), openCount: 0, closable: false });
    const before = gh.calls.filter((c) => c === 'update').length;
    await runUpsert(gh, { body: bodyWith('x'), openCount: 0, closable: false });
    expect(gh.calls.filter((c) => c === 'update').length).toBe(before);
  });

  it('an issue that merely QUOTES the marker is not hijacked', async () => {
    gh.issues.push({ number: 3, title: 'Help', body: impostorBody, state: 'open', labels: [] });
    await runUpsert(gh, { body: bodyWith('real'), openCount: 1, closable: false });
    expect(gh.issues.find((i) => i.number === 3)!.body).toBe(impostorBody); // untouched
    expect(gh.issues).toHaveLength(2); // ours was created separately
  });

  it('prefers the OLDEST marker-bearing issue when several exist', async () => {
    gh.issues.push({ number: 2, title: 'Mendr', body: bodyWith('older'), state: 'open', labels: ['mendr-audit'] });
    gh.issues.push({ number: 9, title: 'Mendr', body: bodyWith('newer'), state: 'open', labels: ['mendr-audit'] });
    await runUpsert(gh, { body: bodyWith('mine'), openCount: 1, closable: false });
    expect(gh.issues.find((i) => i.number === 2)!.body).toContain('mine');
    expect(gh.issues.find((i) => i.number === 9)!.body).toContain('newer'); // untouched
  });
});

describe('audit workflow — least privilege and safety', () => {
  it('requests only contents:read and issues:write', () => {
    expect(AUDIT_WORKFLOW_YAML).toContain('contents: read');
    expect(AUDIT_WORKFLOW_YAML).toContain('issues: write');
    expect(AUDIT_WORKFLOW_YAML).not.toMatch(/^\s+contents: write/m);
    // pull-requests:write must NOT be granted by default — only when PR generation is enabled.
    expect(AUDIT_WORKFLOW_YAML).not.toMatch(/^\s+pull-requests: write/m);
  });

  it('serializes runs so two cannot race to open two issues', () => {
    expect(AUDIT_WORKFLOW_YAML).toContain('group: mendr-audit');
    expect(AUDIT_WORKFLOW_YAML).toContain('cancel-in-progress: false');
  });

  it('pins to an immutable release, never a moving branch', () => {
    expect(AUDIT_WORKFLOW_YAML).toMatch(/vars\.MENDR_SPEC \|\| 'v\d+\.\d+\.\d+/);
  });

  it('records the exact scanned commit', () => {
    expect(AUDIT_WORKFLOW_YAML).toContain('--sha "$GITHUB_SHA"');
  });

  it('does not persist a usable GITHUB_TOKEN while third-party npm code runs', () => {
    expect(AUDIT_WORKFLOW_YAML).toContain('persist-credentials: false');
  });

  it('states honestly that a tag is mutable and a SHA is the only immutable pin', () => {
    expect(AUDIT_WORKFLOW_YAML).toContain('A TAG IS');
    expect(AUDIT_WORKFLOW_YAML).toContain('MUTABLE');
  });

  it('needs no provider key for the default run', () => {
    const runStep = AUDIT_WORKFLOW_YAML.slice(
      AUDIT_WORKFLOW_YAML.indexOf('Run the audit'),
      AUDIT_WORKFLOW_YAML.indexOf('Upsert the audit issue'),
    );
    expect(runStep).not.toContain('MENDR_PROVIDER_KEY');
    expect(runStep).not.toContain('secrets.');
  });
});
