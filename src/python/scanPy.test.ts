import { describe, it, expect } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { USAGE_UNVERIFIED_REASON } from '../usage/scanLiterals.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals, scanPyAnnotations, type PySource } from './scanPy.js';
import { applyPyModelIdFixesToSources } from './fixPy.js';

// Hermetic Python-mode tests, mirroring the TS call-site suite in
// fix/modelId.test.ts: sources are inline strings, the registry is an inline
// literal, and everything runs in-memory (the tree-sitter WASM grammar is the
// only on-disk dependency, resolved from the repo's own wasm/ directory).

/** Covers exactly the ids referenced by the sources below. `o1-mini` is left
 * UNVERIFIED so the suite exercises the engine gate; the rest are stamped
 * `verified` to isolate call-site behavior from the verification gate. */
const REGISTRY: LlmRegistry = [
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4-vision-preview',
    replacement: 'gpt-4o',
    note: 'vision-preview folded into gpt-4o',
    verification: autoApplyVerification(),
  },
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
    status: 'retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'Claude 3 Opus retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-5-sonnet-20241022',
    replacement: 'claude-sonnet-4-5',
    note: 'Claude 3.5 Sonnet v2 retired',
    verification: autoApplyVerification(),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1-mini',
    replacement: 'o4-mini',
    note: 'o1-mini deprecated',
    verification: withheldVerification('unverified'),
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'gpt-4',
    replacement: 'gpt-5.6-sol',
    note: 'gpt-4 shutting down',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    verification: autoApplyVerification(),
  },
];

/**
 * One file exercising every classification rule at once, so a single codemod
 * run must get every position right — the same all-in-one shape as the TS
 * CALL_SITE_SOURCE.
 */
const CALL_SITE_SOURCE = `
import google.generativeai as genai

# MUST SWAP (a): a model kwarg on a RESOLVED first-party client. The client must
# be constructed in-file — an injected/unresolved receiver caps at Tier B (G4).
from openai import OpenAI
oai = OpenAI()

def vision():
    return oai.chat.completions.create(model="gpt-4-vision-preview")

# MUST SWAP (c): assignment to a model-named constant, traced to the sink below.
MODEL_NAME = "gemini-2.0-flash"

def default_call():
    return oai.chat.completions.create(model=MODEL_NAME)

# MUST SWAP (d): direct string argument to a known model factory.
g_model = genai.GenerativeModel("gemini-2.0-flash")

# NO LONGER A SWAP (b): a dict passed to an UNRECOGNIZED callee. client.post
# is not a provider SDK sink, so this is real but capped at review (G2).
def ask(client):
    return client.post("/v1/chat", json={"model": "gpt-4-vision-preview"})

# MUST NOT SWAP: standalone dict value (catalog shape, never seen in a call).
CONFIG = {"model": "claude-3-opus-20240229"}

# MUST NOT SWAP: dict KEY of a pricing table (duplicate-key corruption risk).
PRICES = {"claude-3-5-sonnet-20241022": {"price": 3}}

# MUST NOT SWAP: list element of a model picker.
CHOICES = ["o1-mini", "gpt-4o"]

# MUST NOT SWAP: comparison operands (== and in).
def is_legacy(m):
    return m == "claude-3-opus-20240229" or m in ("o1-mini",)

# DECOY: longer value, exact-match guard means no match at all.
notes = "gemini-2.0-flash-notes"
# gemini-2.0-flash appears in this comment and MUST stay untouched
`.trimStart();

function src(path: string, text: string): PySource {
  return { path, text };
}

describe('python call-site awareness: swap live model arguments, skip data', () => {
  it('SWAPS the four genuine model-argument positions', async () => {
    const sources = [src('app/llm.py', CALL_SITE_SOURCE)];
    const result = await applyPyModelIdFixesToSources(sources, REGISTRY);
    const text = result.patchedFiles[0]!.newText;

    // (a) model= keyword argument.
    expect(text).toContain('create(model="gpt-4o")');
    // (c) model-named constant.
    expect(text).toContain('MODEL_NAME = "gemini-flash-latest"');
    // (b) GUARD G2: the dict goes to client.post, which is NOT a recognized
    // provider SDK sink. Real, but capped at review — so it stays untouched.
    expect(text).toContain('json={"model": "gpt-4-vision-preview"}');

    // (d) GUARD G1: the model-factory call here sits at MODULE LEVEL, so it runs
    // at import. That makes it REAL — but a genuine request executed at import is
    // capped at review (Tier B), never an unattended swap. It stays untouched.
    expect(text).toContain('genai.GenerativeModel("gemini-2.0-flash")');

    expect(result.siteCount).toBe(2);
    expect(result.changedFiles).toEqual(['app/llm.py']);
    expect(result.syntaxGate.passed).toBe(true);
  });

  it('LEAVES every data position byte-identical (dict key/value, list, comparison)', async () => {
    const sources = [src('app/llm.py', CALL_SITE_SOURCE)];
    const result = await applyPyModelIdFixesToSources(sources, REGISTRY);
    const text = result.patchedFiles[0]!.newText;

    // Standalone dict value: untouched (catalog-corruption guard).
    expect(text).toContain('CONFIG = {"model": "claude-3-opus-20240229"}');
    expect(text).not.toContain('claude-opus-4-8');
    // Pricing-table KEY: untouched.
    expect(text).toContain('"claude-3-5-sonnet-20241022": {"price": 3}');
    expect(text).not.toContain('claude-sonnet-4-5');
    // Model-picker list element: untouched.
    expect(text).toContain('CHOICES = ["o1-mini", "gpt-4o"]');
    // Comparison operands: untouched.
    expect(text).toContain('m == "claude-3-opus-20240229"');
    expect(text).toContain('m in ("o1-mini",)');
    // Decoy longer literal + comment line: untouched.
    expect(text).toContain('notes = "gemini-2.0-flash-notes"');
    expect(text).toContain('# gemini-2.0-flash appears in this comment');
  });

  it('SURFACES the rejected-but-matched ids as Tier C locate-only data', async () => {
    const sources = [src('app/llm.py', CALL_SITE_SOURCE)];
    const result = await applyPyModelIdFixesToSources(sources, REGISTRY);

    // Four data positions: pricing key, list element, == operand, in-tuple
    // element. (The `CONFIG = {"model": …}` dict is a DEFAULT-configuration
    // container — a review candidate since the 2026-09-04 partner audits, so it
    // is no longer a data match.)
    expect(result.dataMatches).toHaveLength(4);
    const values = result.dataMatches.map((d) => d.value).sort();
    expect(values).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'o1-mini',
      'o1-mini',
    ]);
    for (const d of result.dataMatches) {
      expect(d.replacement).toBeTruthy();
      expect(d.location.line).toBeGreaterThan(0);
    }
  });

  it('locator tags each match with its classified position', async () => {
    const matches = await findPyModelIdLiterals([src('app/llm.py', CALL_SITE_SOURCE)], REGISTRY);

    const swaps = matches.filter((m) => m.position === 'model_arg');
    const data = matches.filter((m) => m.position === 'data');
    const capped = matches.filter((m) => m.position === 'surface_capped');
    const unverified = matches.filter((m) => m.position === 'usage_unverified');
    // Two swap-eligible positions remain. The module-level model factory is
    // demoted by G1 (real at import, review-only), and the dict passed to
    // client.post by G2 (unrecognized sink) — both `surface_capped`. The
    // `CONFIG = {"model": …}` default-configuration dict is a review candidate.
    expect(swaps).toHaveLength(2);
    expect(capped).toHaveLength(2);
    expect(unverified).toHaveLength(1);
    expect(data).toHaveLength(4);
  });

  it('tags each data match with a purpose (mirrors the TS purpose labels)', async () => {
    const matches = await findPyModelIdLiterals([src('app/llm.py', CALL_SITE_SOURCE)], REGISTRY);
    const data = matches.filter((m) => m.position === 'data');
    const byPurpose = (p: string) => data.filter((m) => m.purpose === p).map((m) => m.value);

    // The standalone `CONFIG = {"model": …}` dict is a default-configuration
    // container (review candidate), so no catalog_entry data remains here.
    expect(byPurpose('catalog_entry')).toEqual([]);
    // Pricing-table key -> lookup key.
    expect(byPurpose('lookup_key')).toEqual(['claude-3-5-sonnet-20241022']);
    // Model-picker list element -> list entry.
    expect(byPurpose('list_entry')).toEqual(['o1-mini']);
    // `==` operand AND the `in ("…",)` tuple element both gate runtime logic.
    expect(byPurpose('comparison').sort()).toEqual(['claude-3-opus-20240229', 'o1-mini']);
  });
});

describe('python engine gate: unverified replacements are BLOCKED, never swapped', () => {
  it('surfaces an unverified id in a live model-arg position as blocked', async () => {
    // The sink usage makes the assignment a LIVE model arg — only the entry's
    // unverified replacement blocks it (isolating the verification gate).
    // The client must be CONSTRUCTED and the call must sit inside a function:
    // an injected receiver, or a request at module level, caps at Tier B (G1/G4)
    // and would mask the verification gate this test is isolating.
    const source =
      'from openai import OpenAI\noai = OpenAI()\nSMALL_MODEL = "o1-mini"\n' +
      'def go():\n    return oai.chat.completions.create(model=SMALL_MODEL)\n';
    const result = await applyPyModelIdFixesToSources([src('app/pick.py', source)], REGISTRY);

    // o1-mini is model_arg here, but its entry is `unverified` — no swap.
    expect(result.siteCount).toBe(0);
    expect(result.patchedFiles).toHaveLength(0);
    expect(result.blockedMatches).toHaveLength(1);
    expect(result.blockedMatches[0]).toMatchObject({
      value: 'o1-mini',
      replacement: 'o4-mini',
      status: 'unverified',
    });
  });
});

describe('python azure deployment keys: dedicated locate surface, never a swap', () => {
  it('does NOT swap deployment keywords/assignments; routes them to the azure surface', async () => {
    const source = [
      'client = AzureOpenAI(deployment_name="gpt-4-vision-preview")',
      'resp = client.post("/v1", json={"deployment": "gemini-2.0-flash"})',
      'deployment = "gpt-4-vision-preview"',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/azure.py', source)], REGISTRY);

    // Nothing swapped: a deployment name is an alias for a provisioned
    // deployment, not a model id — the fix is provisioning, not a codemod.
    expect(result.siteCount).toBe(0);
    expect(result.patchedFiles).toHaveLength(0);
    expect(result.azureMatches).toHaveLength(3);
    expect(result.azureMatches.map((a) => a.value).sort()).toEqual([
      'gemini-2.0-flash',
      'gpt-4-vision-preview',
      'gpt-4-vision-preview',
    ]);
    // Not double-reported on the data or blocked surfaces.
    expect(result.dataMatches).toHaveLength(0);
    expect(result.blockedMatches).toHaveLength(0);
  });
});

describe('python quote + prefix discipline', () => {
  it('preserves single/double/triple quote style (content-only splice)', async () => {
    const source = [
      'from openai import OpenAI',
      'oai = OpenAI()',
      "model_single = 'gemini-2.0-flash'",
      'model_double = "gemini-2.0-flash"',
      'model_triple = """gemini-2.0-flash"""',
      'def go():',
      '    return oai.chat.completions.create(model=model_single)',
      'def go():',
      '    return oai.chat.completions.create(model=model_double)',
      'def go():',
      '    return oai.chat.completions.create(model=model_triple)',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/quotes.py', source)], REGISTRY);
    const text = result.patchedFiles[0]!.newText;

    expect(text).toContain("model_single = 'gemini-flash-latest'");
    expect(text).toContain('model_double = "gemini-flash-latest"');
    expect(text).toContain('model_triple = """gemini-flash-latest"""');
    expect(result.siteCount).toBe(3);
    expect(result.syntaxGate.passed).toBe(true);
  });

  it('skips f-strings entirely (not swapped, not even matched as data)', async () => {
    // The name is model-like and the content equals a deprecated id exactly —
    // only the f prefix disqualifies it. It must contribute NO match at all.
    const source = 'banner_model = f"gemini-2.0-flash"\n';
    const matches = await findPyModelIdLiterals([src('app/banner.py', source)], REGISTRY);
    expect(matches).toHaveLength(0);

    const result = await applyPyModelIdFixesToSources([src('app/banner.py', source)], REGISTRY);
    expect(result.siteCount).toBe(0);
    expect(result.patchedFiles).toHaveLength(0);
  });
});

describe('python test-file hardening', () => {
  it.each([
    'app/test_routes.py',
    'app/routes_test.py',
    'conftest.py',
    'tests/helpers.py',
    'src/tests/deep/fixture.py',
  ])('skips %s outright (nothing swapped, nothing surfaced)', async (path) => {
    const source = 'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"\nPRICES = {"o1-mini": 1}\n';
    const result = await applyPyModelIdFixesToSources([src(path, source)], REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0);
    expect(result.blockedMatches).toHaveLength(0);
    expect(result.usageUnverifiedMatches).toHaveLength(0);
    expect(result.patchedFiles).toHaveLength(0);
  });

  it('still scans a non-test sibling in the same batch', async () => {
    const live = 'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"\ndef go():\n    return oai.chat.completions.create(model=MODEL_NAME)\n';
    const result = await applyPyModelIdFixesToSources(
      [src('app/test_routes.py', live), src('app/live.py', live)],
      REGISTRY,
    );
    expect(result.siteCount).toBe(1);
    expect(result.changedFiles).toEqual(['app/live.py']);
  });
});

describe('python syntax gate (the honesty backstop)', () => {
  it('DOWNGRADES when a swap would introduce new syntax errors', async () => {
    // A poisoned registry entry: verified (so it passes the engine gate) but
    // its replacement text breaks out of the string literal. The syntax gate
    // is exactly the last line of defense for "trusted" data that is wrong.
    const poisoned: LlmRegistry = [
      {
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4-vision-preview',
        replacement: 'oops" + broken(',
        verification: autoApplyVerification(),
      },
    ];
    const source = 'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gpt-4-vision-preview"\ndef go():\n    return oai.chat.completions.create(model=MODEL_NAME)\n';
    const result = await applyPyModelIdFixesToSources([src('app/broken.py', source)], poisoned);

    // The swap itself happened in-memory (diff is shown for review)...
    expect(result.siteCount).toBe(1);
    expect(result.diff).toContain('oops');
    // ...but the gate caught the breakage and reports it, so the CLI
    // downgrades to Tier C and refuses --write.
    expect(result.syntaxGate.passed).toBe(false);
    expect(result.syntaxGate.failures).toHaveLength(1);
    expect(result.syntaxGate.failures[0]).toContain('app/broken.py');
  });

  it('PASSES for a benign swap (baseline-relative: zero new errors)', async () => {
    const source = 'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"\ndef go():\n    return oai.chat.completions.create(model=MODEL_NAME)\n';
    const result = await applyPyModelIdFixesToSources([src('app/fine.py', source)], REGISTRY);
    expect(result.syntaxGate.passed).toBe(true);
    expect(result.syntaxGate.failures).toHaveLength(0);
  });
});

describe('python sink rule: assignments swap ONLY when traced to an in-file sink', () => {
  it('REGRESSION (simulator.py): a bare assignment with no sink is NOT auto-swapped', async () => {
    // The real Tier A false positive: a model-like assignment inside an
    // event-payload generator. The returned dict is DATA, not a call — no
    // sink, so the match demotes to a usage-unverified candidate.
    const source = [
      'def generate_cost_spike_event():',
      '    model = "gpt-4"',
      '    return {"event": "cost_spike", "model": model, "cost": 42.0}',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('sim/simulator.py', source)], REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.patchedFiles).toHaveLength(0);
    expect(result.diff).toBe('');
    // Since the 2026-09-04 partner audits a literal inside a COST / event-payload
    // helper is informational (its name says it cannot be selecting a request
    // model), so this one is a data match with that reason — still visible, never
    // swapped, and not double-reported on any other surface.
    expect(result.usageUnverifiedMatches).toHaveLength(0);
    expect(result.dataMatches).toHaveLength(1);
    expect(result.dataMatches[0]).toMatchObject({ value: 'gpt-4', replacement: 'gpt-5.6-sol' });
    expect(result.blockedMatches).toHaveLength(0);
  });

  it('the same bare assignment in a neutrally-named function is a usage-unverified candidate', async () => {
    const source = [
      'def generate_event():',
      '    model = "gpt-4"',
      '    return {"event": "spike", "model": model}',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('sim/simulator.py', source)], REGISTRY);
    expect(result.siteCount).toBe(0);
    expect(result.usageUnverifiedMatches).toHaveLength(1);
    expect(result.usageUnverifiedMatches[0]).toMatchObject({
      value: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      reason: USAGE_UNVERIFIED_REASON,
    });
    expect(result.dataMatches).toHaveLength(0);
  });

  it('the SAME assignment swaps once the file passes the name to a provider sink', async () => {
    const source = [
      'from openai import OpenAI',
      'oai = OpenAI()',
      'def generate_cost_spike_event(client):',
      '    model = "gpt-4"',
      '    oai.chat.completions.create(model=model)',
      '    return {"event": "cost_spike", "model": model, "cost": 42.0}',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('sim/simulator.py', source)], REGISTRY);

    expect(result.siteCount).toBe(1);
    expect(result.patchedFiles[0]!.newText).toContain('model = "gpt-5.6-sol"');
    expect(result.usageUnverifiedMatches).toHaveLength(0);
  });

  it('a model-factory positional argument counts as a sink', async () => {
    const source = [
      'import google.generativeai as genai',
      'model_id = "gemini-2.0-flash"',
      'gm = genai.GenerativeModel(model_id)',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/gm.py', source)], REGISTRY);

    expect(result.siteCount).toBe(1);
    expect(result.patchedFiles[0]!.newText).toContain('model_id = "gemini-flash-latest"');
  });

  // GUARD G2 (reversed premise). A model-keyed dict handed to an UNRECOGNIZED
  // callee used to count as a sink and earn Tier A. It must not: `requests.post`
  // to an arbitrary URL may be Azure, a proxy, a gateway or a vLLM host, so the
  // id namespace is unproven. The finding is real — it is reported for review —
  // but it is never an unattended swap.
  it('a model-keyed dict passed to an UNRECOGNIZED callee is NOT swapped', async () => {
    const source = [
      'def go():',
      '    model = "gpt-4"',
      '    return requests.post("/v1/chat", json={"model": model})',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/post.py', source)], REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.patchedFiles).toHaveLength(0);
    // …and it is still SURFACED, not silently dropped.
    expect(result.usageUnverifiedMatches.length).toBeGreaterThan(0);
  });

  it('a self.model assignment traces through the attribute name', async () => {
    const source = [
      'from openai import OpenAI',
      'oai = OpenAI()',
      'class Bot:',
      '    def __init__(self):',
      '        self.model = "gpt-4"',
      '    def run(self, client):',
      '        return oai.chat.completions.create(model=self.model)',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/bot.py', source)], REGISTRY);

    expect(result.siteCount).toBe(1);
    expect(result.patchedFiles[0]!.newText).toContain('self.model = "gpt-5.6-sol"');
  });

  it('a parameter default with no in-file sink demotes too', async () => {
    const source = [
      'def make_event(model="gpt-4"):',
      '    return {"model": model}',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/event.py', source)], REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.usageUnverifiedMatches).toHaveLength(1);
    expect(result.usageUnverifiedMatches[0]!.value).toBe('gpt-4');
  });

  it('a parameter default swaps when the body reaches a sink', async () => {
    const source = [
      'from openai import OpenAI',
      'oai = OpenAI()',
      'def ask(client, model="gpt-4"):',
      '    return oai.chat.completions.create(model=model)',
      '',
    ].join('\n');
    const result = await applyPyModelIdFixesToSources([src('app/ask.py', source)], REGISTRY);

    expect(result.siteCount).toBe(1);
    expect(result.patchedFiles[0]!.newText).toContain('def ask(client, model="gpt-5.6-sol"):');
    expect(result.usageUnverifiedMatches).toHaveLength(0);
  });
});

describe('python file annotations (mendr magic comments)', () => {
  it('a `# mendr: model-catalog` file yields no matches; surfaces as a catalog', async () => {
    const source = [
      '# mendr: model-catalog',
      'CATALOG = {',
      '    "gpt-4": "gpt-5.6-sol",',
      '    "gemini-2.0-flash": "gemini-flash-latest",',
      '}',
      '',
    ].join('\n');
    const sources = [src('app/catalog.py', source)];

    const matches = await findPyModelIdLiterals(sources, REGISTRY);
    expect(matches).toHaveLength(0);
    const result = await applyPyModelIdFixesToSources(sources, REGISTRY);
    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0);

    const scan = scanPyAnnotations(sources, REGISTRY);
    expect(scan.catalogs).toHaveLength(1);
    expect(scan.catalogs[0]!.file).toBe('app/catalog.py');
    expect(scan.catalogs[0]!.ids.sort()).toEqual(['gemini-2.0-flash', 'gpt-4']);
    expect(scan.ignoredFiles).toHaveLength(0);
  });

  it('a `# mendr: ignore-file` file is skipped entirely and counted', async () => {
    const source = [
      '# mendr: ignore-file',
      'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"',
      'def go():',
      '    return oai.chat.completions.create(model=MODEL_NAME)',
      '',
    ].join('\n');
    const sources = [src('app/skipme.py', source)];

    const matches = await findPyModelIdLiterals(sources, REGISTRY);
    expect(matches).toHaveLength(0);

    const scan = scanPyAnnotations(sources, REGISTRY);
    expect(scan.ignoredFiles).toEqual(['app/skipme.py']);
    expect(scan.catalogs).toHaveLength(0);
  });

  it('an annotation past the first 5 lines is NOT honored', async () => {
    const source = [
      '# line 1',
      '# line 2',
      '# line 3',
      '# line 4',
      '# line 5',
      '# mendr: ignore-file',
      'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"',
      'def go():',
      '    return oai.chat.completions.create(model=MODEL_NAME)',
      '',
    ].join('\n');
    const sources = [src('app/late.py', source)];

    const result = await applyPyModelIdFixesToSources(sources, REGISTRY);
    expect(result.siteCount).toBe(1);
    expect(scanPyAnnotations(sources, REGISTRY).ignoredFiles).toHaveLength(0);
  });
});

describe('python diff output', () => {
  it('produces a git-appliable unified diff touching only changed files', async () => {
    const result = await applyPyModelIdFixesToSources(
      [
        src('app/llm.py', 'from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gemini-2.0-flash"\ndef go():\n    return oai.chat.completions.create(model=MODEL_NAME)\n'),
        src('app/other.py', 'GREETING = "hello world"\n'),
      ],
      REGISTRY,
    );

    expect(result.diff).toContain('diff --git a/app/llm.py b/app/llm.py');
    expect(result.diff).toMatch(/^-.*gemini-2\.0-flash"/m);
    expect(result.diff).toMatch(/^\+.*gemini-flash-latest"/m);
    expect(result.diff).not.toContain('other.py');
  });
});

// --- MULTIMAP: two registry records for one value (Python) ------------------
//
// The Python spelling of the TS multimap test: the scanner indexes by value as
// a multimap and emits one match per matching record, and the fixer collapses
// them back to one splice per literal. Was finding #1 of the watch review — a
// first-wins index silently dropped the second record's retirement deadline.

describe('duplicate registry records for one value (multimap)', () => {
  const DUP: LlmRegistry = [
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      shutdownDate: '2026-10-23',
      verification: autoApplyVerification(),
    },
    {
      provider: 'openai',
      kind: 'model_id',
      deprecated: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      shutdownDate: '2027-01-01',
      verification: autoApplyVerification(),
    },
  ];

  const SOURCE = ['from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gpt-4"', 'oai.chat.completions.create(model=MODEL_NAME)', ''].join(
    '\n',
  );

  it('emits one match per matching record for a duplicated value', async () => {
    const matches = await findPyModelIdLiterals([src('app/dup.py', SOURCE)], DUP);

    // Two records -> two matches at the SAME span (same content offsets).
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => `${m.contentStart}:${m.contentEnd}`)).size).toBe(1);
    expect(matches.map((m) => m.deprecation.shutdownDate).sort()).toEqual([
      '2026-10-23',
      '2027-01-01',
    ]);
  });

  it('collapses agreeing records to a SINGLE splice (no double-edit corruption)', async () => {
    const result = await applyPyModelIdFixesToSources([src('app/dup.py', SOURCE)], DUP);

    expect(result.siteCount).toBe(1);
    expect(result.syntaxGate.passed).toBe(true);
    expect(result.patchedFiles[0]!.newText).toContain('from openai import OpenAI\noai = OpenAI()\nMODEL_NAME = "gpt-5.6-sol"');
    // The id appears once in the source; it is replaced exactly once, not twice.
    expect(result.patchedFiles[0]!.newText).not.toContain('"gpt-4"');
  });
});
