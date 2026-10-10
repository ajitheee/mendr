import { beforeAll, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, loadLlmRegistry, resolveRegistryPath, withheldVerification } from '../usage/llmRegistry.js';
import { findModelIdLiterals } from '../usage/scanLiterals.js';
import { TS_COUPLED_PARAM_REASON } from '../usage/coupledParams.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { findPyModelIdLiterals, PY_EXAMPLE_CALL_REASON, PY_REQUEST_DICT_REASON } from './scanPy.js';
import { applyPyModelIdFixesToSources } from './fixPy.js';

// THE PYTHON PARAMETER GUARD (src/python/scanPy.ts, "The parameter guard").
//
// Known issue in v0.5.9-alpha: Python had no parameter guard.
//
//     client.chat.completions.create(model="gpt-3.5-turbo", max_tokens=20)
//
// was a Tier A swap to gpt-5.6-terra with `max_tokens` kept, and
//
//     anthropic_client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, temperature=0.7, ...)
//
// a Tier A swap to claude-opus-4-8 with `temperature` kept, although the registry's own parameter
// rules say each replacement rejects that request. TypeScript held the same calls for review. Python
// has no parameter pass either, so nothing edited the request after the swap.
//
// The guard asks the TypeScript question (paramHoldReason) about the call's keyword arguments and
// the keys of a dict unpacked into it, so the two languages give one call the same reason code.

const RENAME = {
  provider: 'openai',
  kind: 'param_rename',
  param: 'max_tokens',
  replacement: 'max_completion_tokens',
  on_models: ['o1', 'o3', 'o4', 'gpt-5', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4'],
} as const;

const removal = (param: string) =>
  ({ provider: 'anthropic', kind: 'param_removal', param, on_models: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'] }) as const;

const model = (provider: string, deprecated: string, replacement: string, verified = true) => ({
  provider,
  kind: 'model_id' as const,
  deprecated,
  replacement,
  status: 'deprecated' as const,
  shutdownDate: '2026-10-23',
  verification: verified ? autoApplyVerification() : withheldVerification('unverified'),
});

const REG: LlmRegistry = [
  model('openai', 'gpt-3.5-turbo', 'gpt-5.6-terra'),
  model('openai', 'gpt-4-0613', 'gpt-4o-mini'),
  model('openai', 'o3-mini', 'gpt-5.6-sol'),
  model('openai', 'gpt-4-0314', 'gpt-5.6-sol', false),
  model('anthropic', 'claude-opus-4-1-20250805', 'claude-opus-4-8'),
  model('anthropic', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'),
  RENAME,
  removal('temperature'),
  removal('top_p'),
  removal('top_k'),
];

const OPENAI = 'from openai import OpenAI\nclient = OpenAI()\n';
const ANTHROPIC = 'from anthropic import Anthropic\nanthropic_client = Anthropic()\n';

/** Scan one Python file and return the verdict for `value`, as audit, watch and fix-llm see it. */
async function py(text: string, value: string, path = 'app/llm.py', registry: LlmRegistry = REG) {
  const m = (await findPyModelIdLiterals([{ path, text }], registry)).find((x) => x.value === value);
  if (!m) return undefined;
  const t = classifyOccurrenceTier(m);
  return { tier: t.tier, reason: t.reason, position: m.position, sentence: m.reason };
}

/** The same verdict from the TypeScript scanner. */
function ts(text: string, value: string, registry: LlmRegistry = REG) {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('src/llm.ts', text);
  const m = findModelIdLiterals(project, registry).find((x) => x.value === value);
  if (!m) return undefined;
  const t = classifyOccurrenceTier(m);
  return { tier: t.tier, reason: t.reason, position: m.position, sentence: m.reason };
}

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
}, 60_000);

describe('the two calls v0.5.9-alpha swapped, against the bundled registry', () => {
  const bundled = loadLlmRegistry(resolveRegistryPath());

  it('gpt-3.5-turbo with max_tokens=20 is held: the rename starts at gpt-5.6-terra', async () => {
    const v = await py(
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
      'app/llm.py',
      bundled,
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change', position: 'surface_capped' });
  }, 60_000);

  it('Claude Opus 4.1 with max_tokens and temperature is held, as TypeScript holds it', async () => {
    const v = await py(
      `${ANTHROPIC}\ndef ask(m):\n    return anthropic_client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, temperature=0.7, messages=m)\n`,
      'claude-opus-4-1-20250805',
      'app/llm.py',
      bundled,
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
  }, 60_000);
});

describe('a call whose keyword arguments the replacement rejects is held', () => {
  it('names a covered rename that starts at the replacement (param_behaviour_change)', async () => {
    const v = await py(
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    expect(v?.sentence).toContain('`max_tokens` becomes `max_completion_tokens`');
  }, 60_000);

  it('names a model-dependent parameter no rule covers (coupled_param_unverified)', async () => {
    const v = await py(
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, temperature=0.7, max_tokens=20)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(v?.sentence).toBe(TS_COUPLED_PARAM_REASON('gpt-5.6-terra', ['temperature']));
  }, 60_000);

  it('holds an Anthropic Opus call whose temperature the replacement drops', async () => {
    const v = await py(
      `${ANTHROPIC}\ndef ask(m):\n    return anthropic_client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, temperature=0.7, messages=m)\n`,
      'claude-opus-4-1-20250805',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    // max_tokens is model-dependent and no Anthropic rule covers it, so it is named first, as in TypeScript.
    expect(v?.sentence).toContain('`max_tokens`');
  }, 60_000);

  it('holds the call through an `or` fallback in the model argument', async () => {
    const v = await py(
      `${OPENAI}\ndef title(p, m=None):\n    return client.chat.completions.create(model=m or "gpt-3.5-turbo", messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
    );
    expect(v?.sentence).toBeDefined();
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
  }, 60_000);
});

describe('a dict unpacked into the call with **name is read', () => {
  it('a dict built in the same function', async () => {
    const v = await py(
      `${OPENAI}\ndef title(p):\n    params = {"max_tokens": 20, "stream": False}\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
  }, 60_000);

  it('a module-level dict the function does not rebind', async () => {
    const v = await py(
      `${OPENAI}\nDEFAULTS = {"temperature": 0.2}\n\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **DEFAULTS)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(v?.sentence).toContain('`temperature`');
  }, 60_000);

  it('a dict(...) call, and keys added later with a subscript or .update()', async () => {
    const built = await py(
      `${OPENAI}\ndef title(p):\n    params = dict(max_tokens=20)\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(built?.sentence).toContain('`max_tokens` becomes');
    const subscript = await py(
      `${OPENAI}\ndef title(p, limit):\n    params = {}\n    if limit:\n        params["max_tokens"] = limit\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(subscript).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    const updated = await py(
      `${OPENAI}\ndef title(p):\n    params = {"stream": False}\n    params.update(top_p=0.9)\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(updated).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(updated?.sentence).toContain('`top_p`');
  }, 60_000);

  it('a **{...} or **dict(...) written in the call', async () => {
    const inline = await py(
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **{"max_tokens": 5})\n`,
      'gpt-3.5-turbo',
    );
    expect(inline).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    const call = await py(
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **dict(temperature=0))\n`,
      'gpt-3.5-turbo',
    );
    expect(call).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
  }, 60_000);

  it('a dict built from another dict (`{**base, ...}`) and one that refers to itself', async () => {
    const v = await py(
      `${OPENAI}\nBASE = {"max_tokens": 20}\n\ndef title(p):\n    params = {**BASE, "stream": False}\n    params = {**params, "user": "u"}\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
  }, 60_000);
});

describe('a model bound to a name the scanner traces into the call', () => {
  it('a module constant passed as model=MODEL; the reason says where the call is', async () => {
    const v = await py(
      `${OPENAI}MODEL = "gpt-3.5-turbo"\n\ndef title(p):\n    return client.chat.completions.create(model=MODEL, messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    expect(v?.sentence).toMatch(/^the call on line 6 of this file takes this value as its model; moving from gpt-3\.5-turbo/);
  }, 60_000);

  it('an instance attribute set in __init__ and used in another method', async () => {
    const v = await py(
      `${ANTHROPIC}\nclass Bot:\n    def __init__(self):\n        self.model = "claude-opus-4-1-20250805"\n\n    def ask(self, m):\n        return anthropic_client.messages.create(model=self.model, max_tokens=256, messages=m)\n`,
      'claude-opus-4-1-20250805',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'coupled_param_unverified' });
    expect(v?.sentence).toContain('the call on line 9 of this file');
  }, 60_000);

  it('a parameter default passed on as model=model', async () => {
    const v = await py(
      `${OPENAI}\ndef ask(p, model="gpt-3.5-turbo"):\n    return client.chat.completions.create(model=model, messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    expect(v?.sentence).toContain('the call on line 5 of this file');
  }, 60_000);

  it('a constant whose call passes no model-dependent parameter stays Tier A', async () => {
    const v = await py(
      `${OPENAI}MODEL = "gpt-3.5-turbo"\n\ndef title(p):\n    return client.chat.completions.create(model=MODEL, messages=p, stream=True)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A', position: 'model_arg' });
  }, 60_000);
});

describe('calls the guard leaves alone', () => {
  it('a Python Anthropic call whose replacement is in no rule\'s family stays Tier A', async () => {
    // claude-sonnet-4-6 matches no param rule's on_models, so nothing about it is known to be
    // constrained: `max_tokens` and `temperature` are ordinary arguments.
    const v = await py(
      `${ANTHROPIC}\ndef ask(m):\n    return anthropic_client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=1024, temperature=0.7, messages=m)\n`,
      'claude-3-5-sonnet-20241022',
    );
    expect(v).toMatchObject({ tier: 'A', position: 'model_arg' });
  }, 60_000);

  it('the same, against the bundled registry', async () => {
    const v = await py(
      `${ANTHROPIC}\ndef ask(m):\n    return anthropic_client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=1024, temperature=0.7, messages=m)\n`,
      'claude-3-5-sonnet-20241022',
      'app/llm.py',
      loadLlmRegistry(resolveRegistryPath()),
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('an OpenAI replacement whose family no rule constrains keeps temperature and stays Tier A', async () => {
    const v = await py(
      `${OPENAI}\ndef ask(p):\n    return client.chat.completions.create(model="gpt-4-0613", messages=p, temperature=0.7, max_tokens=20)\n`,
      'gpt-4-0613',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a call with no model-dependent parameter stays Tier A', async () => {
    const v = await py(
      `${OPENAI}\ndef ask(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, stream=True, user="u", timeout=30)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a rule the old model was already under stays Tier A, as in TypeScript', async () => {
    const v = await py(
      `${OPENAI}\ndef ask(p):\n    return client.chat.completions.create(model="o3-mini", messages=p, max_tokens=500)\n`,
      'o3-mini',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('**kwargs from a function parameter adds nothing: mendr cannot see its keys', async () => {
    const v = await py(
      `${OPENAI}\nparams = {"max_tokens": 20}\n\ndef ask(p, **params):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A' });
    const named = await py(
      `${OPENAI}\nparams = {"max_tokens": 20}\n\ndef ask(p, params):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(named).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a same-named dict in another function is not the one unpacked', async () => {
    const v = await py(
      `${OPENAI}\ndef card():\n    params = {"max_tokens": 20}\n    return params\n\ndef ask(p):\n    params = {"stream": False}\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a module dict shadowed by a local one is not read', async () => {
    const v = await py(
      `${OPENAI}\nparams = {"max_tokens": 20}\n\ndef ask(p):\n    params = {"stream": False}\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a parameter in another call nearby is not this call\'s parameter', async () => {
    const v = await py(
      `${OPENAI}\ndef ask(p):\n    other = client.chat.completions.create(model="gpt-4o", messages=p, max_tokens=5)\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'A' });
  }, 60_000);

  it('a parameter-shaped key in a catalog dict changes nothing: the guard only reads live calls', async () => {
    const v = await py(
      `${OPENAI}\nMODELS = {"gpt-3.5-turbo": {"max_tokens": 4096, "label": "GPT-3.5"}}\n`,
      'gpt-3.5-turbo',
    );
    expect(v).toMatchObject({ tier: 'C' });
  }, 60_000);

  it('a call held for its surface keeps its own reason', async () => {
    // An example tree and a request dict are held already; the parameter guard does not relabel them.
    const sample = await py(
      `${OPENAI}\ndef ask(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n`,
      'gpt-3.5-turbo',
      'examples/ask.py',
    );
    expect(sample).toMatchObject({ tier: 'B', reason: 'surface_capped', sentence: PY_EXAMPLE_CALL_REASON });
    const dict = await py(
      `${OPENAI}\ndef ask(p):\n    params = {"model": "gpt-3.5-turbo", "max_tokens": 20}\n    return client.chat.completions.create(messages=p, **params)\n`,
      'gpt-3.5-turbo',
    );
    expect(dict).toMatchObject({ tier: 'B', reason: 'surface_capped', sentence: PY_REQUEST_DICT_REASON });
  }, 60_000);
});

describe('an unverified replacement with a parameter the guard holds', () => {
  it('carries the parameter reason, as TypeScript gives it', async () => {
    const pyV = await py(
      `${OPENAI}\ndef ask(p):\n    return client.chat.completions.create(model="gpt-4-0314", messages=p, max_tokens=20)\n`,
      'gpt-4-0314',
    );
    const tsV = ts(
      "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const ask = (p: never[]) => client.chat.completions.create({ model: 'gpt-4-0314', messages: p, max_tokens: 20 });\n",
      'gpt-4-0314',
    );
    expect(pyV).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
    expect(tsV).toMatchObject({ tier: 'B', reason: 'param_behaviour_change' });
  }, 60_000);
});

describe('TypeScript and Python give one call the same verdict', () => {
  const TS_OPENAI = "import OpenAI from 'openai';\nconst client = new OpenAI();\n";
  const TS_ANTHROPIC = "import Anthropic from '@anthropic-ai/sdk';\nconst anthropic_client = new Anthropic();\n";
  const cases: Array<{ name: string; value: string; py: string; ts: string }> = [
    {
      name: 'gpt-3.5-turbo + max_tokens',
      value: 'gpt-3.5-turbo',
      py: `${OPENAI}\ndef t(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n`,
      ts: `${TS_OPENAI}export const t = (p: never[]) => client.chat.completions.create({ model: 'gpt-3.5-turbo', messages: p, max_tokens: 20 });\n`,
    },
    {
      name: 'gpt-3.5-turbo + temperature + max_tokens',
      value: 'gpt-3.5-turbo',
      py: `${OPENAI}\ndef t(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, temperature=0.7, max_tokens=20)\n`,
      ts: `${TS_OPENAI}export const t = (p: never[]) => client.chat.completions.create({ model: 'gpt-3.5-turbo', messages: p, temperature: 0.7, max_tokens: 20 });\n`,
    },
    {
      name: 'Opus 4.1 + max_tokens + temperature',
      value: 'claude-opus-4-1-20250805',
      py: `${ANTHROPIC}\ndef t(m):\n    return anthropic_client.messages.create(model="claude-opus-4-1-20250805", max_tokens=1024, temperature=0.7, messages=m)\n`,
      ts: `${TS_ANTHROPIC}export const t = (m: never[]) => anthropic_client.messages.create({ model: 'claude-opus-4-1-20250805', max_tokens: 1024, temperature: 0.7, messages: m });\n`,
    },
    {
      name: 'Sonnet 3.5 + max_tokens + temperature',
      value: 'claude-3-5-sonnet-20241022',
      py: `${ANTHROPIC}\ndef t(m):\n    return anthropic_client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=1024, temperature=0.7, messages=m)\n`,
      ts: `${TS_ANTHROPIC}export const t = (m: never[]) => anthropic_client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, temperature: 0.7, messages: m });\n`,
    },
    {
      name: 'o3-mini + max_tokens',
      value: 'o3-mini',
      py: `${OPENAI}\ndef t(p):\n    return client.chat.completions.create(model="o3-mini", messages=p, max_tokens=500)\n`,
      ts: `${TS_OPENAI}export const t = (p: never[]) => client.chat.completions.create({ model: 'o3-mini', messages: p, max_tokens: 500 });\n`,
    },
    {
      name: 'gpt-3.5-turbo, no parameters',
      value: 'gpt-3.5-turbo',
      py: `${OPENAI}\ndef t(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)\n`,
      ts: `${TS_OPENAI}export const t = (p: never[]) => client.chat.completions.create({ model: 'gpt-3.5-turbo', messages: p });\n`,
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const pyV = await py(c.py, c.value);
      const tsV = ts(c.ts, c.value);
      expect(pyV).toBeDefined();
      expect(tsV).toBeDefined();
      // Tier, reason code, position and the very sentence: one rule, asked once, in both languages.
      expect(pyV).toEqual(tsV);
    }, 60_000);
  }
});

describe('each function\'s own `params` is the one read', () => {
  // The name index is keyed by scope: a file where every function binds `params` reads each
  // function's own dict, never a neighbour's.
  it('holds only the calls whose own dict carries the parameter', async () => {
    const lines = [OPENAI];
    for (let i = 0; i < 40; i++) {
      const param = i % 2 === 0 ? `"max_tokens": ${i}` : `"stream": False`;
      lines.push(`def f${i}(p):\n    params = {${param}}\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, **params)\n`);
    }
    const matches = await findPyModelIdLiterals([{ path: 'app/many.py', text: lines.join('\n') }], REG);
    expect(matches).toHaveLength(40);
    const held = matches.filter((m) => classifyOccurrenceTier(m).tier === 'B');
    expect(held).toHaveLength(20);
    expect(held.every((m) => classifyOccurrenceTier(m).reason === 'param_behaviour_change')).toBe(true);
  }, 60_000);
});

describe('fix-llm and migrate do not swap a held Python call', () => {
  it('leaves the held call out of the diff and lists it as held, while a clean call is still swapped', async () => {
    const text =
      `${OPENAI}\ndef title(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p, max_tokens=20)\n\n` +
      `def plain(p):\n    return client.chat.completions.create(model="gpt-3.5-turbo", messages=p)\n`;
    const result = await applyPyModelIdFixesToSources([{ path: 'app/llm.py', text }], REG);
    expect(result.siteCount).toBe(1);
    expect(result.diff).toContain('+    return client.chat.completions.create(model="gpt-5.6-terra", messages=p)');
    expect(result.diff).not.toContain('model="gpt-5.6-terra", messages=p, max_tokens=20');
    expect(result.heldMatches.map((m) => [m.location.line, classifyOccurrenceTier(m).reason])).toEqual([
      [5, 'param_behaviour_change'],
    ]);
    expect(result.blockedMatches).toEqual([]);
    expect(result.usageUnverifiedMatches).toEqual([]);
  }, 60_000);
});
