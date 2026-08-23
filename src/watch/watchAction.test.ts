import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { WATCH_WORKFLOW_YAML } from './installWorkflow.js';
import { WATCH_CLEAR_MARKER, WATCH_MARKER } from './issue.js';

// TEST THE GENERATED ACTION, NOT A REIMPLEMENTATION.
//
// "The command existing does not prove the complete watch workflow is shipped"
// (external review). The one surface that cannot be unit-tested by running the
// CLI is the github-script step that maintains the issue — it only executes
// inside GitHub Actions. So this suite EXTRACTS the exact JS the workflow ships
// and runs it against an in-memory GitHub REST mock, driving the idempotency /
// spam scenarios the review requires:
//   1. first run creates exactly one issue
//   2. a second identical run updates the SAME issue (no duplicate)
//   3. changed exposure updates the same issue
//   4. exposure -> 0 closes the issue
//   5. exposure returning reopens the Mendr-closed issue
//   6. the label removed by a maintainer still resolves the issue by MARKER
//   7. a human-closed exposure issue is NOT reopened (no notification fight)
//   8. a pull request carrying the marker is never mistaken for the issue
//   9. no exposure + no issue never creates an empty issue
// It runs the SHIPPED string, so a drift between the workflow and these
// guarantees fails here.

/** Pull the `script: |` block-scalar body out of the workflow YAML verbatim. */
function extractGithubScript(): string {
  const lines = WATCH_WORKFLOW_YAML.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'script: |');
  if (start === -1) throw new Error('no "script: |" block in the workflow YAML');
  const indent = lines[start].indexOf('script:') + 2;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const SCRIPT_BODY = extractGithubScript();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;
const runScript = new AsyncFunction('github', 'context', 'core', 'require', SCRIPT_BODY);
const nodeRequire = createRequire(import.meta.url);

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  pull_request?: object;
}

/** An in-memory stand-in for the slice of the GitHub issues REST API the script uses. */
function makeGitHub() {
  const issues: FakeIssue[] = [];
  const labels = new Set<string>();
  let seq = 0;
  let updateCount = 0;
  let createCount = 0;
  const infos: string[] = [];

  const listForRepo = async (params: {
    labels?: string;
    state?: 'open' | 'closed' | 'all';
  }): Promise<{ data: FakeIssue[] }> => {
    let out = issues.map((i) => ({ ...i }));
    if (params.labels) {
      const want = params.labels.split(',');
      out = out.filter((i) => want.every((w) => i.labels.includes(w)));
    }
    if (params.state && params.state !== 'all') out = out.filter((i) => i.state === params.state);
    return { data: out };
  };

  const github = {
    rest: {
      issues: {
        async getLabel({ name }: { name: string }): Promise<{ data: { name: string } }> {
          if (!labels.has(name)) {
            const e = new Error('Not Found') as Error & { status: number };
            e.status = 404;
            throw e;
          }
          return { data: { name } };
        },
        async createLabel({ name }: { name: string }): Promise<{ data: { name: string } }> {
          labels.add(name);
          return { data: { name } };
        },
        async addLabels({
          issue_number,
          labels: ls,
        }: {
          issue_number: number;
          labels: string[];
        }): Promise<{ data: object }> {
          const i = issues.find((x) => x.number === issue_number);
          if (i) for (const l of ls) if (!i.labels.includes(l)) i.labels.push(l);
          return { data: {} };
        },
        listForRepo,
        async create({
          title,
          body,
          labels: ls,
        }: {
          title: string;
          body: string;
          labels?: string[];
        }): Promise<{ data: { number: number } }> {
          createCount++;
          const number = ++seq;
          issues.push({ number, title, body, state: 'open', labels: ls ? [...ls] : [] });
          return { data: { number } };
        },
        async update({
          issue_number,
          body,
          state,
        }: {
          issue_number: number;
          body?: string;
          state?: 'open' | 'closed';
        }): Promise<{ data: object }> {
          updateCount++;
          const i = issues.find((x) => x.number === issue_number);
          if (!i) throw new Error('no such issue ' + issue_number);
          if (body !== undefined) i.body = body;
          if (state !== undefined) i.state = state;
          return { data: { ...i } };
        },
      },
    },
    paginate: async (
      fn: (p: object) => Promise<{ data: FakeIssue[] }>,
      params: object,
    ): Promise<FakeIssue[]> => (await fn(params)).data,
  };

  const context = { repo: { owner: 'o', repo: 'r' } };
  const core = { info: (m: string) => infos.push(m) };
  return {
    github,
    context,
    core,
    issues,
    labels,
    infos,
    updateCalls: () => updateCount,
    createCalls: () => createCount,
  };
}

const EXPO_A = `${WATCH_MARKER}\n\n### Mendr Watch\n\n**1** deprecated model id (exposure A).`;
const EXPO_B = `${WATCH_MARKER}\n\n### Mendr Watch\n\n**2** deprecated model ids (exposure B).`;
const CLEAR = `${WATCH_MARKER}\n${WATCH_CLEAR_MARKER}\n\nNo deprecated model ids are currently detected.`;

/** Drive one workflow run: write the meta+body files, execute the shipped script. */
async function run(
  env: ReturnType<typeof makeGitHub>,
  meta: { hasExposure: boolean },
  body: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-action-'));
  const jsonPath = join(dir, 'meta.json');
  const bodyPath = join(dir, 'body.md');
  writeFileSync(jsonPath, JSON.stringify(meta));
  writeFileSync(bodyPath, body);
  process.env.MENDR_JSON = jsonPath;
  process.env.MENDR_BODY = bodyPath;
  await runScript(env.github, env.context, env.core, nodeRequire);
}

const openIssues = (env: ReturnType<typeof makeGitHub>): FakeIssue[] =>
  env.issues.filter((i) => !i.pull_request);

describe('the shipped github-script upsert (run against a GitHub mock)', () => {
  let env: ReturnType<typeof makeGitHub>;
  beforeEach(() => {
    env = makeGitHub();
  });

  it('creates exactly one issue on the first exposed run, labeled', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    expect(openIssues(env)).toHaveLength(1);
    expect(openIssues(env)[0].state).toBe('open');
    expect(openIssues(env)[0].labels).toContain('mendr-watch');
    expect(openIssues(env)[0].body).toContain(WATCH_MARKER);
  });

  it('updates the SAME issue on repeat/changed runs — never a duplicate', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    await run(env, { hasExposure: true }, EXPO_A); // identical
    await run(env, { hasExposure: true }, EXPO_B); // changed
    expect(openIssues(env)).toHaveLength(1);
    expect(openIssues(env)[0].body).toContain('exposure B');
  });

  it('does not edit the issue at all when a re-run produces an identical body', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    const editsAfterFirst = env.updateCalls();
    await run(env, { hasExposure: true }, EXPO_A); // byte-identical body, still open
    expect(env.updateCalls()).toBe(editsAfterFirst); // no wasted edit / history noise
    expect(env.createCalls()).toBe(1); // and certainly no second issue
    expect(openIssues(env)).toHaveLength(1);
  });

  it('closes the issue when exposure reaches zero, then reopens when it returns', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    const num = openIssues(env)[0].number;

    await run(env, { hasExposure: false }, CLEAR);
    expect(env.issues.find((i) => i.number === num)?.state).toBe('closed');
    expect(env.issues).toHaveLength(1); // closed, not deleted, not duplicated

    await run(env, { hasExposure: true }, EXPO_A);
    expect(env.issues.find((i) => i.number === num)?.state).toBe('open'); // reopened
    expect(openIssues(env)).toHaveLength(1);
  });

  it('finds the issue by MARKER even after the label is removed — no duplicate', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    // A maintainer strips the label off the issue.
    env.issues[0].labels = [];
    await run(env, { hasExposure: true }, EXPO_B);
    expect(openIssues(env)).toHaveLength(1); // found by marker, not re-created
    expect(env.issues[0].labels).toContain('mendr-watch'); // self-healed
  });

  it('does NOT reopen an exposure issue a human closed on purpose', async () => {
    await run(env, { hasExposure: true }, EXPO_A);
    // Human closes it deliberately — note: body has NO clear-marker (still an
    // exposure body), so it is not a Mendr close.
    env.issues[0].state = 'closed';
    await run(env, { hasExposure: true }, EXPO_B);
    expect(env.issues[0].state).toBe('closed'); // respected, not reopened
    expect(env.issues[0].body).toContain('exposure B'); // but body still updated
    expect(openIssues(env)).toHaveLength(1);
  });

  it('never mistakes a pull request carrying the marker for the issue', async () => {
    // A PR whose body happens to include the marker must be ignored.
    env.issues.push({
      number: 999,
      title: 'a PR',
      body: EXPO_A,
      state: 'open',
      labels: [],
      pull_request: {},
    });
    await run(env, { hasExposure: true }, EXPO_A);
    // One real ISSUE created; the PR is untouched.
    expect(openIssues(env)).toHaveLength(1);
    expect(openIssues(env)[0].number).not.toBe(999);
  });

  it('never opens an empty issue when there is no exposure and none exists', async () => {
    await run(env, { hasExposure: false }, CLEAR);
    expect(env.issues).toHaveLength(0);
  });
});

describe('the generated workflow is pinned and least-privilege', () => {
  it('defaults the Mendr spec to a pinned RELEASE tag, never a moving branch', () => {
    // Pinned to an immutable release (vX.Y.Z), overridable via MENDR_SPEC.
    expect(WATCH_WORKFLOW_YAML).toMatch(/vars\.MENDR_SPEC \|\| 'v\d+\.\d+\.\d+'/);
    // Never a branch/main as the default.
    expect(WATCH_WORKFLOW_YAML).not.toContain("|| 'github:ajitheee/mendr'");
    expect(WATCH_WORKFLOW_YAML).not.toContain("|| 'main'");
    // And it installs exactly the pinned ref.
    expect(WATCH_WORKFLOW_YAML).toContain('github:ajitheee/mendr#$MENDR_SPEC');
  });

  it('requests only issues:write + contents:read (no write to code or PRs)', () => {
    expect(WATCH_WORKFLOW_YAML).toContain('contents: read');
    expect(WATCH_WORKFLOW_YAML).toContain('issues: write');
    expect(WATCH_WORKFLOW_YAML).not.toContain('contents: write');
    expect(WATCH_WORKFLOW_YAML).not.toContain('pull-requests: write');
  });

  it('is never triggered by pull_request, so a fork PR cannot get a write token', () => {
    // The github-script legitimately reads `i.pull_request` to SKIP PRs, so check
    // the trigger KEY specifically (an indented `pull_request:` under `on:`),
    // not the substring. Triggers are schedule / push / workflow_dispatch only.
    expect(WATCH_WORKFLOW_YAML).not.toMatch(/^\s+pull_request:/m);
    expect(WATCH_WORKFLOW_YAML).not.toMatch(/^\s+pull_request_target:/m);
  });

  it('serializes runs so two schedules cannot race to open two issues', () => {
    expect(WATCH_WORKFLOW_YAML).toContain('concurrency:');
    expect(WATCH_WORKFLOW_YAML).toContain('group: mendr-watch');
  });

  it('runs on Node >= 22 (a dep uses Set.prototype.union, which Node 20 lacks)', () => {
    // Regression guard: a live Actions run failed on `TEXT_ENCODINGS.union is not
    // a function` because the workflow pinned Node 20 while web-tree-sitter needs
    // Node 22+. This must never slip back to 20.
    const m = WATCH_WORKFLOW_YAML.match(/node-version:\s*'(\d+)'/);
    expect(m, 'workflow must pin a node-version').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(22);
  });
});
