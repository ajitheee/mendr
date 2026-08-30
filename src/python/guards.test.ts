import { describe, expect, it, beforeAll } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification, withheldVerification } from '../usage/llmRegistry.js';
import { findPyModelIdLiterals } from './scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';

// PYTHON GUARDS G1–G5.
//
// Every fixture here comes from a real false positive. mendr classified all 25
// Dify Python sites as Tier A ("safe to auto-migrate") when the correct answer is
// 0 A / 5 B / 20 C. The worst, `AzureBaseModel(base_model_name="gpt-4")`, is a
// module-level catalog record whose string is a STORED-CREDENTIAL LOOKUP KEY —
// rewriting it raises ValueError for every existing workspace.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-4o', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-4o-mini', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'dall-e-3', replacement: 'gpt-image-2', status: 'deprecated', shutdownDate: '2026-05-12', verification: withheldVerification('unverifiable') },
  { provider: 'google', kind: 'model_id', deprecated: 'gemini-1.5-pro', replacement: 'gemini-2.5-pro', status: 'deprecated', shutdownDate: '2025-09-29', verification: autoApplyVerification() },
];

/** Scan one synthetic file and return (tier, position, reason) per occurrence. */
async function tiers(path: string, text: string) {
  const matches = await findPyModelIdLiterals([{ path, text }], REG);
  return matches.map((m) => ({
    value: m.value,
    line: m.location.line,
    position: m.position,
    reason: m.reason,
    tier: classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier,
  }));
}

beforeAll(async () => {
  // Warm the WASM parser so the first real assertion is not timing out on init.
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
}, 60_000);

describe('G1 — executability AND context', () => {
  it('an Azure catalog CONSTRUCTOR in a module-level list is Tier C', async () => {
    const t = await tiers('models/azure_openai/models/constants.py', `
LLM_BASE_MODELS = [
    AzureBaseModel(
        base_model_name="gpt-4",
        entity=AIModelEntity(model="fake-deployment-name"),
    ),
]
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('C');
  }, 60_000);

  it('base_model_name="gpt-4" is Tier C — it is a stored-credential lookup key', async () => {
    const t = await tiers('plugin/provider.py', `
def build():
    return Thing(base_model_name="gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
  }, 60_000);

  it('a fake-deployment placeholder is suppressed, not reported as a model', async () => {
    const t = await tiers('models/azure_openai/x.py', `
def go(client):
    return client.chat.completions.create(model="fake-deployment-name")
`);
    expect(t.find((x) => x.value === 'fake-deployment-name')).toBeUndefined();
  }, 60_000);

  it('CORRECTION: a genuine SDK request executed at MODULE IMPORT is B, not C', async () => {
    // Python runs module bodies at import — this really fires.
    const t = await tiers('boot.py', `
import openai
client = openai.OpenAI()
WARMUP = client.chat.completions.create(model="gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
    expect(hit?.position).toBe('surface_capped');
  }, 60_000);

  it('module-level DATA construction stays C', async () => {
    const t = await tiers('catalog.py', 'SUPPORTED = {"gpt-4": {"ctx": 8192}}\n');
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
  }, 60_000);
});

describe('G2 — a qualified SDK sink is required', () => {
  it('an UNKNOWN function taking model= is never Tier A', async () => {
    const t = await tiers('app.py', `
def go():
    return my_helper(model="gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).not.toBe('A');
  }, 60_000);

  it('a direct modern OpenAI chat request with a verified successor IS Tier A', async () => {
    const t = await tiers('app.py', `
from openai import OpenAI
client = OpenAI()

def ask(q):
    return client.chat.completions.create(model="gpt-4", messages=[{"role": "user", "content": q}])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('A');
    expect(hit?.position).toBe('model_arg');
  }, 60_000);
});

describe('G3 — endpoint-specific argument rules', () => {
  it('a label / display field is never model-selection proof', async () => {
    const t = await tiers('app.py', `
def go():
    return Entity(label="gpt-4", display_name="gpt-4")
`);
    for (const hit of t.filter((x) => x.value === 'gpt-4')) expect(hit.tier).toBe('C');
  }, 60_000);
});

describe('G4 — provider-surface attribution caps the tier', () => {
  it('an Azure SDK request with a deployment name is at most Tier B', async () => {
    const t = await tiers('models/azure_openai/llm.py', `
from openai import AzureOpenAI
client = AzureOpenAI(api_version="2024-02-01")

def ask(q):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
  }, 60_000);

  it('an OpenAI-compatible PROXY is at most Tier B', async () => {
    const t = await tiers('models/cometapi/provider/cometapi.py', `
from openai import OpenAI
client = OpenAI(base_url="https://api.cometapi.com/v1")

def validate():
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a provider namespace mismatch withholds the direct replacement', async () => {
    const t = await tiers('models/openrouter/llm.py', `
from openai import OpenAI
client = OpenAI(base_url="https://openrouter.ai/api/v1")

def ask():
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
    expect(hit?.reason).toMatch(/not a verified direct provider/);
  }, 60_000);
});

// Defects found by the Tier-A adversarial review. Each of these reached Tier A
// before the fix, on a file where the CLIENT TYPE is unresolved.
describe('adversarial: an UNRESOLVED client must reduce authority (never Tier A)', () => {
  it('a call on an untyped parameter is not Tier A', async () => {
    const t = await tiers('app.py', `
def ask(client):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a client pulled out of a dict is not Tier A', async () => {
    const t = await tiers('app.py', `
clients = {}

def ask():
    return clients["a"].chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a locally SHADOWED create() is not Tier A', async () => {
    const t = await tiers('app.py', `
class Foo:
    def create(self, model): pass

class Bar:
    completions = Foo()
    chat = None

def go():
    b = Bar()
    return b.chat.completions.create(model="gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a method chain that merely LOOKS like the SDK path is not Tier A', async () => {
    const t = await tiers('app.py', `
def go(fake):
    return fake.chat.completions.create(model="gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  // The minimal pair that defeated the first fix: file-wide TEXT evidence cannot
  // say WHICH object the call is made on. One unused import flipped a
  // byte-identical call site from B to A, and `fix-llm --write` then rewrote
  // injected production code unattended.
  it('an UNUSED import does not confer Tier A on a call with an injected client', async () => {
    const t = await tiers('src/services/chat.py', `
from openai import OpenAI  # noqa: F401  (re-exported for callers' type hints)


def ask(client, prompt):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a DOCSTRING mentioning the SDK does not confer Tier A', async () => {
    const t = await tiers('src/services/chat.py', `
"""Callers pass a client built with: from openai import OpenAI."""


def ask(client, prompt):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('evidence from a DIFFERENT provider family never authorizes the swap', async () => {
    const t = await tiers('src/services/chat.py', `
import anthropic

anthropic_client = anthropic.Anthropic()


def ask(client, prompt):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a client constructed with a base_url override is not `direct`', async () => {
    const t = await tiers('app.py', `
from openai import OpenAI
client = OpenAI(base_url="https://gateway.internal/v1")

def ask():
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a receiver bound TWICE is ambiguous and capped', async () => {
    const t = await tiers('app.py', `
from openai import OpenAI, AzureOpenAI
client = OpenAI()
if USE_AZURE:
    client = AzureOpenAI(api_version="2024-02-01")

def ask():
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('but a file with real first-party client evidence still reaches Tier A', async () => {
    const t = await tiers('app.py', `
from openai import OpenAI
client = OpenAI()

def ask(q):
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('A');
  }, 60_000);
});

describe('G5 — replacement and endpoint compatibility', () => {
  it('a direct IMAGE request with an unverifiable successor stays Tier B', async () => {
    const t = await tiers('tools/dalle3.py', `
from openai import OpenAI
client = OpenAI()

def draw(prompt):
    return client.images.generate(prompt=prompt, model="dall-e-3", n=1)
`);
    const hit = t.find((x) => x.value === 'dall-e-3');
    expect(hit?.tier).toBe('B');
  }, 60_000);

  it('a Google count_tokens call stays Tier B unless explicitly qualified', async () => {
    const t = await tiers('models/gemini/embed.py', `
def count(client, text):
    return client.models.count_tokens(model="gemini-1.5-pro", contents=[text])
`);
    expect(t.find((x) => x.value === 'gemini-1.5-pro')?.tier).toBe('B');
  }, 60_000);

  it('a LEGACY OpenAI call stays Tier B', async () => {
    const t = await tiers('legacy.py', `
import openai

def ask(q):
    return openai.ChatCompletion.create(model="gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
  }, 60_000);
});
