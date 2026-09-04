import { describe, expect, it, beforeAll } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import {
  findPyModelIdLiterals,
  PY_DEFAULT_CONTAINER_REASON,
  PY_EXAMPLE_REASON,
  PY_FIELD_DEFAULT_REASON,
  PY_LOOKUP_DEFAULT_REASON,
  PY_PREFIXED_REASON,
  PY_RETURN_DEFAULT_REASON,
  PY_WRAPPER_FACTORY_REASON,
} from './scanPy.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';

// Python hardening — regression suite for the external-validation defects
// (VALIDATION-2026-09-03.md): C5 wrapper factories bypassed the surface guard;
// M2 real defaults were filed as Tier C "no selector"; C3 examples were
// dependencies; M9 provider-prefixed selectors were invisible.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'dall-e-2', replacement: 'gpt-image-1', status: 'deprecated', shutdownDate: '2026-05-12', verification: autoApplyVerification() },
];

async function tiers(path: string, text: string) {
  const matches = await findPyModelIdLiterals([{ path, text }], REG);
  return matches.map((m) => ({
    value: m.value,
    line: m.location.line,
    position: m.position,
    reason: m.reason,
    purpose: m.purpose,
    tier: classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }).tier,
  }));
}

beforeAll(async () => {
  await findPyModelIdLiterals([{ path: 'warm.py', text: 'x = 1\n' }], REG);
}, 60_000);

describe('C5 — wrapper factories never earn Tier A', () => {
  it('ChatOpenAI(model="gpt-4") inside a function is a review candidate (langchain shape)', async () => {
    const t = await tiers('app/eval.py', `
from langchain_openai import ChatOpenAI

def load(llm=None):
    return llm or ChatOpenAI(model="gpt-4", seed=42)
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
    expect(hit?.reason).toBe(PY_WRAPPER_FACTORY_REASON);
  }, 60_000);

  it('ChatOpenAI behind a base_url override is capped too', async () => {
    const t = await tiers('app/local.py', `
from langchain_openai import ChatOpenAI

def build():
    return ChatOpenAI(model="gpt-4", base_url="http://localhost:11434/v1")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a first-party factory with a client_options override is capped', async () => {
    const t = await tiers('app/g.py', `
import google.generativeai as genai

def build():
    return genai.GenerativeModel("gpt-4", client_options={"api_endpoint": "proxy.internal"})
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);
});

describe('M2 — real defaults are review candidates, never "no selector"', () => {
  it('a Pydantic class-field default on a model-named field is Tier B (langchain ChatOpenAI shape)', async () => {
    const t = await tiers('langchain_openai/chat_models/base.py', `
from pydantic import BaseModel, Field

class ChatOpenAI(BaseModel):
    model_name: str = Field(default="gpt-3.5-turbo", alias="model")
    temperature: float = 0.7
`);
    const hit = t.find((x) => x.value === 'gpt-3.5-turbo');
    expect(hit?.tier).toBe('B');
    expect(hit?.position).toBe('usage_unverified');
    expect(hit?.reason).toBe(PY_FIELD_DEFAULT_REASON);
  }, 60_000);

  it('a fallback returned from a model-named function is Tier B (open-webui images shape)', async () => {
    const t = await tiers('backend/routers/images.py', `
def get_image_model():
    return image_config.IMAGE_GENERATION_MODEL if image_config.IMAGE_GENERATION_MODEL else "dall-e-2"
`);
    const hit = t.find((x) => x.value === 'dall-e-2');
    expect(hit?.tier).toBe('B');
    expect(hit?.reason).toBe(PY_RETURN_DEFAULT_REASON);
  }, 60_000);

  it('a fallback returned from an unrelated function stays data', async () => {
    const t = await tiers('backend/labels.py', `
def get_label():
    return cfg.LABEL if cfg.LABEL else "dall-e-2"
`);
    expect(t.find((x) => x.value === 'dall-e-2')?.tier).toBe('C');
  }, 60_000);
});

describe('M2 (partner audits, 2026-09-04) — lookup defaults, default-config dicts, model-class id fields', () => {
  it('`getattr(config, "model", "gpt-4")` is a review candidate', async () => {
    const t = await tiers('mem0/reranker/llm_reranker.py', `
def build(config):
    model = getattr(config, "model", "gpt-4")
    return model
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('B');
    expect(hit?.reason).toBe(PY_LOOKUP_DEFAULT_REASON);
  }, 60_000);

  it('`os.environ.get("MEM0_DEFAULT_LLM_MODEL", "gpt-4")` is a review candidate', async () => {
    const t = await tiers('server/main.py', `
import os
DEFAULT_LLM_MODEL = os.environ.get("MEM0_DEFAULT_LLM_MODEL", "gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
  }, 60_000);

  it('a lookup whose key is not model-named stays data', async () => {
    const t = await tiers('app/x.py', `
label = cfg.get("label", "gpt-4")
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
  }, 60_000);

  it('a `"model"` inside DEFAULT_CONFIG is a review candidate; a catalog dict is not', async () => {
    const t = await tiers('server/defaults.py', `
DEFAULT_CONFIG = {"llm": {"provider": "openai", "config": {"model": "gpt-4"}}}
MODEL_CARDS = [{"model": "gpt-3.5-turbo", "label": "GPT-3.5", "pricing": 1}]
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
    expect(t.find((x) => x.value === 'gpt-4')?.reason).toBe(PY_DEFAULT_CONTAINER_REASON);
    expect(t.find((x) => x.value === 'gpt-3.5-turbo')?.tier).toBe('C');
  }, 60_000);

  it('`id: str = "…"` on an embedder/model class is a review candidate (agno shape); on an unrelated class it is data', async () => {
    const t = await tiers('agno/knowledge/embedder/google.py', `
from dataclasses import dataclass

@dataclass
class GeminiEmbedder:
    id: str = "gpt-4"

@dataclass
class Ticket:
    id: str = "gpt-3.5-turbo"
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('B');
    expect(t.find((x) => x.value === 'gpt-3.5-turbo')?.tier).toBe('C');
  }, 60_000);
});

describe('literals that are never request selectors (partner audits, 2026-09-04, litellm)', () => {
  it('a model id handed to a tokenizer helper is informational', async () => {
    const t = await tiers('litellm/llms/a2a/transformation.py', `
def usage(messages):
    prompt_tokens = token_counter(model="gpt-3.5-turbo", messages=messages)
    text = litellm.decode(model="gpt-4", tokens=[1, 2])
    return prompt_tokens, text
`);
    expect(t.find((x) => x.value === 'gpt-3.5-turbo')?.tier).toBe('C');
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
  }, 60_000);

  it('a local model assignment inside a cost / logging / param-mapping helper is informational', async () => {
    const t = await tiers('litellm/cost_calculator.py', `
def completion_cost(model, provider):
    if provider == "azure" and model == "":
        model = "dall-e-2"
    return lookup(model)

def log_success(kwargs):
    model = kwargs.get("model") or "gpt-4"
    return {"model": model}

class Anthropic:
    def map_openai_params(self, params, model):
        original_model = model
        model = "gpt-3.5-turbo"
        return params, original_model
`);
    expect(t.find((x) => x.value === 'dall-e-2')?.tier).toBe('C');
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
    expect(t.find((x) => x.value === 'gpt-3.5-turbo')?.tier).toBe('C');
  }, 60_000);

  it('a parameter default on a metrics endpoint is informational; on a request path it stays review', async () => {
    const t = await tiers('litellm/proxy/proxy_server.py', `
async def model_metrics(_selected_model_group: str = "gpt-4"):
    return query(_selected_model_group)

def ask(model: str = "gpt-3.5-turbo"):
    return model
`);
    expect(t.find((x) => x.value === 'gpt-4')?.tier).toBe('C');
    expect(t.find((x) => x.value === 'gpt-3.5-turbo')?.tier).toBe('B');
  }, 60_000);
});

describe('C3 — examples are informational', () => {
  it('a direct SDK call under examples/ is Tier C with the example purpose', async () => {
    const t = await tiers('examples/quickstart.py', `
from openai import OpenAI
client = OpenAI()

def ask():
    return client.chat.completions.create(model="gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'gpt-4');
    expect(hit?.tier).toBe('C');
    expect(hit?.purpose).toBe('example');
    expect(hit?.reason).toBe(PY_EXAMPLE_REASON);
  }, 60_000);
});

describe('M9 — provider-prefixed selectors are found and capped', () => {
  it('model="openai/gpt-4" is reported as a gateway selector at Tier B', async () => {
    const t = await tiers('app/gateway.py', `
def ask(router):
    return router.chat(model="openai/gpt-4", messages=[])
`);
    const hit = t.find((x) => x.value === 'openai/gpt-4');
    expect(hit?.tier).toBe('B');
    expect(hit?.position).toBe('surface_capped');
    expect(hit?.reason).toBe(PY_PREFIXED_REASON);
  }, 60_000);

  it('a prefixed id in a list is data, not a selector', async () => {
    const t = await tiers('app/catalog.py', 'SUPPORTED = ["openai/gpt-4", "openai/gpt-4o"]\n');
    expect(t.find((x) => x.value === 'openai/gpt-4')?.tier).toBe('C');
  }, 60_000);
});
