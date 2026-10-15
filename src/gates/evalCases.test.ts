import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { resolveGatePolicy } from './policy.js';
import { paramsForModel, parseEvalCases, runEvalCases, unmetExpectations, type FetchLike } from './evalCases.js';

// Check 2: the team's own cases on the old model and the new one. Every provider call here goes
// to a fake that answers per model, so these tests send nothing anywhere.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4-0613', replacement: 'gpt-5.6-sol', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'param_rename', param: 'max_tokens', replacement: 'max_completion_tokens', on_models: ['gpt-5.6'] },
  { provider: 'openai', kind: 'param_removal', param: 'temperature', on_models: ['gpt-5.6'] },
];
const SWAP = { provider: 'openai', from: 'gpt-4-0613', to: 'gpt-5.6-sol' };
const KEY = { OPENAI_API_KEY: 'sk-test-not-real' };

const CASES = {
  cases: [
    {
      name: 'refund window',
      messages: [{ role: 'user', content: 'How long do I have to ask for a refund?' }],
      params: { max_tokens: 200, temperature: 0.2 },
      expect: { contains: ['30 days'], notContains: ["I'm not sure"] },
    },
  ],
};

/** A fake provider: `answers[model]` is the reply text, or a number for an HTTP error status. */
function fakeProvider(answers: Record<string, string | number>): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const a = answers[body.model as string];
    if (typeof a === 'number') return { status: a, json: async () => ({ error: { message: `Unsupported parameter: 'temperature' is not supported with this model.` } }) };
    return { status: 200, json: async () => ({ choices: [{ message: { content: a ?? '' } }] }) };
  };
  return { fetch, bodies };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repoWithCases(cases: unknown = CASES): string {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-cases-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  return dir;
}

describe('unmetExpectations', () => {
  it('checks every expectation, deterministically', () => {
    expect(unmetExpectations('You have 30 days.', { contains: ['30 DAYS'], notContains: ['sorry'], matches: '\\d+', maxChars: 50 })).toEqual([]);
    expect(unmetExpectations("I'm not sure, sorry", { contains: ['30 days'], notContains: ['sorry'], json: true })).toEqual([
      'does not contain "30 days"',
      'contains "sorry"',
      'is not valid JSON',
    ]);
    expect(unmetExpectations('x'.repeat(20), { maxChars: 10 })).toEqual(['is 20 characters, over 10']);
  });
});

describe('paramsForModel', () => {
  it('applies the registry’s parameter rules for the new model, and leaves the old request alone', () => {
    expect(paramsForModel({ max_tokens: 200, temperature: 0.2, top_p: 1 }, 'gpt-5.6-sol', REG)).toEqual({ max_completion_tokens: 200, top_p: 1 });
    expect(paramsForModel({ max_tokens: 200, temperature: 0.2 }, 'gpt-4-0613', REG)).toEqual({ max_tokens: 200, temperature: 0.2 });
  });
});

describe('parseEvalCases', () => {
  it('names what is wrong, in a sentence', () => {
    expect(() => parseEvalCases({}, 'cases.json')).toThrow(/must be an object with a "cases" list/);
    expect(() => parseEvalCases({ cases: [{ name: 'a', messages: [{ role: 'user', content: 'hi' }], expect: {} }] }, 'cases.json')).toThrow(
      /"expect" is empty, so every answer would pass/,
    );
    expect(() =>
      parseEvalCases({ cases: [{ name: 'a', messages: [{ role: 'user', content: 'hi' }], expect: { contians: ['x'] } }] }, 'cases.json'),
    ).toThrow(/unknown expectation "contians"/);
    expect(() =>
      parseEvalCases({ cases: [{ name: 'a', messages: [{ role: 'user', content: 'hi' }], params: { model: 'x' }, expect: { json: true } }] }, 'cases.json'),
    ).toThrow(/"params" may not set "model"/);
  });
});

describe('runEvalCases', () => {
  it('passes when the new model meets every case, and sends the new model the migrated parameters', async () => {
    const { fetch, bodies } = fakeProvider({ 'gpt-4-0613': 'You have 30 days.', 'gpt-5.6-sol': 'Refunds: within 30 days.' });
    const r = await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch });
    expect(r.status).toBe('passed');
    expect(bodies.find((b) => b.model === 'gpt-5.6-sol')).toEqual({ max_completion_tokens: 200, model: 'gpt-5.6-sol', messages: CASES.cases[0]!.messages });
    expect(bodies.find((b) => b.model === 'gpt-4-0613')).toMatchObject({ max_tokens: 200, temperature: 0.2 });
  });

  it('fails when a case passes on the old model and not on the new one, and never prints the answer', async () => {
    const { fetch } = fakeProvider({ 'gpt-4-0613': 'You have 30 days.', 'gpt-5.6-sol': "I'm not sure about refunds." });
    const r = await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch });
    expect(r.status).toBe('failed');
    expect(r.output).toContain('1 got worse with the migration');
    expect(r.output).toContain('the gpt-5.6-sol answer does not contain "30 days", contains "I\'m not sure"');
    expect(r.output).not.toContain('about refunds');
  });

  it('fails when the new model rejects the request: the break a type-check cannot see', async () => {
    const { fetch } = fakeProvider({ 'gpt-4-0613': 'You have 30 days.', 'gpt-5.6-sol': 400 });
    const r = await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch });
    expect(r.status).toBe('failed');
    expect(r.output).toContain('gpt-5.6-sol rejected the request (400)');
  });

  it('does not blame the migration for a case that already failed on the old model', async () => {
    const cases = { cases: [...CASES.cases, { name: 'tone', messages: [{ role: 'user', content: 'hi' }], expect: { contains: ['welcome'] } }] };
    const { fetch } = fakeProvider({ 'gpt-4-0613': 'You have 30 days.', 'gpt-5.6-sol': 'Within 30 days.' });
    const r = await runEvalCases(repoWithCases(cases), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch });
    expect(r.status).toBe('passed');
    expect(r.output).toContain('1 already failed on the old model and still fail');
  });

  it('judges the new answer alone once the old model has shut down', async () => {
    const { fetch, bodies } = fakeProvider({ 'gpt-5.6-sol': 'nope' });
    const r = await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [{ ...SWAP, oldRetired: true }], registry: REG, env: KEY, fetch });
    expect(r.status).toBe('failed');
    expect(bodies.map((b) => b.model)).toEqual(['gpt-5.6-sol']);
  });

  it('is inconclusive without a key, and when the new model cannot be reached', async () => {
    const noKey = await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [SWAP], registry: REG, env: {}, fetch: fakeProvider({}).fetch });
    expect(noKey).toMatchObject({ status: 'inconclusive', output: 'OPENAI_API_KEY is not set in this environment, so no case could be sent' });
    const { fetch } = fakeProvider({ 'gpt-4-0613': 'You have 30 days.', 'gpt-5.6-sol': 503 });
    expect((await runEvalCases(repoWithCases(), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch })).status).toBe('inconclusive');
  });

  it('skips a migration with no OpenAI swap, and says to use an eval command', async () => {
    const r = await runEvalCases(repoWithCases(), {
      file: 'cases.json',
      swaps: [{ provider: 'anthropic', from: 'claude-sonnet-4-5', to: 'claude-sonnet-5-5' }],
      registry: REG,
      env: KEY,
      fetch: fakeProvider({}).fetch,
    });
    expect(r.status).toBe('skipped');
    expect(r.output).toMatch(/OpenAI models only/);
  });

  it('is inconclusive on a broken cases file, naming the problem', async () => {
    const r = await runEvalCases(repoWithCases({ nope: 1 }), { file: 'cases.json', swaps: [SWAP], registry: REG, env: KEY, fetch: fakeProvider({}).fetch });
    expect(r.status).toBe('inconclusive');
    expect(r.output).toContain('could not use the cases file: cases.json must be an object with a "cases" list');
  });
});

describe('the eval gate policy with a cases file', () => {
  it('makes the eval required by default, and an --eval-command still overrides the file', () => {
    expect(resolveGatePolicy({ gates: { eval: { cases: 'cases.json' } } }).eval).toEqual({ required: true, cases: 'cases.json' });
    expect(resolveGatePolicy({ gates: { eval: { cases: 'cases.json' } } }, 'npm run eval').eval).toEqual({ required: true, command: 'npm run eval' });
  });
});
