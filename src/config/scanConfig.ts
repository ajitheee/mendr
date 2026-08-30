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
  const p = file.replace(/\\/g, '/');
  // Dify-style provider model directories: models/<provider>/models/llm/*.yaml,
  // .../model_configurations/*.yaml, etc.
  if (/(^|\/)models\/[^/]+\/models\//i.test(p)) return true;
  if (/\/model_configurations\//i.test(p)) return true;
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
export function isTestFixturePath(file: string): boolean {
  const p = file.replace(/\\/g, '/').toLowerCase();
  // A test/fixture/mock DIRECTORY anywhere in the path.
  if (/(^|\/)(__data__|__fixtures?__|__mocks?__|fixtures?|testdata|test-data|mocks?|snapshots?)(\/)/.test(p)) return true;
  if (/(^|\/)(tests?|e2e|specs?|__tests__)(\/)/.test(p)) return true;
  // A `*.test.*` / `*.spec.*` / `*.fixture.*` / `*.mock.*` FILE.
  if (/(^|\/)[^/]*\.(test|spec|fixture|mock)\.[^/]+$/.test(p)) return true;
  return false;
}

const CONFIG_EXT = /\.(ya?ml|json|json5|toml|ini|cfg|conf|properties|env)$/i;
const CONFIG_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage', '.venv', 'venv', '__pycache__',
]);

function isConfigFileName(name: string): boolean {
  if (CONFIG_EXT.test(name)) return true;
  if (/^\.env(\..+)?$/.test(name)) return true; // .env, .env.local, ...
  if (/^Dockerfile/i.test(name)) return true;
  if (/^(docker-)?compose\.ya?ml$/i.test(name)) return true;
  return false;
}

/** Every config/IaC file under `repoPath` (excluding vendored/build dirs). */
export function collectConfigFiles(repoPath: string): string[] {
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
        if (!CONFIG_EXCLUDED_DIRS.has(entry.name)) walk(full);
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

/** Scan one config file's text for deprecated ids. Pure (no fs). */
export function scanConfigText(file: string, text: string, registry: LlmRegistry): ConfigMatch[] {
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
  // A test/data fixture demotes EVERY match to Tier-C data (a serialized model
  // id is never a runtime selector); a model-definition catalog file does the
  // same with a catalog_definition purpose. Fixture wins when both apply.
  const dataFixture = isTestFixturePath(file);
  const catalogDef = isCatalogDefinitionFile(file, text);
  const surface = detectProviderSurface(file);

  const out: ConfigMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [id, deps] of byValue) {
      if (!line.includes(id)) continue;
      for (const m of line.matchAll(idMatcher(id))) {
        const idCol = m.index ?? 0;
        const cls = dataFixture
          ? ({ position: 'config_catalog', purpose: 'data_fixture', key: parseKey(line)?.key ?? null } as const)
          : catalogDef
            ? ({ position: 'config_catalog', purpose: 'catalog_definition', key: parseKey(line)?.key ?? null } as const)
            : classifyConfigOccurrence(line, idCol, id);
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
          });
        }
      }
    }
  }
  return out;
}

/** Scan every config file under `repoPath` for deprecated model ids. */
export function scanConfigFiles(repoPath: string, registry: LlmRegistry): {
  matches: ConfigMatch[];
  filesScanned: number;
} {
  const abs = resolve(repoPath);
  const files = collectConfigFiles(abs);
  const rel = (f: string): string => relative(abs, f).replace(/\\/g, '/');
  const matches: ConfigMatch[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of scanConfigText(rel(file), text, registry)) matches.push(m);
  }
  return { matches, filesScanned: files.length };
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
