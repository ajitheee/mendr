import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals, PY_REQUEST_DICT_REASON } from './scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';

// THE PYTHON TWIN of the request object built in a variable (src/usage/requestObjectFlow.test.ts):
//
//     params = {"model": "gpt-4", "messages": [...]}
//     client.chat.completions.create(**params)
//
// was filed as a catalog value, Tier C, the same false clean the TypeScript scanner gave a Node
// server on 2026-10-09. It is now reported, held at review (never an unattended swap: the call may
// add or override keys the dict does not show). Fixtures written for this suite.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

async function verdict(text: string, path = 'app/llm.py') {
  const m = (await findPyModelIdLiterals([{ path, text }], REG)).find((x) => x.value === 'gpt-4');
  if (!m) return undefined;
  return { ...classifyOccurrenceTier(m), position: m.position, reason: m.reason, purpose: m.purpose };
}

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
}, 60_000);

const CLIENT = 'from openai import OpenAI\nclient = OpenAI()\n';

describe('a request dict built in a variable and unpacked into a provider request', () => {
  it('is reported and held, not filed as catalog data', async () => {
    const v = await verdict(
      `${CLIENT}\ndef ask(prompt):\n    params = {"model": "gpt-4", "messages": [{"role": "user", "content": prompt}]}\n    return client.chat.completions.create(**params, stream=False)\n`,
    );
    expect(v?.tier).toBe('B');
    expect(v?.position).toBe('surface_capped');
    expect(v?.reason).toBe(PY_REQUEST_DICT_REASON);
  }, 60_000);

  it('follows a module-level dict into a request inside a function', async () => {
    const v = await verdict(`${CLIENT}\nREQUEST = {"model": "gpt-4", "temperature": 0}\n\ndef ask(m):\n    return client.chat.completions.create(**REQUEST, messages=m)\n`);
    expect(v?.tier).toBe('B');
    expect(v?.reason).toBe(PY_REQUEST_DICT_REASON);
  }, 60_000);

  it('follows the dict into a LangChain factory too, still held', async () => {
    const v = await verdict('from langchain_openai import ChatOpenAI\n\ndef build():\n    cfg = {"model": "gpt-4", "temperature": 0}\n    return ChatOpenAI(**cfg)\n');
    expect(v?.tier).toBe('B');
  }, 60_000);
});

describe('following a dict stays linear in the size of the file', () => {
  // Walking the tree once per matched literal took 60 s for 800 module-level dicts beside 4,000
  // functions, against 1.1 s without the rule. The same file here, with a budget far from both.
  it('classifies hundreds of module-level model dicts in one large file within budget', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 800; i++) lines.push(`CARD_${i} = {"model": "gpt-4", "tag": "t${i}"}`);
    for (let i = 0; i < 4000; i++) lines.push(`def f${i}(a, **kw):\n    return g(a, **kw) + CARD_${i % 800}["tag"]`);
    const started = performance.now();
    const matches = await findPyModelIdLiterals([{ path: 'app/cards.py', text: lines.join('\n') }], REG);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(matches).toHaveLength(800);
    expect(matches.every((m) => m.position === 'data')).toBe(true);
  }, 120_000);
});

describe('a dict that never reaches a provider request stays data', () => {
  it('a dict nothing unpacks', async () => {
    const v = await verdict(`${CLIENT}\ndef card():\n    entry = {"model": "gpt-4", "label": "GPT-4"}\n    return entry["label"]\n`);
    expect(v?.tier).toBe('C');
  }, 60_000);

  it('a dict unpacked into something that is not a provider request', async () => {
    const v = await verdict(`${CLIENT}\ndef record(event):\n    payload = {"model": "gpt-4", "event": event}\n    return log_event(**payload)\n`);
    expect(v?.tier).toBe('C');
  }, 60_000);

  it('a same-named dict in another function is not the one that is sent', async () => {
    const v = await verdict(
      `${CLIENT}\ndef card():\n    params = {"model": "gpt-4", "label": "GPT-4"}\n    return params\n\ndef ask(params):\n    return client.chat.completions.create(**params)\n`,
    );
    expect(v?.tier).toBe('C');
  }, 60_000);

  it('a model-picker list and a docstring', async () => {
    const list = await verdict(`${CLIENT}\nMODELS = ["gpt-4", "gpt-4o"]\n\ndef ask(m, params):\n    return client.chat.completions.create(**params)\n`);
    expect(list?.tier).toBe('C');
    expect(list?.purpose).toBe('list_entry');
    const doc = await verdict(`${CLIENT}\ndef ask(params):\n    """gpt-4"""\n    return client.chat.completions.create(**params)\n`);
    expect(doc?.tier).toBe('C');
  }, 60_000);
});
