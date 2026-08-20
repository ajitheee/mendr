import { describe, it, expect } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { findPyModelIdLiterals, type PySource } from './scanPy.js';
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
    verification: { status: 'verified' },
  },
  {
    provider: 'google',
    kind: 'model_id',
    deprecated: 'gemini-2.0-flash',
    replacement: 'gemini-flash-latest',
    note: 'gemini-2.0-flash retired',
    status: 'retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-opus-20240229',
    replacement: 'claude-opus-4-8',
    note: 'Claude 3 Opus retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'anthropic',
    kind: 'model_id',
    deprecated: 'claude-3-5-sonnet-20241022',
    replacement: 'claude-sonnet-4-5',
    note: 'Claude 3.5 Sonnet v2 retired',
    verification: { status: 'verified' },
  },
  {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1-mini',
    replacement: 'o4-mini',
    note: 'o1-mini deprecated',
    verification: { status: 'unverified' },
  },
];

/**
 * One file exercising every classification rule at once, so a single codemod
 * run must get every position right — the same all-in-one shape as the TS
 * CALL_SITE_SOURCE.
 */
const CALL_SITE_SOURCE = `
import google.generativeai as genai

# MUST SWAP (a): model-like keyword argument, in any call.
def vision(client):
    return client.chat.completions.create(model="gpt-4-vision-preview")

# MUST SWAP (c): assignment to a model-named constant.
MODEL_NAME = "gemini-2.0-flash"

# MUST SWAP (d): direct string argument to a known model factory.
g_model = genai.GenerativeModel("gemini-2.0-flash")

# MUST SWAP (b): value of a model-like dict key, dict PASSED TO A CALL.
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
    // (d) model-factory positional argument.
    expect(text).toContain('genai.GenerativeModel("gemini-flash-latest")');
    // (b) model-keyed dict passed to a call.
    expect(text).toContain('json={"model": "gpt-4o"}');

    expect(result.siteCount).toBe(4);
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

    // Five data positions: standalone dict value, pricing key, list element,
    // == operand, in-tuple element.
    expect(result.dataMatches).toHaveLength(5);
    const values = result.dataMatches.map((d) => d.value).sort();
    expect(values).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
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
    expect(swaps).toHaveLength(4);
    expect(data).toHaveLength(5);
  });

  it('tags each data match with a purpose (mirrors the TS purpose labels)', async () => {
    const matches = await findPyModelIdLiterals([src('app/llm.py', CALL_SITE_SOURCE)], REGISTRY);
    const data = matches.filter((m) => m.position === 'data');
    const byPurpose = (p: string) => data.filter((m) => m.purpose === p).map((m) => m.value);

    // Standalone dict value -> config/catalog entry.
    expect(byPurpose('catalog_entry')).toEqual(['claude-3-opus-20240229']);
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
    const source = 'SMALL_MODEL = "o1-mini"\n';
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
      "model_single = 'gemini-2.0-flash'",
      'model_double = "gemini-2.0-flash"',
      'model_triple = """gemini-2.0-flash"""',
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
    const source = 'MODEL_NAME = "gemini-2.0-flash"\nPRICES = {"o1-mini": 1}\n';
    const result = await applyPyModelIdFixesToSources([src(path, source)], REGISTRY);

    expect(result.siteCount).toBe(0);
    expect(result.dataMatches).toHaveLength(0);
    expect(result.blockedMatches).toHaveLength(0);
    expect(result.patchedFiles).toHaveLength(0);
  });

  it('still scans a non-test sibling in the same batch', async () => {
    const result = await applyPyModelIdFixesToSources(
      [
        src('app/test_routes.py', 'MODEL_NAME = "gemini-2.0-flash"\n'),
        src('app/live.py', 'MODEL_NAME = "gemini-2.0-flash"\n'),
      ],
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
        verification: { status: 'verified' },
      },
    ];
    const source = 'MODEL_NAME = "gpt-4-vision-preview"\n';
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
    const source = 'MODEL_NAME = "gemini-2.0-flash"\n';
    const result = await applyPyModelIdFixesToSources([src('app/fine.py', source)], REGISTRY);
    expect(result.syntaxGate.passed).toBe(true);
    expect(result.syntaxGate.failures).toHaveLength(0);
  });
});

describe('python diff output', () => {
  it('produces a git-appliable unified diff touching only changed files', async () => {
    const result = await applyPyModelIdFixesToSources(
      [
        src('app/llm.py', 'MODEL_NAME = "gemini-2.0-flash"\n'),
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
