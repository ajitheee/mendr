// Config / IaC LOCATE scan (integration shape #1) — the pair to usage-audit.
//
// usage-audit MEASURES ("you run gpt-4 in prod for $1,284"); this LOCATES ("gpt-4
// is set in helm/values-prod.yaml:8"). It extends mendr's exact-value, classify-
// by-structure discipline from code to configuration: yaml/json/toml/ini/.env,
// Helm, compose, Dockerfile. A deprecated id is a LIVE SELECTOR only when it is
// the exact scalar value of a model-like key (`model: gpt-4`); an id sitting in a
// list, as a map key, or in a catalog map is DATA (Tier C) — the same catalog-
// corruption guard the code scanner enforces. Config is NEVER Tier A: it can't be
// typechecked or tested and one file fans out to many deployments, so a selector
// is always Tier B (review), never an unattended swap.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { displayEntryId } from '../registry/entryId.js';
import { effectiveVerificationState, modelIdEntries } from '../usage/llmRegistry.js';
import { isModelLikeName } from '../usage/scanLiterals.js';
import type { Tier } from '../report/tiers.js';

/** Where a deprecated id sits in config. */
export type ConfigPosition = 'config_selector' | 'config_catalog';

/** Why a catalog occurrence is data (parallels the code scanner's DataPurpose). */
export type ConfigPurpose =
  | 'lookup_key'
  | 'list_entry'
  | 'catalog_entry'
  | 'generic'
  | 'catalog_definition'
  | 'data_fixture';

/**
 * The provider SURFACE a config file belongs to. A model id under a non-direct
 * surface (Bedrock, Vertex, Azure, an OpenAI-compatible proxy) must NOT be given
 * a direct-provider replacement — it is a different runtime.
 */
export type ProviderSurface =
  | 'aws_bedrock'
  | 'google_vertex'
  | 'azure_openai'
  | 'openrouter'
  | 'provider_ambiguous' // OpenAI-compatible custom proxies (cometapi/deerapi/aihubmix)
  | null; // direct/first-party or unknown

/** One deprecated model id found in a config file. */
export interface ConfigMatch {
  file: string;
  line: number; // 1-based
  column: number; // 1-based, at the id
  /** The leaf key on the line (`model`, `OPENAI_MODEL`), or null for a bare/list value. */
  key: string | null;
  value: string; // the matched id (=== deprecation.deprecated)
  deprecation: LlmModelIdDeprecation;
  position: ConfigPosition;
  purpose?: ConfigPurpose;
  /** config_selector -> 'B' (review), config_catalog -> 'C'. Never 'A'. */
  tier: Tier;
  /** The provider surface of the file (null = direct/first-party or unknown). */
  providerSurface: ProviderSurface;
  /** Why this occurrence was classified as it was — an auditable verdict. */
  signals?: ClassificationSignal[];
}

// --- catalog-definition + provider-surface detection (Dify P0) --------------

/** Keys that mark a file as a model-DEFINITION catalog, not a runtime config. */
const CATALOG_DEF_KEYS = ['label', 'model_type', 'features', 'model_properties', 'parameter_rules', 'pricing'];

/**
 * Is this a model-DEFINITION catalog file (one file per model id, describing its
 * label/features/parameters/pricing) rather than a runtime selector config? A
 * root `model:` field in such a file names the model the file DEFINES; it does
 * not prove that model is selected or receiving traffic. Detected by path shape
 * (provider model-directory) OR by >=2 catalog-definition sibling keys.
 */
export function isCatalogDefinitionFile(file: string, text: string): boolean {
  return isCatalogDefinitionPath(file) || hasCatalogDefinitionKeys(text);
}

/**
 * A path shape meaning "this file IS one model's definition" — a provider model
 * directory. STRONG: the root `model:` here names the file's subject, so it may
 * legitimately demote even a runtime-route key.
 */
export function isCatalogDefinitionPath(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  // Dify-style provider model directories: models/<provider>/models/llm/*.yaml,
  // .../model_configurations/*.yaml, etc.
  if (/(^|\/)models\/[^/]+\/models\//i.test(p)) return true;
  if (/\/model_configurations\//i.test(p)) return true;
  return false;
}

/**
 * Catalog-describing keys somewhere in the file. WEAK and CONTEXTUAL: a mixed
 * file can hold a live `default_model:` at the top AND a priced catalog below, so
 * this must never demote a top-level runtime route — it applies only to
 * occurrences that are not themselves runtime routes.
 */
export function hasCatalogDefinitionKeys(text: string): boolean {
  let signals = 0;
  for (const key of CATALOG_DEF_KEYS) {
    if (new RegExp(`(^|\\n)\\s*${key}\\s*:`, 'i').test(text)) signals++;
    if (signals >= 2) return true;
  }
  return false;
}

/** Detect the provider surface from the file path. */
export function detectProviderSurface(file: string): ProviderSurface {
  const p = file.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(bedrock|aws_bedrock|sagemaker)(\/|$)/.test(p)) return 'aws_bedrock';
  if (/(^|\/)(vertex|vertex_ai|google_vertex)(\/|$)/.test(p)) return 'google_vertex';
  if (/(^|\/)(azure|azure_openai)(\/|$)/.test(p)) return 'azure_openai';
  if (/(^|\/)openrouter(\/|$)/.test(p)) return 'openrouter';
  if (/(^|\/)(cometapi|deerapi|aihubmix|openai_api_compatible|openai-compatible)(\/|$)/.test(p)) {
    return 'provider_ambiguous';
  }
  return null;
}

/**
 * Is this a TEST / DATA fixture whose model ids are serialized DATA — chat
 * exports, import fixtures, mocks, eval logs — rather than a runtime selector?
 *
 * Real repos ship these by the hundred (e.g. LibreChat's
 * `api/server/utils/import/__data__/*.json`, where `model_slug: "gpt-4"` records
 * which model produced an EXPORTED message). Treating them as live selectors
 * floods the review bucket with un-actionable noise around the one genuine
 * selector. This mirrors the code scanner's test-file skip, but here we DEMOTE
 * to a Tier-C `data_fixture` (still visible as exposure) rather than dropping —
 * an audit should still SHOW the id, just never flag it as a thing to change.
 */
/**
 * The id count at which a file starts to LOOK like a catalog.
 *
 * This is a WEAK signal on purpose. A production router that fans out to ten
 * models is a completely ordinary config, and treating density as proof of
 * "catalog" would silently downgrade ten real selectors to informational — a
 * false negative, which is far worse than noise. Density therefore only
 * contributes to `catalog_likely`; it can never, on its own, override an
 * occurrence that is shaped like a selector. See {@link classifyOccurrenceWithSignals}.
 */
export const CATALOG_DENSITY_HINT = 8;

/** Why an occurrence was classified as it was. Recorded so a verdict is auditable. */
export type ClassificationSignal =
  | 'generated_output' // mendr's own output — hard override
  | 'artifact_path' // build/report/coverage directory — hard override
  | 'fixture_path' // examples/docs/samples/test data
  | 'catalog_definition_file' // the file DEFINES models (label/pricing/parameter_rules…)
  | 'model_keyed_block' // the id is also the map key of the block it sits in
  | 'catalog_density' // many distinct ids in one file (WEAK, never decisive alone)
  | 'selector_key' // a model-like key whose value is exactly the id
  | 'ui_metadata_key' // the key names UI/presentation metadata (placeholder, hint, label), never a selection
  | 'alias_key' // router model_list: `model_name` is the client alias; the sibling litellm_params.model selects
  | 'mock_markers' // the file carries fake keys / mock flags — a test fixture, whatever its path
  | 'gitignored' // the repo's own .gitignore names this file: a local/dev artifact, not deployed config
  | 'runtime_route_key' // a key naming a runtime route/selection
  | 'lookup_key' // the id IS the key
  | 'list_entry'
  | 'embedded_value';

/**
 * Keys that carry UI / presentation METADATA — the grey text in a form field, a
 * hint, a label — never a runtime selection, however model-like the key looks.
 * Partner audits (2026-09-04): litellm's `default_model_placeholder` produced
 * 120 review candidates from one form-schema file.
 */
const UI_METADATA_KEYS = /(placeholder|_hint$|^hint$|tooltip|help_?text|_label$|^label$|_description$|^description$|display_?name|_example$|^example_)/i;

/** Keys that name a RUNTIME SELECTION rather than a catalog record. */
const RUNTIME_ROUTE_KEYS =
  /^(model|model_name|model_id|default_model|fallback_model|primary_model|chat_model|llm_model|completion_model|embedding_model|summarize_model|reasoning_model|planner_model|router_model|deployment_model)$/i;

/**
 * Sibling keys that mark a block as RUNTIME configuration — an api key, a base
 * url, sampling parameters. Their presence is evidence FOR a selector, and is
 * what keeps a ten-model router from being read as a catalog.
 */
const RUNTIME_CONTEXT_KEYS = [
  'api_key', 'apikey', 'api_base', 'base_url', 'endpoint', 'temperature', 'max_tokens',
  'top_p', 'timeout', 'stream', 'system_prompt', 'route', 'routes', 'upstream', 'weight',
];

/** Does this file read like live runtime configuration? */
export function hasRuntimeContext(text: string): boolean {
  let hits = 0;
  for (const k of RUNTIME_CONTEXT_KEYS) {
    if (new RegExp(`(^|\\n)\\s*["']?${k}["']?\\s*[:=]`, 'i').test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export function isTestFixturePath(file: string): boolean {
  const p = file.replace(/\\/g, '/').toLowerCase();
  // Generated-output and example/demo trees are DATA, never runtime selectors.
  if (/(^|\/)(test-results?|test-output|playwright-report|allure-results|coverage|reports?|artifacts|\.mendr)(\/)/.test(p)) return true;
  if (/(^|\/)(examples?|samples?|demos?|docs?|cookbooks?|benchmarks?|templates?|example[_-]?configs?[^/]*|sample[_-]?configs?[^/]*)(\/)/.test(p)) return true;
  // TEMPLATE files are not active configuration: `.env.example`, `.env.sample`,
  // `config.example.yaml`, `settings-template.json`. Partner audits (2026-09-04):
  // mem0's `.env.example` was reported as a runtime selector.
  if (/(^|\/)\.env\.(example|sample|template|dist|default|local\.example)$/.test(p)) return true;
  if (/(^|\/)[^/]*[._-](example|sample|template|dist)\.[^/]+$/.test(p)) return true;
  if (/(^|\/)[^/]*[._-](example|sample|template)$/.test(p)) return true;
  // `example_config.yaml`, `sample-settings.json`: the name starts with the word.
  if (/(^|\/)(example|sample|template)[._-][^/]*\.[^/]+$/.test(p)) return true;
  // A test/fixture/mock DIRECTORY anywhere in the path.
  if (/(^|\/)(__data__|__fixtures?__|__mocks?__|fixtures?|test-fixtures?|testdata|test-data|mocks?|snapshots?|__snapshots__)(\/)/.test(p)) return true;
  if (/(^|\/)(tests?|e2e|specs?|__tests__)(\/)/.test(p)) return true;
  // A `*.test.*` / `*.spec.*` / `*.fixture.*` / `*.mock.*` FILE.
  if (/(^|\/)[^/]*\.(test|spec|fixture|mock)\.[^/]+$/.test(p)) return true;
  // `model-switch-test-config.yaml`, `foo-test-settings.json`: a config file that names itself as test data.
  if (/(^|\/)[^/]*-test-(config|settings?|env)\.[^/]+$/.test(p)) return true;
  // A JSON Schema (`config_schema.json`, `*.schema.json`) DESCRIBES config; its
  // `default`/`examples` values are documentation, not a live selector.
  if (/(^|\/)[^/]*schema[^/]*\.json$/.test(p)) return true;
  return false;
}

const CONFIG_EXT = /\.(ya?ml|json|json5|toml|ini|cfg|conf|properties|env)$/i;

/**
 * Directories holding GENERATED output, never hand-authored runtime config.
 *
 * This list exists because of a real, embarrassing failure: mendr scanned its own
 * saved report (`test-results/dify-config-scan.json`), read the `"model": "gpt-4"`
 * fields INSIDE its own findings as runtime selectors, and reported 75 false
 * exposures. Generated output must never become input — the loop is
 * self-amplifying, and every run makes the next one worse.
 */
const CONFIG_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__',
  // build output
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', 'target',
  // report / artifact output
  'coverage', 'test-results', 'test-output', 'playwright-report', 'allure-results',
  '.nyc_output', '.pytest_cache', 'reports', 'artifacts',
  // mendr's own working directory
  '.mendr',
]);

/**
 * A marker mendr writes into every JSON document it generates. The scanner
 * refuses any file carrying it, WHEREVER it sits — a report copied to the repo
 * root, committed as a fixture, or renamed is still mendr output, and a directory
 * list alone cannot catch that.
 */
export const GENERATED_BY_MARKER = '"generatedBy": "mendr"';

/** Schema ids mendr stamps on its own machine-readable output. */
const MENDR_SCHEMA_MARKERS = [
  '"generatedBy":"mendr"',
  GENERATED_BY_MARKER,
  '"schema": "mendr-',
  '"schema":"mendr-',
];

/**
 * Is this file something MENDR produced? Checked against the head of the file, so
 * a huge report costs one small read rather than a full parse.
 */
export function isMendrGeneratedOutput(text: string): boolean {
  const head = text.slice(0, 4096);
  return MENDR_SCHEMA_MARKERS.some((m) => head.includes(m));
}

function isConfigFileName(name: string): boolean {
  if (CONFIG_EXT.test(name)) return true;
  if (/^\.env(\..+)?$/.test(name)) return true; // .env, .env.local, ...
  if (/^Dockerfile/i.test(name)) return true;
  if (/^(docker-)?compose\.ya?ml$/i.test(name)) return true;
  return false;
}

/** Every config/IaC file under `repoPath` (excluding vendored/build dirs). */
export function collectConfigFiles(repoPath: string, seenExcluded?: Set<string>): string[] {
  const abs = resolve(repoPath);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CONFIG_EXCLUDED_DIRS.has(entry.name)) seenExcluded?.add(entry.name);
        else walk(full);
      } else if (entry.isFile() && isConfigFileName(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

/** A boundaried, whole-token matcher for one exact id (so "gpt-4" never matches "gpt-4o"). */
function idMatcher(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`, 'g');
}

const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
const stripComment = (s: string): string => s.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '');

/** Parse a line's leaf key + the column just past its `:`/`=` separator. */
function parseKey(line: string): { key: string; sepEnd: number } | null {
  const colon = /^(\s*(?:-\s*)?)(["']?)([A-Za-z0-9_.\-]+)\2\s*:/.exec(line);
  if (colon) return { key: colon[3], sepEnd: colon[0].length };
  const eq = /^(\s*(?:export\s+)?)([A-Za-z0-9_.\-]+)\s*=/.exec(line);
  if (eq) return { key: eq[2], sepEnd: eq[0].length };
  return null;
}

/**
 * Classify one id occurrence on one line. Conservative: `config_selector` (Tier B)
 * only when a model-like key's value is EXACTLY the id; everything else is
 * `config_catalog` (Tier C). Accuracy over recall, as everywhere in mendr.
 */
export function classifyConfigOccurrence(
  line: string,
  idCol: number, // 0-based
  id: string,
): { position: ConfigPosition; purpose?: ConfigPurpose; key: string | null } {
  const parsed = parseKey(line);
  const isListItem = /^\s*-\s+/.test(line);

  if (parsed) {
    // The id sits BEFORE the separator => it IS the key (a map key / catalog entry).
    if (idCol < parsed.sepEnd) {
      return { position: 'config_catalog', purpose: 'lookup_key', key: parsed.key };
    }
    // Strip a trailing JSON/YAML comma before the exact-scalar check.
    const value = stripQuotes(stripComment(line.slice(parsed.sepEnd)).replace(/,\s*$/, ''));
    if (value === id) {
      // key: <exactly the id> — a scalar selector iff the key is model-like.
      return isModelLikeName(parsed.key)
        ? { position: 'config_selector', key: parsed.key }
        : { position: 'config_catalog', purpose: 'catalog_entry', key: parsed.key };
    }
    // key: [gpt-4, ...] or a larger value — the id is embedded, not the whole value.
    return { position: 'config_catalog', purpose: 'catalog_entry', key: parsed.key };
  }

  if (isListItem) {
    const value = stripQuotes(stripComment(line.replace(/^\s*-\s+/, '')));
    return { position: 'config_catalog', purpose: 'list_entry', key: null };
  }
  return { position: 'config_catalog', purpose: 'generic', key: null };
}

const tierOf = (p: ConfigPosition): Tier => (p === 'config_selector' ? 'B' : 'C');

/** File-level evidence, computed once, fed into every occurrence decision. */
export interface FileSignals {
  fixturePath: boolean;
  /** STRONG: the path says this file defines a model. Demotes even a route key. */
  catalogDefinitionPath: boolean;
  /** WEAK: catalog keys exist somewhere. Never demotes a runtime route. */
  catalogKeys: boolean;
  /** Many distinct deprecated ids — a HINT only. */
  dense: boolean;
  /** The file carries api keys / urls / sampling params — it is live config. */
  runtimeContext: boolean;
}

/**
 * Is the id ALSO the map key of the block this line sits in?
 *
 *   gpt-4:
 *     model: gpt-4      <-- this
 *     pricing: …
 *
 * That inner `model:` restates the block's subject; it defines the record rather
 * than selecting a model. This is a STRUCTURAL signal, not a statistical one, so
 * it is allowed to override a selector shape.
 */
/**
 * Do the SIBLINGS of this line (same indent, same block) describe a model record?
 *
 * This is what separates a catalog definition from a live selector without a
 * file-wide verdict: in `pricing.yaml` the `model:` key sits beside `label:` and
 * `pricing:`, so the block DEFINES a model; in a mixed file a top-level
 * `default_model:` sits beside `api_key:` and `base_url:`, so it SELECTS one —
 * even though a priced catalog appears further down the same file.
 */
function hasCatalogSiblings(lines: readonly string[], index: number): boolean {
  const indentOf = (s: string): number => s.search(/\S/);
  const own = indentOf(lines[index]);
  if (own < 0) return false;
  let hits = 0;
  const scan = (from: number, step: number): void => {
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const ind = indentOf(l);
      if (ind < own) break; // left the block
      if (ind > own) continue; // nested deeper — not a sibling
      const m = /^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*:/.exec(l);
      if (m && CATALOG_DEF_KEYS.includes(m[1].toLowerCase())) hits++;
    }
  };
  scan(index - 1, -1);
  scan(index + 1, 1);
  return hits >= 2;
}

/** Does the block that contains line `index` have a sibling key named `key`? */
function hasSiblingKey(lines: readonly string[], index: number, key: string): boolean {
  const indentOf = (s: string): number => s.search(/\S/);
  // A YAML list item (`  - model_name: x`) puts its siblings two columns deeper.
  const own = indentOf(lines[index]) + (/^\s*-\s/.test(lines[index]) ? 2 : 0);
  if (own < 0) return false;
  const scan = (from: number, step: number): boolean => {
    for (let i = from, n = 0; i >= 0 && i < lines.length && n < 80; i += step, n++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const ind = indentOf(l);
      if (ind < own) break;
      if (ind > own) continue;
      const m = /^\s*-?\s*["']?([A-Za-z0-9_.\-]+)["']?\s*:/.exec(l);
      if (m && m[1].toLowerCase() === key) return true;
    }
    return false;
  };
  return scan(index - 1, -1) || scan(index + 1, 1);
}

function inModelKeyedBlock(lines: readonly string[], index: number, id: string): boolean {
  const indent = (s: string): number => s.search(/\S/);
  const own = indent(lines[index]);
  if (own <= 0) return false;
  for (let i = index - 1; i >= 0 && i > index - 400; i--) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = indent(l);
    if (ind >= own) continue;
    // The nearest enclosing key. Is it this exact id?
    const m = /^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*:/.exec(l);
    return m ? m[1] === id : false;
  }
  return false;
}

/**
 * Classify ONE occurrence using every available signal.
 *
 * The ordering is the whole point:
 *   1. HARD overrides (mendr's own output, build/report artifacts, fixtures) —
 *      these files are not customer configuration at all.
 *   2. STRUCTURE of the occurrence itself (map key / list entry / embedded /
 *      exact scalar under a model-like key). This is what actually decides.
 *   3. STRUCTURAL file evidence (a model-definition catalog, or the id being the
 *      enclosing block's own key) may demote a selector-shaped occurrence.
 *   4. DENSITY may demote only in the ABSENCE of runtime context and only when it
 *      is not a runtime-route key — never on its own.
 */
export function classifyOccurrenceWithSignals(
  line: string,
  idCol: number,
  id: string,
  file: FileSignals,
  lines: readonly string[] = [],
  index = -1,
): { position: ConfigPosition; purpose?: ConfigPurpose; key: string | null; signals: ClassificationSignal[] } {
  const base = classifyConfigOccurrence(line, idCol, id);
  const signals: ClassificationSignal[] = [];

  // 1. Hard override: a fixture / artifact / generated file is DATA, always.
  if (file.fixturePath) {
    return { position: 'config_catalog', purpose: 'data_fixture', key: base.key, signals: ['fixture_path'] };
  }

  // 2. The occurrence is not selector-shaped — record why and stop.
  if (base.position !== 'config_selector') {
    if (base.purpose === 'lookup_key') signals.push('lookup_key');
    else if (base.purpose === 'list_entry') signals.push('list_entry');
    else signals.push('embedded_value');
    if (file.dense) signals.push('catalog_density');
    if (file.catalogDefinitionPath || file.catalogKeys) signals.push('catalog_definition_file');
    return { ...base, signals };
  }

  // From here the occurrence IS selector-shaped: `<model-like key>: <exact id>`.
  signals.push('selector_key');
  // A placeholder / hint / label key is presentation, not selection — whatever
  // the value looks like.
  if (base.key !== null && UI_METADATA_KEYS.test(base.key)) {
    return { position: 'config_catalog', purpose: 'catalog_entry', key: base.key, signals: [...signals, 'ui_metadata_key'] };
  }
  // Router `model_list` idiom (litellm, others): `model_name` is the client-facing
  // ALIAS; the provider selector is the sibling `litellm_params.model`. Reporting
  // the alias doubled every entry and mislabeled the alias as the selection.
  if (base.key !== null && /^model_name$/i.test(base.key) && index >= 0 && hasSiblingKey(lines, index, 'litellm_params')) {
    return { position: 'config_catalog', purpose: 'catalog_entry', key: base.key, signals: [...signals, 'alias_key'] };
  }
  // An entry pointing at a fake model / fake key is a stub, whatever the file is.
  if (index >= 0 && blockHasMockMarker(lines, index)) {
    return { position: 'config_catalog', purpose: 'data_fixture', key: base.key, signals: [...signals, 'mock_markers'] };
  }
  const isRuntimeRoute = base.key !== null && RUNTIME_ROUTE_KEYS.test(base.key);
  if (isRuntimeRoute) signals.push('runtime_route_key');
  if (file.dense) signals.push('catalog_density');

  // 3. Structural demotions. A model-definition catalog file, or an id that is
  //    the enclosing block's own key, DEFINES the model rather than selecting it.
  if (file.catalogDefinitionPath) {
    return { position: 'config_catalog', purpose: 'catalog_definition', key: base.key, signals: [...signals, 'catalog_definition_file'] };
  }
  // The id is the enclosing block's own key: this line DEFINES that record.
  if (index >= 0 && inModelKeyedBlock(lines, index, id)) {
    return { position: 'config_catalog', purpose: 'catalog_definition', key: base.key, signals: [...signals, 'model_keyed_block'] };
  }
  // The occurrence's OWN BLOCK describes a model record (label/pricing/features
  // siblings): this line defines the model rather than selecting it. Sibling-
  // scoped, so a live `default_model:` elsewhere in the same file is untouched.
  if (index >= 0 && hasCatalogSiblings(lines, index)) {
    return { position: 'config_catalog', purpose: 'catalog_definition', key: base.key, signals: [...signals, 'catalog_definition_file'] };
  }
  // Catalog keys somewhere in the file, and this is not a runtime route key.
  if (file.catalogKeys && !isRuntimeRoute) {
    return { position: 'config_catalog', purpose: 'catalog_definition', key: base.key, signals: [...signals, 'catalog_definition_file'] };
  }

  // 4. Density may demote ONLY when nothing else says "runtime": not a route key,
  //    and no runtime context in the file. Density alone never wins.
  if (file.dense && !isRuntimeRoute && !file.runtimeContext) {
    return { position: 'config_catalog', purpose: 'catalog_entry', key: base.key, signals };
  }

  return { ...base, signals };
}

/** Scan one config file's text for deprecated ids. Pure (no fs). */
/**
 * Content markers of a TEST FIXTURE config, whatever its path: fake keys, mock
 * models, mock-testing flags. Partner audits (2026-09-04, litellm): the root
 * `proxy_server_config.yaml` is mounted only by CI and a hardening/QA compose
 * overlay and carries `dangerously_allow_mock_testing_request_params: true`,
 * `mock_timeout`, `my-fake-model`; a docker sample config points every entry at
 * `openai/fake` with `fake-key`.
 */
const FILE_MOCK_FLAGS = /\b(mock_timeout|mock_response|dangerously_allow_mock_testing\w*|FAKE_[A-Z_]*API_BASE)/i;
/** Entry-level: a fake key or a fake model inside ONE model_list entry marks that entry, not the file (a Helm chart can carry a stub entry beside a real one). */
const ENTRY_MOCK_MARKERS = /\b(fake-key|my-fake-model|openai\/fake|test-api-key)\b/i;

/** Does the whole FILE declare itself a mock/test configuration? */
export function hasMockMarkers(text: string): boolean {
  return FILE_MOCK_FLAGS.test(text);
}

/** Does the BLOCK around line `index` (its siblings and their children) carry a fake key or fake model? */
function blockHasMockMarker(lines: readonly string[], index: number): boolean {
  const indentOf = (s: string): number => s.search(/\S/);
  const own = indentOf(lines[index]) + (/^\s*-\s/.test(lines[index]) ? 2 : 0);
  if (own < 0) return false;
  const scan = (from: number, step: number): boolean => {
    // Bounded: a flat 10k-entry catalog must not make this quadratic.
    for (let i = from, n = 0; i >= 0 && i < lines.length && n < 80; i += step, n++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const ind = indentOf(l) + (/^\s*-\s/.test(l) ? 2 : 0);
      if (ind < own) break;
      if (ENTRY_MOCK_MARKERS.test(l)) return true;
    }
    return false;
  };
  return ENTRY_MOCK_MARKERS.test(lines[index]) || scan(index - 1, -1) || scan(index + 1, 1);
}

export function scanConfigText(
  file: string,
  text: string,
  registry: LlmRegistry,
  opts: { gitignored?: boolean } = {},
): ConfigMatch[] {
  const entries = modelIdEntries(registry);
  const byValue = new Map<string, LlmModelIdDeprecation[]>();
  for (const e of entries) {
    const list = byValue.get(e.deprecated);
    if (list) list.push(e);
    else byValue.set(e.deprecated, [e]);
  }
  // File-level context: a model-definition catalog file classifies EVERY match
  // as a catalog definition (Tier C) — a root `model:` there names the model the
  // file defines, not a runtime selection. Surface rides on every match.
  // FILE-LEVEL SIGNALS. None of these is a verdict on its own; they are inputs to
  // the per-occurrence decision below.
  // A fixture by PATH (examples/, templates, tests), by CONTENT (fake keys, mock
  // flags), or by the repo's own .gitignore naming it (a local/dev artifact that
  // happens to be tracked). Any one is decisive: nothing here is deployed config.
  const dataFixture = isTestFixturePath(file) || hasMockMarkers(text) || !!opts.gitignored;
  const catalogDef = isCatalogDefinitionFile(file, text);
  const surface = detectProviderSurface(file);
  let distinct = 0;
  for (const id of byValue.keys()) if (text.includes(id)) distinct++;
  const fileSignals: FileSignals = {
    fixturePath: dataFixture,
    catalogDefinitionPath: isCatalogDefinitionPath(file),
    catalogKeys: hasCatalogDefinitionKeys(text),
    dense: distinct >= CATALOG_DENSITY_HINT,
    runtimeContext: hasRuntimeContext(text),
  };
  void catalogDef;
  const lines0 = text.split(/\r?\n/);

  const out: ConfigMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [id, deps] of byValue) {
      if (!line.includes(id)) continue;
      for (const m of line.matchAll(idMatcher(id))) {
        const idCol = m.index ?? 0;
        const cls = classifyOccurrenceWithSignals(line, idCol, id, fileSignals, lines0, i);
        for (const dep of deps) {
          out.push({
            file,
            line: i + 1,
            column: idCol + 1,
            key: cls.key,
            value: id,
            deprecation: dep,
            position: cls.position,
            purpose: cls.purpose,
            tier: tierOf(cls.position),
            providerSurface: surface,
            signals: 'signals' in cls ? cls.signals : undefined,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Scan every config file under `repoPath` for deprecated model ids.
 *
 * `filesScanned` counts files COLLECTED; `filesRead` counts files successfully
 * READ. The two differ when a file is unreadable, and the caller needs the second
 * number: a scan that collected 80 files and read 0 found nothing because it read
 * nothing, which must never be reported as "no exposure".
 */
export function scanConfigFiles(repoPath: string, registry: LlmRegistry): {
  matches: ConfigMatch[];
  filesScanned: number;
  filesRead: number;
  filesUnreadable: number;
  /** Files skipped because mendr generated them (never re-ingested). */
  generatedSkipped: number;
  /** Generated-artifact directories that were PRESENT and excluded. */
  excludedDirs: string[];
} {
  const abs = resolve(repoPath);
  const excluded = new Set<string>();
  const files = collectConfigFiles(abs, excluded);
  const rel = (f: string): string => relative(abs, f).replace(/\\/g, '/');
  // The repo's own .gitignore naming a tracked file means the file is a local /
  // developer artifact, not deployed configuration (litellm's
  // `_super_secret_config.yaml`). Exact paths and basenames only — no glob
  // semantics, so this can only ever DEMOTE a file the author explicitly listed.
  const ignored = gitignoredExactPaths(abs);
  const matches: ConfigMatch[] = [];
  let filesRead = 0;
  let filesUnreadable = 0;
  let generatedSkipped = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
      filesRead++;
    } catch {
      filesUnreadable++;
      continue;
    }
    // NEVER re-ingest mendr's own output, wherever it was saved. Without this,
    // a committed report turns every finding it contains into a new "selector"
    // on the next run — a self-amplifying loop.
    if (isMendrGeneratedOutput(text)) {
      generatedSkipped++;
      continue;
    }
    const r = rel(file);
    const gitignored = ignored.has(r) || ignored.has(r.split('/').pop() ?? '');
    for (const m of scanConfigText(r, text, registry, { gitignored })) matches.push(m);
  }
  return { matches, filesScanned: files.length, filesRead, filesUnreadable, generatedSkipped, excludedDirs: [...excluded].sort() };
}

/** Exact (non-glob) entries of the root .gitignore, as repo-relative paths or bare basenames. */
export function gitignoredExactPaths(repoAbs: string): ReadonlySet<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = readFileSync(join(repoAbs, '.gitignore'), 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line)) continue;
    out.add(line.replace(/^\/+/, '').replace(/\/+$/, ''));
  }
  return out;
}

/** A found deprecated id, aggregated by model, with the registry facts and locations. */
export interface ConfigExposure {
  model: string;
  entryId: string;
  provider: string;
  replacement: string;
  replacementVerdict: string;
  shutdownDate: string | null;
  selectors: ConfigMatch[]; // Tier B — the places to actually change
  catalog: ConfigMatch[]; // Tier C — informational references
}

/** Fold matches into per-model exposure, selectors (Tier B) split from catalog (Tier C). */
export function foldConfigExposure(matches: readonly ConfigMatch[]): ConfigExposure[] {
  const byId = new Map<string, ConfigExposure>();
  for (const m of matches) {
    const entryId = displayEntryId(m.deprecation);
    let e = byId.get(entryId);
    if (!e) {
      e = {
        model: m.deprecation.deprecated,
        entryId,
        provider: m.deprecation.provider,
        replacement: m.deprecation.replacement,
        replacementVerdict: effectiveVerificationState(m.deprecation),
        shutdownDate: m.deprecation.shutdownDate ?? null,
        selectors: [],
        catalog: [],
      };
      byId.set(entryId, e);
    }
    if (m.position === 'config_selector') e.selectors.push(m);
    else e.catalog.push(m);
  }
  // Selectors first (something to change), then by model id.
  return [...byId.values()].sort((a, b) => {
    if ((a.selectors.length > 0) !== (b.selectors.length > 0)) return a.selectors.length > 0 ? -1 : 1;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}
