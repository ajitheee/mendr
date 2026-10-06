// L3 — an AI reader for provider pages the table parser cannot read, held to the literal standard.
//
// `discover` reads deprecation TABLES deterministically and refuses anything else. That covers the
// three providers Mendr reads (OpenAI, Anthropic, Google), whose remaining refused rows are choices
// between replacements, not prose. Prose matters for breadth: providers that announce retirements
// in sentences, or in tables whose shape no rule here knows.
//
// The model is a PARSER, never an authority. It may only return claims that point at an exact
// sentence or row on the page (`quote`), and every claim then passes a deterministic check before
// anything is kept:
//   - the quote is on the page, word for word (pageText.ts, the normalizer check-rules uses);
//   - the quote names the retiring id as a whole token;
//   - the quote states the claimed shutdown date;
//   - every replacement id is in the quote too, or it is dropped (never invented).
// A hallucinated id has no sentence to point to, so it cannot pass. This answers discover's own
// objection to an LLM ("a hallucinated model id would be indistinguishable from a real one"):
// here it is distinguishable, mechanically.
//
// This module writes nothing and fetches nothing. The caller supplies the page text and a client
// that sends one chat request; readings become candidates only through the existing human gate.

import { normalizePageText, quoteCrossesRows, quoteIsOnPage } from './pageText.js';

export const AI_READER_PROMPT_VERSION = 'ai-reader/1';

/** What the model is asked to return, per claim. */
export interface AiClaim {
  deprecated: string;
  shutdown_date: string;
  replacements: string[];
  quote: string;
}

/** A claim that passed every check, with any replacement that did not. */
export interface AcceptedClaim {
  deprecated: string;
  shutdownDate: string;
  replacements: string[];
  quote: string;
  /** Replacements the model offered that are not in the quote, and were therefore dropped. */
  droppedReplacements: string[];
}

export interface RejectedClaim {
  claim: unknown;
  why: string;
}

export interface Reading {
  accepted: AcceptedClaim[];
  rejected: RejectedClaim[];
  /** Set when the model's answer could not be read as the requested JSON at all. */
  error?: string;
}

/** Sends one chat request and returns the assistant's text. Injected, so tests need no network. */
export type ChatClient = (system: string, user: string) => Promise<string>;

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** `year-month-day` as YYYY-MM-DD when that day exists on the calendar, else undefined. */
function realDate(year: string, month: number, day: number): string | undefined {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/**
 * Every date `text` states, as YYYY-MM-DD: ISO, written out ("April 4th, 2026"), or numeric
 * ("09/21/26") when only ONE calendar reading exists. "10/08/25" could be October 8 or 10 August,
 * so it states neither; a claim it supports has to quote a sentence that spells the date out.
 */
export function allDatesIn(text: string): Set<string> {
  const out = new Set<string>();
  const add = (iso: string | undefined): void => {
    if (iso) out.add(iso);
  };
  const t = text.replace(/[‐-―−]/g, '-');
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(realDate(m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) add(realDate(m[3], +month, +m[2]));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    const readings = new Set([realDate(year, +m[1], +m[2]), realDate(year, +m[2], +m[1])]);
    readings.delete(undefined);
    if (readings.size === 1) add([...readings][0]);
  }
  return out;
}

/**
 * Does `text` name `id` as a whole token? Not as a prefix of a longer id (`gpt-4` inside
 * `gpt-4.1`), but a sentence's closing period after the id still counts as a boundary.
 */
function namesId(text: string, id: string): boolean {
  return idPattern(id, 'i').test(text);
}

function idPattern(id: string, flags: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._-])${escaped}(?=$|[^a-z0-9._-]|\\.(?:\\s|$))`, flags);
}

/** Words that put an id in a sentence as a replacement or a base model, not as the thing retiring. */
const NOT_RETIRING_BEFORE =
  /(?:in favou?r of|migrat(?:e|ing|ion) to|replaced (?:by|with)|upgrad(?:e|ed|ing) to|switch(?:ing)? to|fine-tuned (?:with|from|on)|replacement(?: model)?(?: is)?|successor(?: is)?)[\s,:]*$/i;

/**
 * Does the quote name `id` at least once as the model retiring? "we will sunset all models
 * fine-tuned with Command-R-03-2024" names the id and the date, and retires the fine-tunes, not the
 * model: measured on Cohere's page, 2026-10-05. An id that only ever follows a replacement phrase is
 * not what the quote retires.
 */
function namesAsRetiring(text: string, id: string): boolean {
  for (const m of text.matchAll(idPattern(id, 'gi'))) {
    if (!NOT_RETIRING_BEFORE.test(text.slice(0, (m.index ?? 0) + m[1].length))) return true;
  }
  return false;
}

/** The shape of a model id: no spaces, starts and ends alphanumeric. */
const ID_SHAPE = /^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$/i;

/** The request: the page, and the exact JSON shape every claim must take. */
export function buildPrompt(provider: string, pageText: string): { system: string; user: string } {
  const system = [
    'You extract model retirement claims from an AI provider\'s documentation page.',
    'Return JSON only: {"claims":[{"deprecated":"<model id>","shutdown_date":"YYYY-MM-DD","replacements":["<model id>"],"quote":"<text>"}]}.',
    'Rules:',
    '- Only models with a stated shutdown, retirement or deactivation date. Skip anything without a date.',
    '- "quote" must be copied EXACTLY from the page, in one piece, and contain the model id and the date. It is one table row (each row is on its own line of the page text), or one sentence, or a sentence that gives the date followed by the list of models under it, every list item up to the model included, none skipped.',
    '- A quote never runs from one line of the page text into the next.',
    '- A numeric date that reads two ways (03/09/26 is March 9 or 3 September) states neither. For such a row, quote the heading or sentence that names the model and writes the date out instead.',
    '- "replacements" lists only model ids the quote itself names as the replacement; use [] if the quote names none. Never guess a replacement.',
    '- Use model ids exactly as written on the page. Do not invent, complete or normalize them.',
    '- If there are no such claims, return {"claims":[]}.',
  ].join('\n');
  const user = `Provider: ${provider}\n\nPage text:\n${normalizePageText(pageText)}`;
  return { system, user };
}

/** Check one claim against the page. Returns the accepted claim, or why it was refused. */
export function verifyClaim(raw: unknown, pageText: string): AcceptedClaim | RejectedClaim {
  const reject = (why: string): RejectedClaim => ({ claim: raw, why });
  if (typeof raw !== 'object' || raw === null) return reject('not an object');
  const c = raw as Partial<AiClaim>;
  if (typeof c.deprecated !== 'string' || !ID_SHAPE.test(c.deprecated)) return reject('no usable model id');
  if (typeof c.shutdown_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.shutdown_date)) {
    return reject('no ISO shutdown date');
  }
  if (typeof c.quote !== 'string' || c.quote.trim() === '') return reject('no quote');
  if (quoteCrossesRows(c.quote)) return reject('quote runs across table rows or into another section');
  if (!quoteIsOnPage(c.quote, pageText)) return reject('quote is not on the page, word for word');
  const quote = normalizePageText(c.quote);
  if (!namesId(quote, c.deprecated)) return reject(`quote does not name ${c.deprecated}`);
  if (!namesAsRetiring(quote, c.deprecated)) {
    return reject(`quote names ${c.deprecated} only as a replacement or a base model`);
  }
  if (!allDatesIn(quote).has(c.shutdown_date)) return reject(`quote does not state ${c.shutdown_date}`);

  const offered = Array.isArray(c.replacements) ? c.replacements.filter((r): r is string => typeof r === 'string') : [];
  const replacements = offered.filter((r) => ID_SHAPE.test(r) && namesId(quote, r) && r !== c.deprecated);
  return {
    deprecated: c.deprecated,
    shutdownDate: c.shutdown_date,
    replacements,
    quote: c.quote,
    droppedReplacements: offered.filter((r) => !replacements.includes(r)),
  };
}

/** Parse the model's answer and check every claim. Deterministic given the answer and the page. */
export function verifyReading(answer: string, pageText: string): Reading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { accepted: [], rejected: [], error: 'the answer is not JSON' };
  }
  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return { accepted: [], rejected: [], error: 'the answer has no "claims" array' };
  const accepted: AcceptedClaim[] = [];
  const rejected: RejectedClaim[] = [];
  const seen = new Set<string>();
  for (const raw of claims) {
    const result = verifyClaim(raw, pageText);
    if ('why' in result) {
      rejected.push(result);
      continue;
    }
    const key = `${result.deprecated}|${result.shutdownDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(result);
  }
  return { accepted, rejected };
}

/** Ask the model to read a page, then keep only what the page literally supports. */
export async function readPage(provider: string, pageText: string, client: ChatClient): Promise<Reading> {
  const { system, user } = buildPrompt(provider, pageText);
  return verifyReading(await client(system, user), pageText);
}

export interface ChatEndpoint {
  /** An OpenAI-compatible chat-completions URL: https, or http only on this machine. */
  url: string;
  model: string;
  /** Sent as a bearer token when set; a local runtime may need none. */
  key?: string;
}

/** Why `url` cannot be sent a page (and a key), or undefined when it can. */
export function endpointProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (parsed.protocol === 'https:') return undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return parsed.protocol === 'http:' && local ? undefined : `${url} is not https, and only an endpoint on this machine may use plain http`;
}

/**
 * A ChatClient for any OpenAI-compatible chat-completions endpoint, the request shape most hosted
 * providers and local runtimes accept. Which endpoint is the operator's choice, so nothing here
 * names a vendor: the free one this was first written against, GitHub Models, was retired on
 * 2026-07-30, and its host still answers every request with a bare "OK". So an answer counts only
 * when it is a chat completion; anything else is an error that says what came back.
 * Temperature 0 and a JSON response, for the most repeatable answer the endpoint offers;
 * repeatability of the KEPT claims comes from verifyReading, not the model.
 */
export function chatCompletionsClient(endpoint: ChatEndpoint, fetchImpl: typeof fetch = fetch): ChatClient {
  return async (system, user) => {
    const res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`the endpoint answered HTTP ${res.status}`);
    let content: unknown;
    try {
      content = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    } catch {
      content = undefined;
    }
    if (typeof content !== 'string') {
      throw new Error(`the endpoint answered, but not with a chat completion; it sent ${JSON.stringify(body.slice(0, 60))}`);
    }
    return content;
  };
}
