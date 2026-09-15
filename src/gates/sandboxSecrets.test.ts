import { describe, expect, it } from 'vitest';
import { gateEnv, redactCaptured, truncateOutput } from './sandbox.js';

// SLICE 2 — SECRET-SAFE VERIFICATION. Two leaks, both on the path a private repository takes
// the first time it runs a Mendr migration.
//
// (1) The gate subprocess inherited the whole environment, including the migrate job's own
//     contents:write / pull-requests:write token and its OIDC request credentials. The gates
//     run the CUSTOMER's build, test and eval commands, so any code in their dependency tree
//     could have used Mendr's job token to push to their default branch.
// (2) Captured stdout/stderr was transmitted to the App and only redacted on ARRIVAL, so a
//     secret printed by a test had already crossed the network.

describe('gateEnv — the CI credentials a gate subprocess must not inherit', () => {
  const base = {
    GITHUB_TOKEN: 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.example/oidc',
    ACTIONS_RUNTIME_TOKEN: 'runtime-token',
    ACTIONS_RESULTS_URL: 'https://results.example',
    INPUT_APP_URL: 'https://app.example',
    OPENAI_API_KEY: 'sk-customer-owns-this-one',
    DATABASE_URL: 'postgres://localhost/app',
    PATH: '/usr/bin',
    HOME: '/home/runner',
  };

  it('drops the job token, the OIDC credentials and every action input', () => {
    const env = gateEnv(base);
    for (const k of [
      'GITHUB_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_RESULTS_URL',
      'INPUT_APP_URL',
    ]) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  // Stripping the customer's own secrets is what turns a passing gate inconclusive, which
  // makes the product look worse than it is. Their tests must run exactly as they always do.
  it("keeps the customer's own application environment untouched", () => {
    const env = gateEnv(base);
    expect(env.OPENAI_API_KEY).toBe('sk-customer-owns-this-one');
    expect(env.DATABASE_URL).toBe('postgres://localhost/app');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
  });

  it('does not mutate the environment it was given', () => {
    const copy = { ...base };
    gateEnv(base);
    expect(base).toEqual(copy);
  });
});

describe('redactCaptured — secrets are cleaned before they leave the machine', () => {
  it('redacts the shapes the App redacts on arrival', () => {
    const out = redactCaptured(
      [
        'using sk-liveKEY1234567890abcdef',
        'token ghp_abcdefghijklmnopqrstuvwxyz012345',
        'pat github_pat_11ABCDEFG0123456789_abcdefghij',
        'slack xoxb-1234567890-abcdefghij',
        'aws AKIAIOSFODNN7EXAMPLE',
        'OPENAI_API_KEY=sk-anotherliveone12345',
      ].join('\n'),
    );
    expect(out).not.toContain('sk-liveKEY1234567890abcdef');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('github_pat_11ABCDEFG0123456789_abcdefghij');
    expect(out).not.toContain('xoxb-1234567890-abcdefghij');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('sk-anotherliveone12345');
    expect(out).toContain('***REDACTED***');
  });

  it('leaves ordinary test output alone', () => {
    const plain = '  ✓ src/app.test.ts (12 tests) 340ms\n  Tests  12 passed (12)';
    expect(redactCaptured(plain)).toBe(plain);
  });
});

describe('truncateOutput redacts BEFORE it truncates', () => {
  it('a secret near the cut is not split into two harmless-looking halves', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    // pad so the secret lands right at the head/tail boundary of a truncated capture
    const out = truncateOutput('x'.repeat(3990) + secret + 'y'.repeat(9000));
    expect(out).not.toContain(secret);
    expect(out).not.toContain('ghp_abcdefghijklmnopq');
    expect(out).toContain('truncated');
  });

  it('short output is still redacted', () => {
    expect(truncateOutput('leaked ghp_abcdefghijklmnopqrstuvwxyz012345')).toContain('***REDACTED***');
  });
});
