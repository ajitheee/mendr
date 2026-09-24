import { describe, it, expect } from 'vitest';
import { sanitize, redactValues, secretValuesFromEnv } from './sanitize.js';

// THE CANARY. One marker string per channel, driven through the sanitizer the
// way it would arrive in real output. A test fails if the canary survives.
//
// This exists because a credential that reached the migrate report was not
// merely logged — mendr-action publishes that file to the Actions log, the job
// summary and the body of a PUBLIC pull request. The bar is therefore not "we
// redact tokens", it is "no known-secret shape reaches a published surface".

const CANARY = 'MENDRCANARY00000000000000000000';

describe('secret shapes never survive', () => {
  const cases: Array<[string, string]> = [
    ['OpenAI-style key', `sk-${CANARY}`],
    ['Anthropic-style key', `sk-ant-api03-${CANARY}`],
    ['GitHub PAT (classic)', `ghp_${CANARY}`],
    ['GitHub PAT (fine-grained)', `github_pat_${CANARY}_${CANARY}`],
    ['Google API key', `AIza${CANARY}`],
    ['HuggingFace token', `hf_${CANARY}`],
    ['Groq key', `gsk_${CANARY}${CANARY}`],
    ['Slack token', `xoxb-${CANARY}`],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT / OIDC', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${CANARY}`],
    ['Bearer token', `Bearer ${CANARY}`],
    ['Authorization header', `Authorization: token ${CANARY}`],
    ['credentials in a URL', `https://ajith:${CANARY}@github.com/o/r.git`],
    ['named env assignment', `OPENAI_API_KEY=${CANARY}`],
    ['named env, lowercase value', `MY_SERVICE_TOKEN: "${CANARY}"`],
  ];

  for (const [name, text] of cases) {
    it(`redacts ${name}`, () => {
      const out = sanitize(text);
      expect(out).not.toContain(CANARY);
      expect(out).toContain('***REDACTED***');
    });
  }

  it('redacts a PEM private key block without leaving the body behind', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg${CANARY}\nkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`;
    const out = sanitize(pem);
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain('MIIBVgIBADANBg');
  });

  // The shapes that made this a P0: what mendr-action actually publishes.
  it('redacts a key inlined in an eval command, as the action publishes it', () => {
    const line = `Running your evaluation against the patched code: OPENAI_API_KEY=sk-${CANARY} npm run evals`;
    expect(sanitize(line)).not.toContain(CANARY);
  });

  it('redacts a credential appearing inside a diff context line', () => {
    const diff = ['--- a/src/client.ts', '+++ b/src/client.ts', '@@ -1,4 +1,4 @@', ` const key = "sk-${CANARY}";`, "-  model: 'gpt-4',", "+  model: 'gpt-5.6-sol',"].join('\n');
    const out = sanitize(diff);
    expect(out).not.toContain(CANARY);
    // The diff must still READ as a diff — redaction is not mangling.
    expect(out).toContain('+++ b/src/client.ts');
    expect(out).toContain("+  model: 'gpt-5.6-sol',");
  });

  it('redacts a credential in a stack trace, which 2>&1 puts in the same file', () => {
    const trace = `Error: request failed\n    at fetch (/repo/src/x.ts:4:11) with token ghp_${CANARY}\n    at main`;
    expect(sanitize(trace)).not.toContain(CANARY);
  });
});

describe('by-value redaction — the mechanism patterns cannot replace', () => {
  it('redacts a known value in a format no pattern would recognise', () => {
    const weird = 'hunter2-correct-horse-battery-staple';
    const text = `the runner printed ${weird} while starting`;
    expect(sanitize(text)).toContain(weird); // no pattern matches it
    expect(sanitize(text, [weird])).not.toContain(weird); // by value, it is gone
  });

  it('collects INPUT_* values and named secrets from the environment', () => {
    const values = secretValuesFromEnv({
      INPUT_EVAL_COMMAND: 'OPENAI_API_KEY=sk-live npm run evals',
      INPUT_APP_URL: 'https://mendr-app.onrender.com',
      MY_SERVICE_TOKEN: 'a-long-enough-token-value',
      PATH: '/usr/bin:/bin',
      HOME: '/home/runner',
    });
    expect(values).toContain('OPENAI_API_KEY=sk-live npm run evals');
    expect(values).toContain('a-long-enough-token-value');
    expect(values).not.toContain('/usr/bin:/bin');
  });

  it('skips structural and short inputs, which would shred a report for nothing', () => {
    const values = secretValuesFromEnv({ INPUT_SEND_DIFF: 'true', INPUT_ONLY: 'gpt-4', INPUT_AUDIENCE: 'mendr' });
    expect(values).toEqual([]);
  });

  it('redacts the longest value first, so no recognisable tail survives', () => {
    const out = redactValues('token=abcdefghijkl-suffix', ['abcdefghijkl', 'abcdefghijkl-suffix']);
    expect(out).toBe('token=***REDACTED***');
  });
});

describe('the sanitizer cannot be used to stall a build', () => {
  // Every pattern runs over attacker-influenced text inside someone else's CI:
  // a test failure, a dependency's log line, a stack trace. A quantifier that
  // backtracks is a denial of service on their pipeline, so the budget is
  // asserted rather than assumed.
  const BUDGET_MS = 2000;

  const adversarial: Array<[string, string]> = [
    ['200k chars, no separators', 'a'.repeat(200_000)],
    ['100k periods', '.'.repeat(100_000)],
    ['almost-JWT, long segments', `ey${'A'.repeat(50_000)}.${'B'.repeat(50_000)}.`],
    ['repeated BEGIN markers', '-----BEGIN PRIVATE KEY-----\n'.repeat(2_000)],
    ['binary-looking text', Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')],
    ['a normal log with versions and paths', 'node_modules/@scope/pkg@1.2.3-beta.4/dist/index.js:42:11\n'.repeat(3_000)],
    ['Bearer prefix without a token', 'Bearer '.repeat(30_000)],
    ['scheme://user: without an at-sign', 'https://user:'.repeat(20_000)],
  ];

  for (const [name, input] of adversarial) {
    it(`stays under ${BUDGET_MS}ms on ${name}`, () => {
      const started = performance.now();
      sanitize(input);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it('leaves an ordinary log untouched', () => {
    const log = ['> mendr@0.5.5-alpha test', '> vitest run', '', ' Test Files  93 passed (93)', '      Tests  1431 passed (1431)', '   Duration  182.52s'].join('\n');
    expect(sanitize(log)).toBe(log);
  });
});
