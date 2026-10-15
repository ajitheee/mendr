import type { WaitlistSignupInput } from './store/types.js';

// THE SIGN-UP ALERT: one email to the maintainer for each new name on the early-access waitlist,
// so a sign-up is answered the day it arrives, not whenever someone next opens the database.
//
// Sent through Resend's HTTP API: one fetch, no SDK. Without a verified domain, Resend sends only
// from onboarding@resend.dev and only to the address that owns the account, which is exactly this
// use: the maintainer writing to themselves. Reply-To is the person who signed up, so answering
// the alert answers them.
//
// The alert decides nothing. It goes out after the row is stored; a failure is logged (a status,
// never an address) and the sign-up still succeeds. A repeat sign-up sends nothing.

export const RESEND_URL = 'https://api.resend.com/emails';
const SENDER = 'mendr waitlist <onboarding@resend.dev>';
const TIMEOUT_MS = 10_000;

export interface SignupAlert {
  signup: WaitlistSignupInput;
  position: number;
  spots: number;
  at: Date;
}
export type SendAlert = (alert: SignupAlert) => Promise<void>;

/** Resend refused or failed the send. Carries the status only: the body may echo the address. */
export class AlertError extends Error {
  constructor(readonly status: number) {
    super(`Resend answered ${status}`);
  }
}

const USES: Record<WaitlistSignupInput['usesLlm'], string> = { yes: 'yes', no: 'no', not_sure: 'not sure' };

/** The alert as plain text. Exported for tests. */
export function alertMessage(a: SignupAlert): { subject: string; text: string } {
  const inside = a.position <= a.spots;
  const subject = inside
    ? `mendr waitlist: #${a.position} of ${a.spots}`
    : `mendr waitlist: #${a.position}, past the ${a.spots} (email them to confirm)`;
  const text = [
    inside
      ? `New sign-up: spot ${a.position} of ${a.spots}.`
      : `New sign-up: number ${a.position}. All ${a.spots} spots were taken, so the page told them you will email to confirm.`,
    '',
    `Email: ${a.signup.email}`,
    `Calls OpenAI, Anthropic or Google from their own code: ${USES[a.signup.usesLlm]}`,
    `Wants their repo checked before October 23: ${a.signup.wantsCheck ? 'yes, this week' : 'not now'}`,
    `Note: ${a.signup.note ?? '(none)'}`,
    `Signed up: ${a.at.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    'Reply to this email to write to them.',
  ].join('\n');
  return { subject, text };
}

/** The sender, or null when either setting is missing: no key or no address means no alert. */
export function createSignupAlert(opts: { apiKey: string | null; to: string | null; fetch?: typeof fetch }): SendAlert | null {
  const { apiKey, to } = opts;
  if (!apiKey || !to) return null;
  const send = opts.fetch ?? fetch;
  return async (a) => {
    const { subject, text } = alertMessage(a);
    const res = await send(RESEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: SENDER, to: [to], reply_to: a.signup.email, subject, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new AlertError(res.status);
  };
}
