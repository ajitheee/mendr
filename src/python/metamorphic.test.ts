import { describe, expect, it, beforeAll } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals } from './scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { foldExposure, renderedLocations, MAX_LOCATIONS_PER_MODEL } from '../watch/exposure.js';

// METAMORPHIC PROPERTIES of the Tier-A decision path.
//
// Unit tests pin individual verdicts; these pin RELATIONSHIPS between verdicts,
// which is where the real bugs lived. Each property below corresponds to a defect
// that actually shipped:
//   * inline vs traced      — hoisting a literal into a variable bypassed every cap
//   * source order          — a verdict must not depend on where the sink is written
//   * location count        — a 50-location cap erased lower-tier occurrences
//   * ambiguous siblings    — adding uncertainty must never RAISE authority

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

async function tierOf(text: string, path = 'app.py'): Promise<string | undefined> {
  const ms = await findPyModelIdLiterals([{ path, text }], REG);
  const hit = ms.find((m) => m.value === 'gpt-4');
  if (!hit) return undefined;
  return classifyOccurrenceTier({ position: hit.position, deprecation: hit.deprecation, reason: hit.reason }).tier;
}

const PRELUDE = 'from openai import OpenAI\nclient = OpenAI()\n';

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
}, 60_000);

describe('metamorphic: INLINE and TRACED forms must agree', () => {
  // The same call, written two ways. A guard that only inspects the literal's own
  // enclosing call gives different answers — that was the largest hole found.
  const cases: Array<{ name: string; sink: string; want: string }> = [
    { name: 'direct chat (eligible)', sink: 'client.chat.completions.create(model=%M%, messages=[])', want: 'A' },
    { name: 'embeddings (endpoint capped)', sink: 'client.embeddings.create(model=%M%, input="x")', want: 'B' },
    { name: 'unrecognized callee', sink: 'gateway.dispatch(model=%M%)', want: 'B' },
  ];

  for (const c of cases) {
    it(`${c.name}: inline === traced`, async () => {
      const inline = `${PRELUDE}\ndef ask():\n    return ${c.sink.replace('%M%', '"gpt-4"')}\n`;
      const traced = `${PRELUDE}MODEL = "gpt-4"\n\ndef ask():\n    return ${c.sink.replace('%M%', 'MODEL')}\n`;
      const a = await tierOf(inline);
      const b = await tierOf(traced);
      expect(a, 'inline form').toBe(c.want);
      expect(b, 'traced form').toBe(c.want);
      expect(a).toBe(b);
    }, 60_000);
  }
});

describe('metamorphic: SOURCE ORDER must not change the verdict', () => {
  it('declaration before use === use before declaration', async () => {
    const declFirst = `${PRELUDE}MODEL = "gpt-4"\n\ndef ask():\n    return client.chat.completions.create(model=MODEL, messages=[])\n`;
    const useFirst = `${PRELUDE}\ndef ask():\n    return client.chat.completions.create(model=MODEL, messages=[])\n\nMODEL = "gpt-4"\n`;
    expect(await tierOf(declFirst)).toBe(await tierOf(useFirst));
  }, 60_000);

  it('a capped sibling caps regardless of which call is written first', async () => {
    const chatFirst = `${PRELUDE}MODEL = "gpt-4"\n\ndef a():\n    return client.chat.completions.create(model=MODEL, messages=[])\n\ndef b():\n    return client.embeddings.create(model=MODEL, input="x")\n`;
    const embedFirst = `${PRELUDE}MODEL = "gpt-4"\n\ndef b():\n    return client.embeddings.create(model=MODEL, input="x")\n\ndef a():\n    return client.chat.completions.create(model=MODEL, messages=[])\n`;
    expect(await tierOf(chatFirst)).toBe('B');
    expect(await tierOf(embedFirst)).toBe('B');
  }, 60_000);
});

describe('metamorphic: adding an AMBIGUOUS sibling never raises authority', () => {
  const base = `${PRELUDE}MODEL = "gpt-4"\n\ndef ask():\n    return client.chat.completions.create(model=MODEL, messages=[])\n`;
  const RANK: Record<string, number> = { A: 3, B: 2, C: 1 };

  const siblings: Array<{ name: string; code: string }> = [
    { name: 'an embeddings call', code: '\ndef more():\n    return client.embeddings.create(model=MODEL, input="x")\n' },
    { name: 'an unrecognized wrapper', code: '\ndef more(g):\n    return g.dispatch(model=MODEL)\n' },
    { name: 'a legacy SDK call', code: '\nimport openai\n\ndef more():\n    return openai.ChatCompletion.create(model=MODEL, messages=[])\n' },
  ];

  it('the base case is Tier A', async () => {
    expect(await tierOf(base)).toBe('A');
  }, 60_000);

  for (const s of siblings) {
    it(`adding ${s.name} does not raise the tier`, async () => {
      const withSibling = base + s.code;
      const before = RANK[(await tierOf(base)) ?? 'C'];
      const after = RANK[(await tierOf(withSibling)) ?? 'C'];
      expect(after, 'authority must not increase').toBeLessThanOrEqual(before);
    }, 60_000);
  }
});

describe('metamorphic: LOCATION COUNT must not change classification', () => {
  const dep = REG[0] as never;
  const occ = (file: string, line: number, tier: string) =>
    ({ value: 'gpt-4', entry: dep, file, line, column: 1, tier, usageVerdict: 'verified' } as never);

  it('a lower-tier occurrence survives however many siblings precede it', () => {
    for (const bulk of [1, 10, MAX_LOCATIONS_PER_MODEL, MAX_LOCATIONS_PER_MODEL * 3]) {
      const ms = [];
      for (let i = 0; i < bulk; i++) ms.push(occ('app/bulk.py', i + 1, 'A'));
      ms.push(occ('app/zzz_last.py', 5, 'B'));
      const [model] = foldExposure(ms as never);
      // Classification sees the COMPLETE set…
      expect(model.occurrences, `bulk=${bulk}`).toBe(bulk + 1);
      expect(model.tierCounts.B, `bulk=${bulk}`).toBe(1);
      expect(
        model.locations.some((l) => l.file === 'app/zzz_last.py'),
        `bulk=${bulk}: the Tier-B location must remain in the DATA`,
      ).toBe(true);
    }
  });

  it('the cap applies to PRESENTATION only, and never hides a whole tier', () => {
    const ms = [];
    for (let i = 0; i < 200; i++) ms.push(occ('app/bulk.py', i + 1, 'A'));
    ms.push(occ('app/zzz_last.py', 5, 'B'));
    ms.push(occ('app/doc.py', 9, 'C'));
    const [model] = foldExposure(ms as never);
    const shown = renderedLocations(model);
    expect(shown.length).toBeLessThanOrEqual(MAX_LOCATIONS_PER_MODEL);
    // Every tier present in the data is still visible to a reader.
    for (const tier of ['A', 'B', 'C']) {
      expect(shown.some((l) => l.tier === tier), `tier ${tier} must still be shown`).toBe(true);
    }
  });
});
