import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LlmRegistry } from '../types.js';
import { modelMatches, paramEntries } from '../usage/llmRegistry.js';
import type { EvalGateResult } from './runEval.js';

// CHECK 2: THE TEAM'S OWN CASES, ON THE OLD MODEL AND THE NEW ONE.
//
// The eval gate used to mean "run the command you wrote". Most teams have no such command. This
// is the version they can fill in: a file of cases, each one a request their feature really sends
// and what a good answer must look like (contains, must not contain, matches, a length limit,
// valid JSON). mendr sends each case to the old model and to the new one with the team's own API
// key, from the team's own CI, and compares:
//
//   passes on the old model, fails on the new one   a regression: the gate FAILS
//   the new model's request is rejected (a 400)     the gate FAILS; this is the parameter break
//                                                    a type-check cannot see
//   fails on both                                    reported, not blamed on the migration
//   the old model no longer answers                  the new answer is judged on its own
//
// INVARIANT 2 HOLDS. No model judges another: every expectation is a fixed, deterministic test of
// the text. The only model calls are the ones under test, and they are what an eval is.
//
// WHAT IT SENDS: the cases the team wrote, to the provider, with the team's key. Never the
// repository's code. The answers are judged in memory; only pass, fail and which expectation
// failed leave this module, so a public pull request body never carries a model's answer.

export const EVAL_CASES_SCHEMA = 'mendr-eval-cases/v1';
/** Enough to be meaningful, small enough that a run's cost stays obvious. */
export const MAX_CASES = 50;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;

export interface EvalExpect {
  /** Every one of these must appear (case-insensitive). */
  contains?: string[];
  /** None of these may appear (case-insensitive). */
  notContains?: string[];
  /** A regular expression the answer must match. */
  matches?: string;
  /** The answer may be at most this many characters. */
  maxChars?: number;
  /** The answer must parse as JSON. */
  json?: boolean;
}

export interface EvalCase {
  name: string;
  /** The old model this case exercises; absent = every swap in the migration. */
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant' | 'developer'; content: string }[];
  /** Request parameters as the feature sends them to the OLD model (max_tokens, temperature, ...). */
  params?: Record<string, unknown>;
  expect: EvalExpect;
}

/** One swap the cases run against. */
export interface EvalSwap {
  provider: string;
  from: string;
  to: string;
  /** True when the old model's shutdown date has passed: no baseline can be taken. */
  oldRetired?: boolean;
}

export type CaseOutcome = 'passed' | 'failed' | 'rejected' | 'unavailable';

export interface CaseResult {
  name: string;
  from: string;
  to: string;
  old: CaseOutcome;
  new: CaseOutcome;
  /** Why the new answer failed, or what the provider said, in a sentence. No answer text. */
  detail?: string;
}

/** A call to the provider. Injected in tests; `fetch` in production. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface EvalCasesOptions {
  /** The cases file, relative to the repository root or absolute. */
  file: string;
  swaps: readonly EvalSwap[];
  registry: LlmRegistry;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

/** Parse and validate a cases file, with errors that name the field. */
export function parseEvalCases(raw: unknown, source: string): EvalCase[] {
  const example = '{ "cases": [{ "name": "refund window", "messages": [{ "role": "user", "content": "How long do I have to ask for a refund?" }], "expect": { "contains": ["30 days"] } }] }';
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { cases?: unknown }).cases)) {
    throw new Error(`${source} must be an object with a "cases" list, for example ${example}`);
  }
  const list = (raw as { cases: unknown[] }).cases;
  if (list.length === 0) throw new Error(`${source} has no cases; add at least one`);
  if (list.length > MAX_CASES) throw new Error(`${source} has ${list.length} cases; the most a run sends is ${MAX_CASES}, to keep its cost obvious`);
  return list.map((c, i) => {
    const at = `${source}: case ${i + 1}`;
    if (typeof c !== 'object' || c === null) throw new Error(`${at} must be an object`);
    const x = c as Record<string, unknown>;
    if (typeof x.name !== 'string' || !x.name.trim()) throw new Error(`${at} needs a "name"`);
    const name = x.name.trim();
    if (!Array.isArray(x.messages) || x.messages.length === 0) {
      throw new Error(`${at} ("${name}") needs "messages": the request your feature sends, such as [{ "role": "user", "content": "…" }]`);
    }
    for (const m of x.messages as unknown[]) {
      const mm = m as Record<string, unknown>;
      if (!mm || !['system', 'user', 'assistant', 'developer'].includes(mm.role as string) || typeof mm.content !== 'string') {
        throw new Error(`${at} ("${name}"): every message needs a "role" (system, user, assistant or developer) and a text "content"`);
      }
    }
    if (x.model !== undefined && typeof x.model !== 'string') throw new Error(`${at} ("${name}"): "model" must be the old model's id`);
    if (x.params !== undefined && (typeof x.params !== 'object' || x.params === null || Array.isArray(x.params))) {
      throw new Error(`${at} ("${name}"): "params" must be an object, such as { "max_tokens": 300 }`);
    }
    for (const forbidden of ['model', 'messages', 'stream']) {
      if (x.params && forbidden in (x.params as object)) throw new Error(`${at} ("${name}"): "params" may not set "${forbidden}"`);
    }
    const expect = parseExpect(x.expect, `${at} ("${name}")`);
    return {
      name,
      ...(typeof x.model === 'string' ? { model: x.model } : {}),
      messages: x.messages as EvalCase['messages'],
      ...(x.params ? { params: x.params as Record<string, unknown> } : {}),
      expect,
    };
  });
}

function parseExpect(v: unknown, at: string): EvalExpect {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${at} needs "expect": what a good answer must look like, such as { "contains": ["30 days"] }`);
  }
  const e = v as Record<string, unknown>;
  const out: EvalExpect = {};
  for (const [k, val] of Object.entries(e)) {
    if (k === 'contains' || k === 'notContains') {
      if (!Array.isArray(val) || val.some((s) => typeof s !== 'string' || !s)) throw new Error(`${at}: "expect.${k}" must be a list of words or phrases`);
      out[k] = val as string[];
    } else if (k === 'matches') {
      if (typeof val !== 'string') throw new Error(`${at}: "expect.matches" must be a regular expression, written as a string`);
      try {
        new RegExp(val);
      } catch {
        throw new Error(`${at}: "expect.matches" is not a valid regular expression: ${val}`);
      }
      out.matches = val;
    } else if (k === 'maxChars') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) throw new Error(`${at}: "expect.maxChars" must be a whole number, 1 or more`);
      out.maxChars = val;
    } else if (k === 'json') {
      if (typeof val !== 'boolean') throw new Error(`${at}: "expect.json" must be true or false`);
      out.json = val;
    } else {
      throw new Error(`${at}: unknown expectation "${k}" (allowed: contains, notContains, matches, maxChars, json)`);
    }
  }
  if (Object.keys(out).length === 0) throw new Error(`${at}: "expect" is empty, so every answer would pass; add at least one expectation`);
  return out;
}

/** Which expectations an answer misses. Empty = it passes. Deterministic; no model involved. */
export function unmetExpectations(answer: string, expect: EvalExpect): string[] {
  const lower = answer.toLowerCase();
  const out: string[] = [];
  for (const w of expect.contains ?? []) if (!lower.includes(w.toLowerCase())) out.push(`does not contain "${w}"`);
  for (const w of expect.notContains ?? []) if (lower.includes(w.toLowerCase())) out.push(`contains "${w}"`);
  if (expect.matches !== undefined && !new RegExp(expect.matches).test(answer)) out.push(`does not match /${expect.matches}/`);
  if (expect.maxChars !== undefined && answer.length > expect.maxChars) out.push(`is ${answer.length} characters, over ${expect.maxChars}`);
  if (expect.json) {
    try {
      JSON.parse(answer);
    } catch {
      out.push('is not valid JSON');
    }
  }
  return out;
}

/**
 * The request parameters for the NEW model: the registry's parameter rules applied to what the
 * feature sends today (max_tokens renamed, a rejected temperature removed), exactly as the
 * migration would. The old model gets them unchanged.
 */
export function paramsForModel(params: Record<string, unknown> | undefined, model: string, registry: LlmRegistry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(params ?? {}) };
  for (const rule of paramEntries(registry)) {
    if (!(rule.param in out) || !modelMatches(model, rule.on_models)) continue;
    const value = out[rule.param];
    delete out[rule.param];
    if (rule.kind === 'param_rename') out[rule.replacement] = value;
  }
  return out;
}

/** Run the cases file against every swap it covers. Returns the eval gate's result. */
export async function runEvalCases(repoPath: string, opts: EvalCasesOptions): Promise<EvalGateResult> {
  const label = `cases: ${opts.file}`;
  const path = isAbsolute(opts.file) ? opts.file : join(repoPath, opts.file);
  let cases: EvalCase[];
  try {
    cases = parseEvalCases(JSON.parse(readFileSync(path, 'utf8')), opts.file);
  } catch (err) {
    return { status: 'inconclusive', command: label, output: `could not use the cases file: ${err instanceof Error ? err.message : String(err)}` };
  }
  const openai = opts.swaps.filter((s) => s.provider === 'openai');
  if (openai.length === 0) {
    return {
      status: 'skipped',
      command: label,
      output: `the built-in cases run on OpenAI models only; this migration moves ${[...new Set(opts.swaps.map((s) => s.provider))].join(', ')} models. Use an eval command for those.`,
    };
  }
  const key = (opts.env ?? process.env).OPENAI_API_KEY;
  if (!key) {
    return { status: 'inconclusive', command: label, output: 'OPENAI_API_KEY is not set in this environment, so no case could be sent' };
  }
  const doFetch: FetchLike = opts.fetch ?? (fetch as unknown as FetchLike);

  const results: CaseResult[] = [];
  for (const swap of openai) {
    for (const c of cases.filter((x) => !x.model || x.model === swap.from)) {
      const oldRun = swap.oldRetired
        ? ({ outcome: 'unavailable', detail: `${swap.from} has shut down` } as const)
        : await ask(doFetch, key, swap.from, c, c.params);
      const newRun = await ask(doFetch, key, swap.to, c, paramsForModel(c.params, swap.to, opts.registry));
      results.push({
        name: c.name,
        from: swap.from,
        to: swap.to,
        old: oldRun.outcome,
        new: newRun.outcome,
        ...(newRun.detail ? { detail: newRun.detail } : {}),
      });
    }
  }
  if (results.length === 0) {
    return { status: 'not_run', command: label, output: `no case names a model this migration moves (${openai.map((s) => s.from).join(', ')})` };
  }
  return verdictOf(results, label);
}

async function ask(
  doFetch: FetchLike,
  key: string,
  model: string,
  c: EvalCase,
  params: Record<string, unknown> | undefined,
): Promise<{ outcome: CaseOutcome; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(params ?? {}), model, messages: c.messages }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      return { outcome: 'rejected', detail: `${model} rejected the request (${res.status}): ${oneLine(body.error?.message ?? 'no message')}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { outcome: 'unavailable', detail: `${model} could not be reached (HTTP ${res.status})` };
    }
    const answer = body.choices?.[0]?.message?.content ?? '';
    const unmet = unmetExpectations(answer, c.expect);
    return unmet.length === 0 ? { outcome: 'passed' } : { outcome: 'failed', detail: `the ${model} answer ${unmet.join(', ')}` };
  } catch (err) {
    return { outcome: 'unavailable', detail: `${model} could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** The gate's verdict from every case result. Exported for tests. */
export function verdictOf(results: readonly CaseResult[], label: string): EvalGateResult {
  const blame = results.filter((r) => (r.new === 'failed' || r.new === 'rejected') && r.old !== 'failed');
  const alreadyFailing = results.filter((r) => r.new === 'failed' && r.old === 'failed');
  const unreachable = results.filter((r) => r.new === 'unavailable');
  const passed = results.filter((r) => r.new === 'passed');
  const lines = results.map((r) => `${r.name} (${r.from} -> ${r.to}): old ${r.old}, new ${r.new}${r.detail ? ` -- ${r.detail}` : ''}`);
  const summary = `${passed.length} of ${results.length} case run${results.length === 1 ? '' : 's'} passed on the new model`;

  if (blame.length > 0) {
    return { status: 'failed', command: label, output: `${summary}; ${blame.length} got worse with the migration:\n${lines.join('\n')}` };
  }
  if (unreachable.length > 0) {
    return { status: 'inconclusive', command: label, output: `${summary}; ${unreachable.length} could not reach the new model, so nothing can be said about ${unreachable.length === 1 ? 'it' : 'them'}:\n${lines.join('\n')}` };
  }
  if (passed.length === 0) {
    // Nothing passed anywhere: the cases cannot tell a good answer from a bad one yet.
    return { status: 'inconclusive', command: label, output: `${summary}: every case already failed on the old model, so they cannot show whether the migration changed anything:\n${lines.join('\n')}` };
  }
  return {
    status: 'passed',
    command: label,
    output: `${summary}${alreadyFailing.length ? `; ${alreadyFailing.length} already failed on the old model and still fail (not caused by this migration)` : ''}:\n${lines.join('\n')}`,
  };
}

/**
 * The swaps the cases run against, from the sites a migration swaps: one per (old, new) pair, with
 * the old model marked retired once its shutdown date has passed, so no baseline is attempted.
 */
export function evalSwapsOf(
  sites: readonly { deprecation: { provider: string; deprecated: string; replacement: string; shutdownDate?: string | null } }[],
  now: Date,
): EvalSwap[] {
  const today = now.toISOString().slice(0, 10);
  const byPair = new Map<string, EvalSwap>();
  for (const { deprecation: d } of sites) {
    const key = `${d.provider}|${d.deprecated}|${d.replacement}`;
    if (byPair.has(key)) continue;
    const date = d.shutdownDate ? d.shutdownDate.slice(0, 10) : null;
    byPair.set(key, { provider: d.provider, from: d.deprecated, to: d.replacement, oldRetired: date !== null && date <= today });
  }
  return [...byPair.values()];
}
