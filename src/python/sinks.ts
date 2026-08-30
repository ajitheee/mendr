// Python provider-SDK sink recognition and surface attribution (guards G1–G5).
//
// WHY THIS EXISTS. The scanner used to treat "a model-like keyword argument in
// ANY call" as proof of a live provider call site. On Dify that made all 25
// findings Tier A — "safe to auto-migrate" — when the correct distribution is
// 0 A / 5 B / 20 C. The worst of them, `AzureBaseModel(base_model_name="gpt-4")`,
// is a module-level pydantic catalog record whose string is a STORED-CREDENTIAL
// LOOKUP KEY: rewriting it raises `ValueError('Base Model Name gpt-4 is invalid')`
// for every existing workspace. An auto-fix there breaks live installations.
//
// So a sink must be recognized by a QUALIFIED, ENDPOINT-SPECIFIC call target, and
// the surface it runs against caps the tier.

import type { Node as PyNode } from 'web-tree-sitter';

// --- G2: the provider SDK sink allowlist ------------------------------------

/** Which provider endpoint a sink talks to — endpoint family gates Tier A (G5). */
export type SinkEndpoint = 'chat' | 'completions' | 'responses' | 'images' | 'embeddings' | 'audio' | 'tokens';

/**
 * Recognized, endpoint-specific provider SDK calls. Matched against the DOTTED
 * CALLEE SUFFIX, so `client.chat.completions.create` and
 * `self._client.chat.completions.create` both resolve. A bare `create(...)` never
 * matches — qualification is the point.
 */
export const PROVIDER_SDK_SINKS: ReadonlyArray<{ suffix: string; endpoint: SinkEndpoint }> = [
  { suffix: 'chat.completions.create', endpoint: 'chat' },
  { suffix: 'chat.completions.parse', endpoint: 'chat' },
  { suffix: 'responses.create', endpoint: 'responses' },
  { suffix: 'responses.parse', endpoint: 'responses' },
  { suffix: 'completions.create', endpoint: 'completions' },
  { suffix: 'images.generate', endpoint: 'images' },
  { suffix: 'images.edit', endpoint: 'images' },
  { suffix: 'embeddings.create', endpoint: 'embeddings' },
  { suffix: 'audio.speech.create', endpoint: 'audio' },
  { suffix: 'audio.transcriptions.create', endpoint: 'audio' },
  { suffix: 'audio.translations.create', endpoint: 'audio' },
  { suffix: 'messages.create', endpoint: 'chat' }, // anthropic
  { suffix: 'messages.stream', endpoint: 'chat' },
  { suffix: 'models.generate_content', endpoint: 'chat' }, // google-genai
  { suffix: 'models.generate_content_stream', endpoint: 'chat' },
  { suffix: 'models.count_tokens', endpoint: 'tokens' },
  { suffix: 'models.embed_content', endpoint: 'embeddings' },
];

/**
 * LEGACY SDK surfaces (openai<1.0 and friends). Real calls, but the migration
 * differs, so they are capped at Tier B (G5).
 */
export const LEGACY_SDK_SINKS: readonly string[] = [
  'openai.ChatCompletion.create',
  'openai.Completion.create',
  'openai.Embedding.create',
  'openai.Image.create',
  'ChatCompletion.create',
  'Completion.create',
];

/**
 * Endpoints whose successor mapping mendr can verify well enough for Tier A.
 * Images, audio, embeddings and token-counting are excluded deliberately: the
 * registry's successors there are not endpoint-compatibility checked (G5), which
 * is exactly why `dall-e-3 -> gpt-image-2` and `count_tokens` stay Tier B.
 */
export const TIER_A_ELIGIBLE_ENDPOINTS: ReadonlySet<SinkEndpoint> = new Set<SinkEndpoint>([
  'chat', 'completions', 'responses',
]);

/** The dotted callee of a `call` node, e.g. `client.chat.completions.create`. */
export function dottedCallee(call: PyNode): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;
  const text = fn.text.trim();
  // Normalize subscripts/parens out of the path: `a[0].b.create` -> `a.b.create`.
  return text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
}

/** Does this dotted callee resolve to a recognized provider SDK sink? */
export function matchSdkSink(dotted: string | null): { endpoint: SinkEndpoint; suffix: string } | null {
  if (!dotted) return null;
  for (const s of PROVIDER_SDK_SINKS) {
    if (dotted === s.suffix || dotted.endsWith(`.${s.suffix}`)) return { endpoint: s.endpoint, suffix: s.suffix };
  }
  return null;
}

export function isLegacySdkSink(dotted: string | null): boolean {
  if (!dotted) return false;
  return LEGACY_SDK_SINKS.some((s) => dotted === s || dotted.endsWith(`.${s}`));
}

/**
 * Does the callee look like a CONSTRUCTOR building stored metadata rather than a
 * request? PascalCase last segment (`AzureBaseModel`, `AIModelEntity`,
 * `ModelConfig`) with no recognized SDK suffix. Constructors are never sinks.
 */
export function isCatalogConstructor(dotted: string | null): boolean {
  if (!dotted) return false;
  if (matchSdkSink(dotted)) return false;
  const last = dotted.split('.').pop() ?? '';
  // A recognized PROVIDER MODEL FACTORY is a real client construction, not a
  // catalog record — `genai.GenerativeModel("gemini-1.5-pro")` selects a model.
  if (PROVIDER_MODEL_FACTORIES.has(last)) return false;
  return /^[A-Z][A-Za-z0-9]*$/.test(last);
}

/**
 * Constructors that BUILD A CLIENT BOUND TO A MODEL. These are genuine selection
 * points, unlike metadata constructors, so they are exempt from the
 * catalog-constructor rule. Kept in sync with scanPy's PY_MODEL_FACTORIES.
 */
/** Is this callee a recognized provider model factory (a real selection point)? */
export function isProviderModelFactory(dotted: string | null): boolean {
  if (!dotted) return false;
  return PROVIDER_MODEL_FACTORIES.has(dotted.split('.').pop() ?? '');
}

export const PROVIDER_MODEL_FACTORIES: ReadonlySet<string> = new Set([
  'GenerativeModel',
  'ChatOpenAI',
  'ChatAnthropic',
  'ChatGoogleGenerativeAI',
  'init_chat_model',
]);

// --- G3: endpoint-specific argument rules -----------------------------------

/** Keyword names that genuinely select the request model. */
const REQUEST_MODEL_KWARGS = new Set(['model', 'model_id', 'model_name', 'deployment', 'deployment_id', 'engine']);

/**
 * Keyword names that describe or CATALOG a model rather than selecting one for a
 * request. `base_model_name` is the Dify case: a stored-credential lookup key.
 */
const CATALOG_KWARGS = new Set([
  'base_model_name', 'base_model', 'label', 'display_name', 'title', 'description',
  'pricing', 'price', 'features', 'model_type', 'model_properties', 'parameter_rules',
  'default_model', 'fallback_model', 'supported_models', 'family', 'alias',
]);

/** Is this keyword a genuine request-model argument for the given endpoint? */
export function isRequestModelKwarg(name: string, endpoint: SinkEndpoint | null): boolean {
  const n = name.toLowerCase();
  if (CATALOG_KWARGS.has(n)) return false;
  if (!REQUEST_MODEL_KWARGS.has(n)) return false;
  // `engine` is the legacy Azure/OpenAI parameter; irrelevant to newer endpoints.
  if (n === 'engine' && endpoint && !['chat', 'completions'].includes(endpoint)) return false;
  return true;
}

/** Is this keyword a catalog/metadata field (never direct model-selection proof)? */
export const isCatalogKwarg = (name: string): boolean => CATALOG_KWARGS.has(name.toLowerCase());

/** Obvious placeholders — never a real model id, never worth reporting as one. */
export const PLACEHOLDER_VALUE = /^(fake|your|example|dummy|placeholder|test|sample|xxx|<|\{\{)/i;

export const isPlaceholderValue = (v: string): boolean => PLACEHOLDER_VALUE.test(v.trim());

// --- G1: executability + AST context ----------------------------------------

export type PyContext =
  | 'function' // inside a def/lambda — executes per call
  | 'module_sdk_request' // module level, but a recognized SDK request (runs at import)
  | 'module_data' // module-level list/dict/constant/constructor — data
  | 'class_body' // class-level attribute — usually metadata
  | 'test_or_fixture';

/**
 * Where does this literal actually live?
 *
 * CORRECTION worth stating: "module level" alone does NOT mean unreachable.
 * Python executes module bodies at import, so a genuine SDK request written at
 * module scope really does fire. It is therefore capped at Tier B, not dropped to
 * C. What earns C is module-level DATA CONSTRUCTION — a list/dict of catalog
 * records, a constant, a metadata constructor.
 */
export function pyContextOf(literal: PyNode): PyContext {
  let node: PyNode | null = literal;
  let sawCall: PyNode | null = null;
  while (node) {
    const t = node.type;
    if (t === 'function_definition' || t === 'lambda') return 'function';
    if (t === 'decorated_definition' && node.childForFieldName('definition')?.type === 'function_definition') {
      return 'function';
    }
    if (t === 'class_definition') return 'class_body';
    if (t === 'call' && !sawCall) sawCall = node;
    node = node.parent;
  }
  // Module level. A recognized SDK request — or a provider model factory —
  // executes at import time, so it is REAL. Capped at review, never dropped to C.
  if (sawCall) {
    const dotted = dottedCallee(sawCall);
    const last = (dotted ?? '').split('.').pop() ?? '';
    if (matchSdkSink(dotted) || PROVIDER_MODEL_FACTORIES.has(last)) return 'module_sdk_request';
  }
  return 'module_data';
}

/**
 * Is the literal sitting inside a COLLECTION DISPLAY (list/dict/set/tuple) before
 * any statement boundary? That is data construction.
 *
 * This is the line between `LLM_BASE_MODELS = [AzureBaseModel(...), …]` (a
 * catalog — data) and `MODEL_NAME = "gpt-4"` (a module-level CONSTANT that a
 * function below feeds to a real SDK call). The second must keep flowing through
 * the existing sink rule; only the first is unconditionally data.
 */
export function inCollectionDisplay(literal: PyNode): boolean {
  let node: PyNode | null = literal.parent;
  while (node) {
    const t = node.type;
    if (t === 'list' || t === 'dictionary' || t === 'set' || t === 'tuple') return true;
    if (t === 'expression_statement' || t === 'assignment' || t === 'module' || t === 'block') return false;
    node = node.parent;
  }
  return false;
}

/** The nearest enclosing `call` node, if any. */
export function enclosingCall(literal: PyNode): PyNode | null {
  let node: PyNode | null = literal.parent;
  while (node) {
    if (node.type === 'call') return node;
    // Stop at statement boundaries — a call further out is not "enclosing" this arg.
    if (node.type === 'block' || node.type === 'module' || node.type === 'function_definition') return null;
    node = node.parent;
  }
  return null;
}

// --- G4: provider-surface attribution ---------------------------------------

export type PySurface =
  | 'direct'
  | 'azure_openai'
  | 'openai_compatible_proxy'
  | 'openrouter'
  | 'aws_bedrock'
  | 'google_vertex'
  | 'unknown_wrapper';

/** The maximum tier each surface may reach (G4). Only `direct` can be Tier A. */
export const SURFACE_MAX_TIER: Record<PySurface, 'A' | 'B'> = {
  direct: 'A',
  azure_openai: 'B',
  openai_compatible_proxy: 'B',
  openrouter: 'B',
  aws_bedrock: 'B',
  google_vertex: 'B',
  unknown_wrapper: 'B',
};

const PROXY_HOSTS = /(cometapi|deerapi|aihubmix|openrouter|together\.xyz|groq\.com|fireworks\.ai|deepinfra|siliconflow|moonshot|dashscope|localhost|127\.0\.0\.1)/i;

/**
 * Infer the provider surface for a file from its path, imports, client
 * construction and any base_url override. Deliberately conservative: anything
 * that smells non-first-party caps the tier at B.
 */
export function detectPySurface(file: string, text: string): PySurface {
  const p = file.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(azure|azure_openai)(\/|_|$)/.test(p) || /AzureOpenAI\s*\(|api_version\s*=/.test(text)) {
    return 'azure_openai';
  }
  if (/(^|\/)(bedrock|sagemaker)(\/|_|$)/.test(p) || /boto3\.client\(\s*["']bedrock/.test(text)) return 'aws_bedrock';
  if (/(^|\/)(vertex|vertex_ai)(\/|_|$)/.test(p) || /aiplatform|vertexai/.test(text)) return 'google_vertex';
  if (/(^|\/)openrouter(\/|_|$)/.test(p) || /openrouter\.ai/i.test(text)) return 'openrouter';
  if (PROXY_HOSTS.test(p) || PROXY_HOSTS.test(text)) return 'openai_compatible_proxy';
  // A base_url / api_base sourced from credentials or env is operator-overridable:
  // the namespace is not provably the vendor's.
  if (/(base_url|api_base|endpoint_url)\s*=\s*(credentials|config|os\.environ|os\.getenv|self\.)/i.test(text)) {
    return 'openai_compatible_proxy';
  }
  if (/OAICompat|OpenAICompatible|openai_api_compatible/i.test(text)) return 'openai_compatible_proxy';

  // FAIL CLOSED. `direct` is the only surface that permits Tier A, so it must be
  // EARNED by positive evidence that this file builds/imports a first-party
  // client. Defaulting to `direct` let four attacks through: a call on an untyped
  // parameter, a client pulled out of a dict, a method chain that merely LOOKS
  // like the SDK path, and a locally-shadowed `create`. In each the client type is
  // unresolved — and an unresolved client must reduce authority, not grant it.
  return hasDirectClientEvidence(text) ? 'direct' : 'unknown_wrapper';
}

/**
 * Positive evidence that this file imports or constructs a FIRST-PARTY provider
 * client. Azure is excluded deliberately — it is matched earlier and is its own
 * surface.
 *
 * WEAK BY CONSTRUCTION: this is whole-file TEXT, so it cannot say WHICH object
 * the call is made on. It is retained only as a fast negative filter. Tier A is
 * decided by {@link resolveReceiverSurface}, which binds the actual receiver.
 * Relying on this alone let a single unused import — or the word "openai" inside
 * a DOCSTRING — confer Tier A on a call whose client is a function parameter.
 */
export function hasDirectClientEvidence(text: string): boolean {
  return (
    /\bfrom\s+openai\s+import\b|\bimport\s+openai\b|\bOpenAI\s*\(|\bAsyncOpenAI\s*\(/.test(text) ||
    /\bfrom\s+anthropic\s+import\b|\bimport\s+anthropic\b|\bAnthropic\s*\(|\bAsyncAnthropic\s*\(/.test(text) ||
    /\bfrom\s+google\s+import\s+genai\b|\bimport\s+google\.generativeai\b|\bgenai\.Client\s*\(|\bGenerativeModel\s*\(/.test(text)
  );
}

// --- receiver-bound surface resolution --------------------------------------

/** Which provider family a sink belongs to. A receiver must MATCH it. */
export type ProviderFamily = 'openai' | 'anthropic' | 'google';

const SINK_FAMILY: Record<string, ProviderFamily> = {
  'chat.completions.create': 'openai', 'chat.completions.parse': 'openai',
  'responses.create': 'openai', 'responses.parse': 'openai',
  'completions.create': 'openai', 'images.generate': 'openai', 'images.edit': 'openai',
  'embeddings.create': 'openai', 'audio.speech.create': 'openai',
  'audio.transcriptions.create': 'openai', 'audio.translations.create': 'openai',
  'messages.create': 'anthropic', 'messages.stream': 'anthropic',
  'models.generate_content': 'google', 'models.generate_content_stream': 'google',
  'models.count_tokens': 'google', 'models.embed_content': 'google',
};

export const sinkFamily = (suffix: string): ProviderFamily | null => SINK_FAMILY[suffix] ?? null;

/** First-party client constructors, by family. Azure/Bedrock/Vertex are NOT here. */
const CLIENT_CTOR_FAMILY: Record<string, ProviderFamily> = {
  OpenAI: 'openai', AsyncOpenAI: 'openai',
  Anthropic: 'anthropic', AsyncAnthropic: 'anthropic',
  Client: 'google', GenerativeModel: 'google',
};

/**
 * The RECEIVER of a sink call: the dotted segments preceding the matched suffix.
 * `client.chat.completions.create` -> `client`; `self._c.messages.create` -> `self._c`.
 */
export function receiverOf(dotted: string, suffix: string): string | null {
  if (!dotted.endsWith(suffix)) return null;
  const head = dotted.slice(0, dotted.length - suffix.length).replace(/\.$/, '');
  return head.length > 0 ? head : null;
}

function rootOf(node: PyNode): PyNode {
  let n: PyNode = node;
  while (n.parent) n = n.parent;
  return n;
}

/**
 * Resolve what a receiver name is BOUND to, in this file.
 *
 * Returns the provider family only when the name has EXACTLY ONE binding whose
 * right-hand side is a first-party constructor with no base_url/api_base override.
 * Anything else — a function parameter, a subscript, a call result, a name bound
 * more than once, or no binding at all — is unresolved, and unresolved must
 * reduce authority.
 */
export function resolveReceiverSurface(
  literal: PyNode,
  receiver: string,
): { family: ProviderFamily } | null {
  const root = rootOf(literal);
  let found: ProviderFamily | null = null;
  let bindings = 0;

  for (const assign of root.descendantsOfType('assignment')) {
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || !right) continue;
    if (left.text.replace(/\s+/g, '') !== receiver) continue;
    bindings++;
    if (right.type !== 'call') continue;
    const dotted = dottedCallee(right);
    if (!dotted) continue;
    const ctor = dotted.split('.').pop() ?? '';
    const family = CLIENT_CTOR_FAMILY[ctor];
    if (!family) continue;
    // A base_url / api_base override means the namespace is not provably the
    // vendor's — that is a proxy surface, not `direct`.
    const args = right.childForFieldName('arguments');
    if (args && /\b(base_url|api_base|endpoint|endpoint_url)\s*=/.test(args.text)) continue;
    found = family;
  }
  // Exactly one binding, and it resolved to a first-party constructor.
  return bindings === 1 && found ? { family: found } : null;
}
