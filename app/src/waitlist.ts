import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Store, WaitlistSignupInput } from './store/types.js';

// THE EARLY-ACCESS WAITLIST: the marketing site's sign-up form posts here.
//
// What is kept is what the form shows, and nothing else: the email, two answers and an optional
// note (TRUST.md, "Personal data"). No IP address is stored. The address a request came from is
// used only for the in-memory rate limit below and is forgotten when the process restarts.
//
// The 50 spots are real and counted from the database. The list does not close at 50: it keeps
// taking names for the next round, and says so, because turning someone away from a free tool's
// waitlist teaches nothing.

export const WAITLIST_SPOTS = 50;
/** The site that may post from a browser. A script without an Origin header is not a browser. */
export const WAITLIST_ORIGINS = ['https://mendr-mu.vercel.app'];
const MAX_NOTE = 500;
const PER_ADDRESS_PER_HOUR = 5;

type ParseResult = { ok: true; input: WaitlistSignupInput } | { ok: false; error: string };

/** Validate a sign-up, with errors a person can act on. Exported for tests. */
export function parseSignup(body: unknown): ParseResult & { trap?: boolean } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Send the form as JSON.' };
  const b = body as Record<string, unknown>;
  // A field people never see. A bot that fills every field fills this one.
  if (typeof b.website === 'string' && b.website.trim() !== '') return { ok: false, error: 'Sign-up refused.', trap: true };
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter the email address we should write to, such as you@company.com.' };
  }
  if (b.usesLlm !== 'yes' && b.usesLlm !== 'no' && b.usesLlm !== 'not_sure') {
    return { ok: false, error: 'Say whether your product calls OpenAI, Anthropic or Google from its own code: yes, no or not sure.' };
  }
  if (typeof b.wantsCheck !== 'boolean') {
    return { ok: false, error: 'Say whether you want your repo checked before October 23.' };
  }
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, MAX_NOTE) : null;
  return { ok: true, input: { email, usesLlm: b.usesLlm, wantsCheck: b.wantsCheck, note } };
}

export function registerWaitlist(app: Hono, deps: { store: Store; now: () => Date; log: (m: string, extra?: Record<string, unknown>) => void }): void {
  const recent = new Map<string, number[]>();
  const limited = (address: string): boolean => {
    const t = deps.now().getTime();
    const hits = (recent.get(address) ?? []).filter((x) => t - x < 3_600_000);
    hits.push(t);
    recent.set(address, hits);
    return hits.length > PER_ADDRESS_PER_HOUR;
  };

  app.use('/api/waitlist*', cors({ origin: WAITLIST_ORIGINS, allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'], maxAge: 600 }));

  app.get('/api/waitlist/count', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, count: await deps.store.waitlistCount(), spots: WAITLIST_SPOTS });
  });

  app.post('/api/waitlist', async (c) => {
    const origin = c.req.header('origin');
    if (origin && !WAITLIST_ORIGINS.includes(origin)) return c.json({ ok: false, error: 'Sign up from the mendr site.' }, 403);
    const address = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
    if (limited(address)) return c.json({ ok: false, error: 'Too many sign-ups from here in the last hour. Try again later.' }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'Send the form as JSON.' }, 400);
    }
    const parsed = parseSignup(body);
    if (!parsed.ok) {
      if (parsed.trap) deps.log('waitlist: trap field filled; refused');
      return c.json({ ok: false, error: parsed.error }, 400);
    }
    const { created, position } = await deps.store.addWaitlistSignup(parsed.input);
    // The log says that a sign-up happened, never who: no email in a log line.
    deps.log('waitlist: sign-up', { created, position });
    return c.json({ ok: true, created, position, spots: WAITLIST_SPOTS, inFirstRound: position <= WAITLIST_SPOTS });
  });
}
