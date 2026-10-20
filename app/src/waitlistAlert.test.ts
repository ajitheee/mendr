import { describe, expect, it } from 'vitest';
import { AlertError, alertMessage, createSignupAlert, RESEND_URL, type SignupAlert } from './waitlistAlert.js';

// One email to the maintainer per new sign-up, through Resend: what it says, where it goes, and
// that a missing setting means no alert rather than a broken sign-up.

const AT = new Date('2026-10-16T09:41:00Z');
const ALERT: SignupAlert = {
  signup: { email: 'dev@example.com', usesLlm: 'not_sure', wantsCheck: true, note: 'gpt-4 in our support bot' },
  position: 12,
  spots: 50,
  at: AT,
};

function recorder(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('alertMessage', () => {
  it('names the spot and every answer, in plain text', () => {
    const { subject, text } = alertMessage(ALERT);
    expect(subject).toBe('mendr waitlist: #12 of 50');
    expect(text).toContain('New sign-up: spot 12 of 50.');
    expect(text).toContain('Email: dev@example.com');
    expect(text).toContain('Calls OpenAI, Anthropic or Google from their own code: not sure');
    expect(text).toContain('Wants their repo checked before October 23: yes, this week');
    expect(text).toContain('Note: gpt-4 in our support bot');
    expect(text).toContain('Signed up: 2026-10-16 09:41 UTC');
  });

  it('says when the 50 are gone and the page promised an email to confirm', () => {
    const { subject, text } = alertMessage({ ...ALERT, position: 57, signup: { ...ALERT.signup, note: null, wantsCheck: false } });
    expect(subject).toBe('mendr waitlist: #57, past the 50 (email them to confirm)');
    expect(text).toContain('All 50 spots were taken');
    expect(text).toContain('Note: (none)');
    expect(text).toContain('not now');
  });
});

describe('createSignupAlert', () => {
  it('is off unless both the key and the address are set', () => {
    expect(createSignupAlert({ apiKey: null, to: 'me@example.org' })).toBeNull();
    expect(createSignupAlert({ apiKey: 're_test', to: null })).toBeNull();
  });

  it('sends one message to the maintainer, with Reply-To set to the person who signed up', async () => {
    const r = recorder();
    const send = createSignupAlert({ apiKey: 're_test', to: 'me@example.org', fetch: r.fetch })!;
    await send(ALERT);
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call!.url).toBe(RESEND_URL);
    expect(call!.init.method).toBe('POST');
    expect((call!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(String(call!.init.body));
    expect(body).toMatchObject({ from: 'mendr waitlist <onboarding@resend.dev>', to: ['me@example.org'], reply_to: 'dev@example.com', subject: 'mendr waitlist: #12 of 50' });
    expect(body.text).toContain('Email: dev@example.com');
  });

  it('throws the status, and only the status, when Resend refuses', async () => {
    const send = createSignupAlert({ apiKey: 're_bad', to: 'me@example.org', fetch: recorder(403).fetch })!;
    const err = await send(ALERT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlertError);
    expect((err as AlertError).status).toBe(403);
    expect((err as AlertError).message).toBe('Resend answered 403');
  });
});
