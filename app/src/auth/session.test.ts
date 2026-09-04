import { describe, expect, it } from 'vitest';
import { openSession, sealSession } from './session.js';

const secret = 'a-session-secret-that-is-long-enough';
const future = Math.floor(Date.now() / 1000) + 3600;

describe('sessions are encrypted cookies, not rows', () => {
  it('round-trips through the cookie value', async () => {
    const sealed = await sealSession({ userId: 7, login: 'octocat', token: 'gho_x', exp: future }, secret);
    expect(sealed).not.toContain('octocat');
    expect(sealed).not.toContain('gho_x');
    expect(await openSession(sealed, secret)).toEqual({ userId: 7, login: 'octocat', token: 'gho_x', exp: future });
  });

  it('is null when tampered, under another secret, or expired', async () => {
    const sealed = await sealSession({ userId: 7, login: 'octocat', token: 'gho_x', exp: future }, secret);
    expect(await openSession(sealed.slice(0, -4) + 'AAAA', secret)).toBeNull();
    expect(await openSession(sealed, 'a-different-secret-that-is-long-enough')).toBeNull();
    const expired = await sealSession({ userId: 7, login: 'octocat', token: 'gho_x', exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(await openSession(expired, secret)).toBeNull();
    expect(await openSession('garbage', secret)).toBeNull();
  });
});
