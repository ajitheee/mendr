import { describe, expect, it } from 'vitest';
import type { MigrationResult } from '../migrate/migrate.js';
import { renderPrBody } from './prBody.js';

// The pull request body is the one artifact a customer actually reads. Every assertion here is
// a thing a reviewer needs in order to decide in a minute, and every one of them was already
// known when the migration was planned and used to be thrown away.

const base: MigrationResult = {
  schema: 'mendr-migration/v1',
  generatedBy: 'mendr',
  repo: 'acme/api',
  generatedAt: '2026-09-16T00:00:00.000Z',
  sha: null,
  migrated: true,
  migrations: [
    {
      provider: 'openai',
      model: 'gpt-4-0613',
      from: 'gpt-4-0613',
      to: 'gpt-5.6-sol',
      language: 'ts',
      sites: 1,
      files: ['src/ai.ts'],
      evidence: {
        entryId: 'openai.gpt-4-0613.retirement-2026-10-23',
        lifecycle: 'deprecated',
        shutdownDate: '2026-10-23',
        daysUntil: 37,
        sourceUrl: 'https://developers.openai.com/api/docs/deprecations',
        replacementVerdict: 'verified',
        excerpts: [{ sourceUrl: 'https://developers.openai.com/api/docs/deprecations', excerpt: 'gpt-4-0613  shutdown  2026-10-23' }],
      },
    },
  ],
  paramTransforms: ['rename "max_tokens" -> "max_completion_tokens" (on gpt-5.6-sol)'],
  skipped: [],
  changedFiles: ['src/ai.ts'],
  diff: '',
  verification: {
    typeCheck: { status: 'pass' },
    build: { status: 'pass', command: 'npm run build' },
    tests: { status: 'pass' },
    eval: { status: 'not-configured' },
    behavioralTested: false,
    verdict: 'verified',
  },
  prReady: true,
  notes: [],
} as unknown as MigrationResult;

const render = (over: Partial<MigrationResult> = {}) =>
  renderPrBody({ ...base, ...over } as MigrationResult);

describe('is this urgent?', () => {
  it('says how many days are left, not just a date', () => {
    expect(render()).toContain('shuts down in **37 days** (2026-10-23)');
  });

  it('an already-retired id says so, and says calls are already failing', () => {
    const out = render({
      migrations: [{ ...base.migrations[0]!, evidence: { ...base.migrations[0]!.evidence!, daysUntil: -114 } }],
    });
    expect(out).toContain('**retired 114 days ago**');
    expect(out).toContain('already failing');
  });

  it('shutting down today is not rounded into "in 0 days"', () => {
    const out = render({
      migrations: [{ ...base.migrations[0]!, evidence: { ...base.migrations[0]!.evidence!, daysUntil: 0 } }],
    });
    expect(out).toContain('**shuts down TODAY**');
  });

  it('a deprecation with no date is not dressed up as a deadline', () => {
    const out = render({
      migrations: [
        { ...base.migrations[0]!, evidence: { ...base.migrations[0]!.evidence!, shutdownDate: null, daysUntil: null } },
      ],
    });
    expect(out).toContain('no shutdown date announced yet');
  });
});

describe('who says so, and how well checked is it?', () => {
  it('links the provider notice and quotes the sentence it was read from', () => {
    const out = render();
    expect(out).toContain('provider notice: https://developers.openai.com/api/docs/deprecations');
    // whitespace is collapsed on purpose: a docs-table excerpt is unreadable otherwise
    expect(out).toContain('> gpt-4-0613 shutdown 2026-10-23');
  });

  it('names the registry entry so the evidence can be pulled up', () => {
    expect(render()).toContain('mendr evidence openai.gpt-4-0613.retirement-2026-10-23');
  });

  // `verified` and `quarantined` must never look the same in a pull request.
  it('a non-verified replacement is called out as not recommended', () => {
    const out = render({
      migrations: [
        { ...base.migrations[0]!, evidence: { ...base.migrations[0]!.evidence!, replacementVerdict: 'quarantined' } },
      ],
    });
    expect(out).toContain('**not a recommended swap**');
  });

  it('a verified replacement still says what verified means', () => {
    expect(render()).toContain('live in a public catalog and uncontradicted');
  });
});

describe('what else changed, and what was left?', () => {
  it('names coupled parameters, which are otherwise invisible in a diff', () => {
    const out = render();
    expect(out).toContain('**Coupled parameters**');
    expect(out).toContain('max_completion_tokens');
    expect(out).toContain('rejects the old key');
  });

  it('omits the parameter section entirely when none changed', () => {
    expect(render({ paramTransforms: [] })).not.toContain('Coupled parameters');
  });

  // A body listing only what changed implies that was all there was.
  it('lists what it deliberately did not rewrite, with the reason', () => {
    const out = render({
      skipped: [
        {
          file: 'src/gen.ts',
          line: 9,
          model: 'gemini-2.0-flash',
          reason: 'the registry will not vouch for "gemini-3.6-flash" as its replacement (quarantined)',
        },
      ],
    });
    expect(out).toContain('**Left alone (1)**');
    expect(out).toContain('src/gen.ts:9');
    expect(out).toContain('gemini-2.0-flash');
    expect(out).toContain('quarantined');
  });
});

describe('verification is reported in the reviewer\'s words', () => {
  it('says what ran and what could not', () => {
    const out = render({
      verification: {
        ...base.verification,
        build: { status: 'inconclusive', detail: 'no installed node_modules', command: 'npm run build' },
      },
    } as Partial<MigrationResult>);
    expect(out).toContain('type-check: **passed**');
    expect(out).toContain('build: **could not run**');
    expect(out).toContain('no installed node_modules');
  });

  it('a failing gate is not softened', () => {
    const out = render({
      verification: { ...base.verification, tests: { status: 'fail', detail: '3 failing' } },
    } as Partial<MigrationResult>);
    expect(out).toContain('your tests: **FAILED**');
  });

  it('states the behavioural ceiling whenever no eval ran', () => {
    const out = render();
    expect(out).toContain('**Behaviour was not verified.**');
    expect(out).toContain('quality, latency, cost or response shape');
  });

  it('drops that caveat once an eval actually ran', () => {
    const out = render({
      verification: { ...base.verification, behavioralTested: true },
    } as Partial<MigrationResult>);
    expect(out).not.toContain('Behaviour was not verified');
  });

  it('never claims Mendr ran anything outside the customer CI', () => {
    expect(render()).toContain('Mendr ran nothing on your machine');
  });
});

describe('a run that verified nothing does not look like four passing checks', () => {
  it('says nothing was verified, instead of four "not configured" rows', () => {
    const out = render({
      verification: {
        typeCheck: { status: 'not-configured' },
        build: { status: 'not-configured' },
        tests: { status: 'not-configured' },
        eval: { status: 'not-configured' },
        behavioralTested: false,
        verdict: 'inconclusive',
      },
    } as Partial<MigrationResult>);
    expect(out).toContain('**nothing was verified on this run**');
    expect(out).not.toContain('type-check: **not configured**');
  });
});

describe('notes ride along', () => {
  it('surfaces a stale-registry note rather than burying it', () => {
    const out = render({ notes: ['The registry this plan used is 20 days old — STALE.'] });
    expect(out).toContain('**Also worth knowing**');
    expect(out).toContain('STALE');
  });
});

describe('it does not say the same thing twice', () => {
  // The first real pull request Mendr ever opened (mendr-demo#4, 2026-09-17) stated the
  // behavioural ceiling twice: once as this module's blockquote, and again under "Also worth
  // knowing" as the CLI's own note -- in two voices, two spellings, and the second one using
  // a word that had just been withdrawn. Correct in a terminal report; redundant here.
  it('drops the CLI behaviour note, which the blockquote already covers', () => {
    const out = render({
      notes: [
        'Behaviour was NOT verified: the throwaway copy proves the migration builds and existing tests pass.',
        'Restricted to openai/gpt-4-0613 (--only); every other retiring model was left untouched.',
      ],
    });
    expect(out).toContain('**Behaviour was not verified.**');
    expect(out).not.toContain('Behaviour was NOT verified:');
    expect(out).toContain('every other retiring model was left untouched');
  });

  it('matches the American spelling the CLI actually emitted too', () => {
    const out = render({ notes: ['Behavior was NOT verified: the sandbox proves it builds.'] });
    expect(out).not.toContain('the sandbox proves');
  });

  it('omits the section entirely when nothing survives the filter', () => {
    expect(render({ notes: ['Behaviour was NOT verified: x.'] })).not.toContain('Also worth knowing');
  });
});
