import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store/memory.js';
import { parseSignup, registerWaitlist, WAITLIST_ORIGINS, WAITLIST_SPOTS } from './waitlist.js';
import { AlertError, type SignupAlert } from './waitlistAlert.js';

// The early-access form on the marketing site. It keeps an email and two answers, counts the 50
// spots from what is stored, and never writes an email into a log line.

const SITE = WAITLIST_ORIGINS[0]!;
const GOOD = { email: ' Dev@Example.com ', usesLlm: 'yes', wantsCheck: true, note: 'gpt-4 in our support bot' };

function harness(alert?: (a: SignupAlert) => Promise<void>) {
  const store = new MemoryStore();
  const logs: { m: string; extra?: Record<string, unknown> }[] = [];
  const app = new Hono();
  registerWaitlist(app, { store, now: () => new Date(), log: (m, extra) => logs.push(extra ? { m, extra } : { m }), alert });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/waitlist', {
      method: 'POST',
      headers: { origin: SITE, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, store, logs, post };
}

describe('parseSignup', () => {
  it('normalizes the email and keeps the answers', () => {
    expect(parseSignup(GOOD)).toEqual({ ok: true, input: { email: 'dev@example.com', usesLlm: 'yes', wantsCheck: true, note: 'gpt-4 in our support bot' } });
  });
  it('names what is missing, in a sentence', () => {
    expect(parseSignup({ ...GOOD, email: 'nope' })).toMatchObject({ ok: false, error: 'Enter the email address we should write to, such as you@company.com.' });
    expect(parseSignup({ ...GOOD, usesLlm: 'maybe' })).toMatchObject({ ok: false, error: expect.stringContaining('yes, no or not sure') });
    expect(parseSignup({ ...GOOD, wantsCheck: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('before October 23') });
  });
  it('caps the note and drops an empty one', () => {
    const long = parseSignup({ ...GOOD, note: 'x'.repeat(900) });
    expect(long.ok && long.input.note?.length).toBe(500);
    const empty = parseSignup({ ...GOOD, note: '   ' });
    expect(empty.ok && empty.input.note).toBeNull();
  });
  it('refuses a filled trap field', () => {
    expect(parseSignup({ ...GOOD, website: 'http://spam.example' })).toMatchObject({ ok: false, trap: true });
  });
});

describe('the waitlist routes', () => {
  it('takes a sign-up, says its place, and counts it', async () => {
    const h = harness();
    const res = await h.post(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: true, position: 1, spots: WAITLIST_SPOTS, inFirstRound: true });
    const count = await h.app.request('/api/waitlist/count', { headers: { origin: SITE } });
    expect(await count.json()).toEqual({ ok: true, count: 1, spots: WAITLIST_SPOTS });
    expect(count.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('keeps the first sign-up when the same email comes again', async () => {
    const h = harness();
    await h.post(GOOD);
    const again = await (await h.post({ ...GOOD, email: 'DEV@example.com', usesLlm: 'no' })).json();
    expect(again).toMatchObject({ ok: true, created: false, position: 1 });
    expect(await h.store.waitlistCount()).toBe(1);
  });

  it('keeps taking names after the 50th, marked as the next round', async () => {
    const h = harness();
    for (let i = 0; i < WAITLIST_SPOTS; i++) await h.store.addWaitlistSignup({ email: `p${i}@example.com`, usesLlm: 'yes', wantsCheck: false, note: null });
    const late = await (await h.post(GOOD)).json();
    expect(late).toMatchObject({ ok: true, position: 51, inFirstRound: false });
  });

  it('refuses a browser post from another site', async () => {
    const res = await harness().post(GOOD, { origin: 'https://elsewhere.example' });
    expect(res.status).toBe(403);
  });

  it('rate-limits one address after five sign-ups in an hour', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) expect((await h.post({ ...GOOD, email: `a${i}@example.com` })).status).toBe(200);
    expect((await h.post({ ...GOOD, email: 'a6@example.com' })).status).toBe(429);
    expect((await h.post({ ...GOOD, email: 'b@example.com' }, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
  });

  it('answers a bad form with the sentence, and logs no email', async () => {
    const h = harness();
    const bad = await h.post({ ...GOOD, email: 'x' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Enter the email address/);
    await h.post(GOOD);
    expect(JSON.stringify(h.logs)).not.toContain('example.com');
    expect(h.logs.at(-1)).toEqual({ m: 'waitlist: sign-up', extra: { created: true, position: 1 } });
  });
});

describe('the sign-up alert', () => {
  // The alert is sent after the response, so let it settle before looking.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('emails once per new person, with the stored answers and the spot, and not for a repeat', async () => {
    const sent: SignupAlert[] = [];
    const h = harness(async (a) => {
      sent.push(a);
    });
    await h.post(GOOD);
    await h.post({ ...GOOD, email: 'DEV@example.com' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ signup: { email: 'dev@example.com', usesLlm: 'yes', wantsCheck: true }, position: 1, spots: WAITLIST_SPOTS });
    expect(h.logs.filter((l) => l.m.startsWith('waitlist: alert'))).toEqual([{ m: 'waitlist: alert sent', extra: { position: 1 } }]);
  });

  it('still takes the sign-up when the alert fails, and logs the status without the email', async () => {
    const h = harness(async () => {
      throw new AlertError(401);
    });
    const res = await h.post(GOOD);
    await settle();
    expect(res.status).toBe(200);
    expect(await h.store.waitlistCount()).toBe(1);
    expect(h.logs.at(-1)).toEqual({ m: 'waitlist: alert failed', extra: { position: 1, reason: 'status 401' } });
    expect(JSON.stringify(h.logs)).not.toContain('example.com');
  });
});
