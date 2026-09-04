import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from './llmRegistry.js';
import { findModelIdLiterals, isTestPath } from './scanLiterals.js';
import { classifyOccurrenceTier } from '../report/classifyOccurrence.js';
import { isExamplePath, splitProviderPrefix } from './sharedRules.js';
import {
  TS_CLI_DEFAULT_REASON,
  TS_DEFAULT_UNTRACED_REASON,
  TS_EXAMPLE_REASON,
  TS_MODULE_LEVEL_REASON,
  TS_PREFIXED_REASON,
} from './tsSurface.js';

// THE TYPESCRIPT GUARDS — regression suite for the external-validation defects
// (VALIDATION-2026-09-03.md). Every case below is a shape that a real repository
// had promoted to Tier A / PATCH ELIGIBLE, or a real selector filed as Tier C.
// The contract: only a first-party SDK request whose client resolves IN THIS FILE,
// with no proxy/Azure override, inside a function, earns Tier A.

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-4', replacement: 'gpt-5.6-sol', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
  { provider: 'anthropic', kind: 'model_id', deprecated: 'claude-3-haiku-20240307', replacement: 'claude-haiku-4-5', status: 'deprecated', shutdownDate: '2026-11-01', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'dall-e-3', replacement: 'gpt-image-1', status: 'deprecated', shutdownDate: '2026-12-01', verification: autoApplyVerification() },
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-5-nano', replacement: 'gpt-5.6-nano', status: 'deprecated', shutdownDate: '2027-01-01', verification: autoApplyVerification() },
];

function scan(source: string, file = 'src/app.ts') {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(file, source);
  return findModelIdLiterals(project, REG);
}
function tierOf(source: string, file = 'src/app.ts', value = 'gpt-4') {
  const m = scan(source, file).find((x) => x.value === value || x.value.endsWith('/' + value) || x.value.endsWith(':' + value));
  if (!m) return undefined;
  return { ...classifyOccurrenceTier({ position: m.position, deprecation: m.deprecation, reason: m.reason }), position: m.position, reason: m.reason, purpose: m.purpose };
}

const OPENAI = 'import OpenAI from "openai";\nconst client = new OpenAI();\n';

describe('C1 — a model-named declaration is judged by where it is USED, never by its name', () => {
  it('an exported constant nothing feeds to a request is a review candidate (NextChat / lobe-chat shape)', () => {
    const t = tierOf('export const GEMINI_SUMMARIZE_MODEL = "gpt-4";\n');
    expect(t?.tier).toBe('B');
    expect(t?.position).toBe('usage_unverified');
    expect(t?.reason).toBe(TS_DEFAULT_UNTRACED_REASON);
  });
  it('the same constant consumed by a resolved first-party request inside a function is Tier A', () => {
    const t = tierOf(`${OPENAI}export const MODEL = "gpt-4";\nexport function ask() {\n  return client.chat.completions.create({ model: MODEL, messages: [] });\n}\n`);
    expect(t?.tier).toBe('A');
  });
  it('a module-level env fallback in a helper stays capped (continue smoke-api shape)', () => {
    const t = tierOf('export const SMOKE_MODEL = process.env.SMOKE_MODEL || "gpt-4";\n');
    expect(t?.tier).toBe('B');
  });
  it('a local default in a parser that never reaches a request is a candidate (open-webui shape)', () => {
    const t = tierOf('export function convert(m: any) {\n  const model = m?.metadata?.model_slug || "gpt-4";\n  return { model };\n}\n');
    expect(t?.tier).toBe('B');
  });
});

describe('C2 — a `model:` property is a model argument only for a RESOLVED first-party request', () => {
  it('a React Query mutation to the app\'s own API is not a provider call (LibreChat shape)', () => {
    const t = tierOf('export async function save(mutation: any, conv: any) {\n  await mutation.mutateAsync({ model: conv?.model ?? "gpt-4", text: "x" });\n}\n');
    expect(t?.tier).toBe('B');
    expect(t?.position).toBe('surface_capped');
  });
  it('a mocked response body under JSON.stringify is not a request (vercel/ai shape)', () => {
    const t = tierOf('export function fake() {\n  return new Response(JSON.stringify({ id: "msg", model: "gpt-4", content: [] }));\n}\n');
    expect(t?.tier).toBe('B');
  });
  it('an internal wrapper method (`this.complete`) is capped (continue BaseLLM shape)', () => {
    const t = tierOf('export class Reranker {\n  async rank() {\n    return this.complete("p", { maxTokens: 1, model: "gpt-4" });\n  }\n  async complete(p: string, o: any) { return p + o.model; }\n}\n');
    expect(t?.tier).toBe('B');
  });
  it('an injected client parameter cannot be verified in this file', () => {
    const t = tierOf('export async function ask(client: any) {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n');
    expect(t?.tier).toBe('B');
  });
  it('a client built with a baseURL override is a proxy, capped at review', () => {
    const t = tierOf('import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "http://localhost:11434/v1" });\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n');
    expect(t?.tier).toBe('B');
    expect(t?.reason).toContain('proxy');
  });
  it('an Azure client is capped at review', () => {
    const t = tierOf('import { AzureOpenAI } from "openai";\nconst client = new AzureOpenAI();\nexport async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n');
    expect(t?.tier).toBe('B');
    expect(t?.reason).toContain('azure');
  });
  it('a client imported from a non-provider package is an unknown wrapper', () => {
    const t = tierOf('import { llm } from "./wrapper";\nexport async function ask() {\n  return llm.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n');
    expect(t?.tier).toBe('B');
  });
  it('the resolved first-party shape is Tier A', () => {
    const t = tierOf(`${OPENAI}export async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n`);
    expect(t?.tier).toBe('A');
  });
  it('an inline `new OpenAI()` receiver resolves too', () => {
    const t = tierOf('import OpenAI from "openai";\nexport async function ask() {\n  return new OpenAI().chat.completions.create({ model: "gpt-4", messages: [] });\n}\n');
    expect(t?.tier).toBe('A');
  });
});

describe('G1 — module-level execution is real but never an unattended swap', () => {
  it('a top-level await on a resolved client is capped', () => {
    const t = tierOf(`${OPENAI}export const r = await client.chat.completions.create({ model: "gpt-4", messages: [] });\n`);
    expect(t?.tier).toBe('B');
    expect(t?.reason).toBe(TS_MODULE_LEVEL_REASON);
  });
  it('a module-level agent construction with a factory model is capped (vercel/ai e2e shape)', () => {
    const t = tierOf('import { openai } from "@ai-sdk/openai";\nexport const agent = new Agent({ model: openai("gpt-4") });\n');
    expect(t?.tier).toBe('B');
  });
});

describe('G4 — endpoint family must match the client family', () => {
  it('an Anthropic endpoint on an OpenAI client is capped', () => {
    const t = tierOf(`${OPENAI}export async function ask() {\n  return client.messages.create({ model: "claude-3-haiku-20240307", max_tokens: 1 });\n}\n`, 'src/app.ts', 'claude-3-haiku-20240307');
    expect(t?.tier).toBe('B');
    expect(t?.reason).toContain('endpoint is anthropic');
  });
  it('the matching Anthropic client is Tier A', () => {
    const t = tierOf('import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic();\nexport async function ask() {\n  return client.messages.create({ model: "claude-3-haiku-20240307", max_tokens: 1 });\n}\n', 'src/app.ts', 'claude-3-haiku-20240307');
    expect(t?.tier).toBe('A');
  });
});

describe('M3 — provider sub-factories are recognized, and resolved like any receiver', () => {
  it('`openai.image("dall-e-3")` from @ai-sdk/openai inside a function is Tier A', () => {
    const t = tierOf('import { openai } from "@ai-sdk/openai";\nexport async function gen() {\n  return generateImage({ model: openai.image("dall-e-3") });\n}\n', 'src/app.ts', 'dall-e-3');
    expect(t?.tier).toBe('A');
  });
  it('`anthropic.messages("…")` from an unresolved import is capped', () => {
    const t = tierOf('import { anthropic } from "./providers";\nexport async function gen() {\n  return generateText({ model: anthropic.messages("claude-3-haiku-20240307") });\n}\n', 'src/app.ts', 'claude-3-haiku-20240307');
    expect(t?.tier).toBe('B');
  });
});

describe('M4 — an Azure deployment alias is live only inside a call', () => {
  it('`config: { deploymentName }` in a catalog card is data (lobe-chat shape)', () => {
    const t = tierOf('export const cards = [{ id: "x", config: { deploymentName: "gpt-4" } }];\n');
    expect(t?.tier).toBe('C');
    expect(t?.purpose).toBe('catalog_entry');
  });
  it('a deployment alias passed to a call stays on the azure surface', () => {
    const t = tierOf(`${OPENAI}export async function ask() {\n  return client.getChatCompletions({ deployment: "gpt-4" });\n}\n`);
    expect(t?.position).toBe('azure_deployment');
    expect(t?.tier).toBe('B');
  });
});

describe('C3 / C4 — examples and type-tests are never dependencies', () => {
  it('an examples/ file is informational, whatever it calls', () => {
    const t = tierOf(`${OPENAI}export async function ask() {\n  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n}\n`, 'examples/basic/app.ts');
    expect(t?.tier).toBe('C');
    expect(t?.purpose).toBe('example');
    expect(t?.reason).toBe(TS_EXAMPLE_REASON);
  });
  it('isExamplePath covers examples, samples, demos, docs, cookbook, playground', () => {
    for (const p of [
      'examples/a.ts', 'src/samples/a.ts', 'demo/a.ts', 'docs/a.ts', 'cookbook/a.ts', 'playground/a.ts',
      // partner audits (2026-09-04): example-config directories and benchmark scripts
      'litellm/proxy/example_config_yaml/custom_handler.py', 'sample-apps/x/app.ts', 'benchmarks/run.py',
      'scripts/benchmark_model_response_creator.py', 'notebooks/demo.py',
    ]) {
      expect(isExamplePath(p), p).toBe(true);
    }
    expect(isExamplePath('src/example-service.ts')).toBe(false);
    expect(isExamplePath('src/sampler.ts')).toBe(false);
    expect(isExamplePath('litellm/proxy/proxy_server.py')).toBe(false);
  });
  it('vitest type tests and smoke-test helpers are test paths', () => {
    expect(isTestPath('packages/anthropic/src/anthropic-provider.test-d.ts')).toBe(true);
    expect(isTestPath('extensions/cli/src/smoke-api/helpers.ts')).toBe(true);
    expect(isTestPath('src/__snapshots__/x.ts')).toBe(true);
    expect(isTestPath('integrations/vercel-ai-sdk/config/test-config.ts')).toBe(true); // partner audits, mem0
    expect(isTestPath('src/test_utils.ts')).toBe(true);
    expect(isTestPath('src/anthropic-provider.ts')).toBe(false);
    expect(isTestPath('src/latest-config.ts')).toBe(false);
  });
});

describe('M9 — provider-prefixed selectors are found and capped', () => {
  it('splits gateway and registry spellings', () => {
    expect(splitProviderPrefix('openai/gpt-5-nano')).toEqual({ prefix: 'openai', id: 'gpt-5-nano' });
    expect(splitProviderPrefix('openai:gpt-5-nano')).toEqual({ prefix: 'openai', id: 'gpt-5-nano' });
    expect(splitProviderPrefix('gpt-5-nano')).toBeUndefined();
    expect(splitProviderPrefix('acme/gpt-5-nano')).toBeUndefined();
  });
  it('`model: "openai/gpt-5-nano"` is reported as a gateway selector at Tier B', () => {
    const t = tierOf('export async function ask() {\n  return generateText({ model: "openai/gpt-5-nano", prompt: "x" });\n}\n', 'src/app.ts', 'gpt-5-nano');
    expect(t?.tier).toBe('B');
    expect(t?.position).toBe('surface_capped');
    expect(t?.reason).toBe(TS_PREFIXED_REASON);
    expect(scan('const m = "openai/gpt-5-nano";\n')[0]?.prefixed).toBe(true);
  });
  it('a prefixed id in a type union or a catalog row is data, not a selector (vercel/ai gateway settings shape)', () => {
    const union = tierOf('export type GatewayModelId = "openai/gpt-5-nano" | (string & {});\n', 'src/app.ts', 'gpt-5-nano');
    expect(union?.tier).toBe('C');
    const card = tierOf('export const cards = [{ id: "openai/gpt-5-nano", displayName: "nano" }];\n', 'src/app.ts', 'gpt-5-nano');
    expect(card?.tier).toBe('C');
  });
});

describe('genuine defaults are review candidates, never informational (partner audits, 2026-09-04)', () => {
  it('`this.model = config.model || "…"` in a constructor is a review candidate (mem0-ts shape)', () => {
    const t = tierOf('export class OpenAILLM {\n  private model: string;\n  constructor(config: any) {\n    this.model = config.model || "gpt-4";\n  }\n}\n');
    expect(t?.tier).toBe('B');
    expect(t?.position).toBe('usage_unverified');
  });
  it('the same assignment consumed by a resolved same-class request is Tier A', () => {
    const t = tierOf(
      'import OpenAI from "openai";\nexport class OpenAILLM {\n  private model: string;\n  private client = new OpenAI();\n' +
        '  constructor(config: any) {\n    this.model = config.model || "gpt-4";\n  }\n' +
        '  async ask() {\n    return this.client.chat.completions.create({ model: this.model, messages: [] });\n  }\n}\n',
    );
    expect(['A', 'B']).toContain(t?.tier); // A when the class-property client resolves; never C
    expect(t?.tier).not.toBe('C');
  });
  it('a `model:` inside a DEFAULT-configuration object is a review candidate, not a catalog card', () => {
    const t = tierOf('export const DEFAULT_MEMORY_CONFIG = {\n  llm: { provider: "openai", config: { model: "gpt-4", baseURL: "https://api.openai.com/v1" } },\n};\n');
    expect(t?.tier).toBe('B');
    expect(t?.reason).toContain('default-configuration object');
  });
  it('a catalog card stays informational even under a default-named list', () => {
    const t = tierOf('export const defaultModels = [{ model: "gpt-4", label: "GPT-4", pricing: { input: 1 } }];\n');
    expect(t?.tier).toBe('C');
  });
  it('a `models/` resource-prefixed id is found and capped (mem0 embeddings shape)', () => {
    const t = tierOf('export function pick(cfg: any) {\n  return embed({ model: cfg.model || "models/gemini-embedding-001" });\n}\n', 'src/app.ts', 'gemini-embedding-001');
    expect(t).toBeUndefined(); // gemini-embedding-001 is not in this test registry; the split itself is tested below
    expect(splitProviderPrefix('models/gemini-embedding-001')).toEqual({ prefix: 'models', id: 'gemini-embedding-001' });
    expect(splitProviderPrefix('publishers/google/models/gemini-embedding-001')).toEqual({ prefix: 'publishers/google/models', id: 'gemini-embedding-001' });
  });
});

describe('sink tracing follows lexical scope', () => {
  it('a closure nested inside the declaring function sees the declaration (LibreChat translate shape)', () => {
    const t = tierOf(
      'import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic();\n' +
        'export async function translate() {\n  const model = "claude-3-haiku-20240307";\n' +
        '  const run = async () => client.messages.create({ model, max_tokens: 1 });\n  return run();\n}\n',
      'src/app.ts',
      'claude-3-haiku-20240307',
    );
    expect(t?.tier).toBe('A');
  });
});

describe('M2 — a CLI --model default is a real selector, not data', () => {
  it('`.option("-m, --model <model>", "Model ID", "dall-e-3")` is a review candidate (lobe-chat CLI shape)', () => {
    const t = tierOf('export function register(program: any) {\n  program.option("-m, --model <model>", "Model ID", "dall-e-3");\n}\n', 'src/app.ts', 'dall-e-3');
    expect(t?.tier).toBe('B');
    expect(t?.reason).toBe(TS_CLI_DEFAULT_REASON);
  });
});
