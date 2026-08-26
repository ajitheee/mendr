// The active-model catalog — loader + integrity validator.
//
// Mirrors the deprecation registry's two-gate discipline (see candidates.ts and
// validateRegistry.ts) but for a DIFFERENT semantic: a record here asserts "this
// id is live with these capabilities", not "this id is dying". So it gets its own
// loader/validator pair rather than routing through loadLlmRegistry (whose
// VALID_KINDS would reject it), and its trust is provenance PER FIELD, not a
// four-field auto-apply gate.
//
//   LOADER  (loadActiveModels)     — hard-errors on a malformed SHAPE, fail-closed.
//   VALIDATOR (validateActiveModels) — pure integrity check the CI gate runs; it
//                                      also cross-checks the deprecation registry so
//                                      the catalog can never recommend a dying id.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRegistryAsset } from '../usage/llmRegistry.js';
import { activeEntryIdFor } from './activeEntryId.js';
import type { ActiveModel, EndpointFamily, Provenanced } from './types.js';

const ACTIVE_MODELS_RELATIVE = join('registries', 'llm-active-models.json');

const VALID_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'google']);
const VALID_LIFECYCLES: ReadonlySet<string> = new Set(['active', 'preview']);
const VALID_ENDPOINTS: ReadonlySet<EndpointFamily> = new Set<EndpointFamily>([
  'chat_completions',
  'responses',
  'messages',
  'gemini_generate',
]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Walk up from this module's directory to find the catalog on disk. */
export function resolveActiveModelsPath(): string {
  return resolveRegistryAsset(ACTIVE_MODELS_RELATIVE);
}

// --- shape guards (loader) --------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Assert one `Provenanced<T>` field, checking the value type and the provenance. */
function assertProvenanced<T>(
  raw: unknown,
  path: string,
  valueOk: (v: unknown) => v is T,
): Provenanced<T> {
  if (!isRecord(raw)) throw new Error(`active model field "${path}" is missing or not an object`);
  if (!valueOk(raw.value)) throw new Error(`active model field "${path}.value" has the wrong type`);
  if (typeof raw.source !== 'string') throw new Error(`active model field "${path}.source" must be a string`);
  if (typeof raw.checkedAt !== 'string') throw new Error(`active model field "${path}.checkedAt" must be a string`);
  return { value: raw.value, source: raw.source, checkedAt: raw.checkedAt };
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * Validate one catalog record's SHAPE and return the typed value. Hard-errors —
 * a malformed record is rejected outright, never half-read as trusted (the same
 * posture as the deprecation loader's parseVerification).
 */
export function assertActiveModel(raw: unknown, index: number): ActiveModel {
  const where = `active model #${index}`;
  if (!isRecord(raw)) throw new Error(`${where} is not an object`);

  if (!isStr(raw.provider) || !VALID_PROVIDERS.has(raw.provider)) {
    throw new Error(`${where} has an invalid "provider": ${String(raw.provider)}`);
  }
  if (!isStr(raw.modelId) || raw.modelId.length === 0) {
    throw new Error(`${where} has a missing/invalid "modelId"`);
  }
  if (!isStr(raw.lifecycle) || !VALID_LIFECYCLES.has(raw.lifecycle)) {
    throw new Error(`${where} ("${raw.modelId}") has an invalid "lifecycle": ${String(raw.lifecycle)}`);
  }
  if (!isStr(raw.entryId) || raw.entryId.length === 0) {
    throw new Error(`${where} ("${raw.modelId}") has a missing/invalid "entryId"`);
  }

  const caps = raw.capabilities;
  if (!isRecord(caps)) throw new Error(`${where} ("${raw.modelId}") has a missing "capabilities"`);
  const capabilities: ActiveModel['capabilities'] = {
    tools: assertProvenanced(caps.tools, `${raw.modelId}.capabilities.tools`, isBool),
    jsonStrict: assertProvenanced(caps.jsonStrict, `${raw.modelId}.capabilities.jsonStrict`, isBool),
    streaming: assertProvenanced(caps.streaming, `${raw.modelId}.capabilities.streaming`, isBool),
    vision: assertProvenanced(caps.vision, `${raw.modelId}.capabilities.vision`, isBool),
    reasoning: assertProvenanced(caps.reasoning, `${raw.modelId}.capabilities.reasoning`, isBool),
    contextTokens: assertProvenanced(caps.contextTokens, `${raw.modelId}.capabilities.contextTokens`, isNum),
    maxOutputTokens: assertProvenanced(caps.maxOutputTokens, `${raw.modelId}.capabilities.maxOutputTokens`, isNum),
  };

  const endpoint = assertProvenanced(
    raw.endpoint,
    `${raw.modelId}.endpoint`,
    (v): v is EndpointFamily => isStr(v) && VALID_ENDPOINTS.has(v as EndpointFamily),
  );

  const price = raw.price;
  if (!isRecord(price)) throw new Error(`${where} ("${raw.modelId}") has a missing "price"`);
  if (price.currency !== 'USD') throw new Error(`${where} ("${raw.modelId}") price.currency must be "USD"`);
  const priceOut: ActiveModel['price'] = {
    inputPerMTok: assertProvenanced(price.inputPerMTok, `${raw.modelId}.price.inputPerMTok`, isNum),
    outputPerMTok: assertProvenanced(price.outputPerMTok, `${raw.modelId}.price.outputPerMTok`, isNum),
    currency: 'USD',
  };

  const avail = raw.availability;
  if (!isRecord(avail)) throw new Error(`${where} ("${raw.modelId}") has a missing "availability"`);
  // regions is either a provenanced string[] OR the sanctioned {value:'unknown'} sentinel.
  let regions: ActiveModel['availability']['regions'];
  if (isRecord(avail.regions) && avail.regions.value === 'unknown' && !('source' in avail.regions)) {
    regions = { value: 'unknown' };
  } else {
    regions = assertProvenanced(avail.regions, `${raw.modelId}.availability.regions`, isStrArr);
  }
  const availability: ActiveModel['availability'] = {
    regions,
    requiresPreviewAccess: assertProvenanced(
      avail.requiresPreviewAccess,
      `${raw.modelId}.availability.requiresPreviewAccess`,
      isBool,
    ),
    minAccountTier: assertProvenanced(
      avail.minAccountTier,
      `${raw.modelId}.availability.minAccountTier`,
      isNullableStr,
    ),
  };

  return {
    entryId: raw.entryId,
    provider: raw.provider as ActiveModel['provider'],
    modelId: raw.modelId,
    lifecycle: raw.lifecycle as ActiveModel['lifecycle'],
    capabilities,
    endpoint,
    price: priceOut,
    availability,
  };
}

/**
 * Load and validate the catalog's SHAPE. Same hard-error posture as the
 * deprecation loader: a malformed record throws rather than being half-read.
 */
export function loadActiveModels(explicitPath?: string): ActiveModel[] {
  const path = explicitPath ?? resolveActiveModelsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read/parse the active-model catalog at ${path}: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`active-model catalog at ${path} must be a JSON array`);
  }
  return parsed.map(assertActiveModel);
}

// --- integrity validator (CI gate) ------------------------------------------

export type ActiveModelViolationCode =
  | 'missing_field_source'
  | 'missing_field_checked_at'
  | 'invalid_lifecycle'
  | 'missing_entry_id'
  | 'entry_id_mismatch'
  | 'duplicate_entry_id'
  | 'active_id_is_deprecated';

export interface ActiveModelViolation {
  entryId: string;
  code: ActiveModelViolationCode;
  message: string;
}

export interface ActiveModelValidation {
  recordsChecked: number;
  violations: ActiveModelViolation[];
}

/** Every provenanced field on a record, with a dotted name for the message. */
function provenancedFields(m: ActiveModel): Array<{ name: string; field: Provenanced<unknown> }> {
  const out: Array<{ name: string; field: Provenanced<unknown> }> = [
    { name: 'capabilities.tools', field: m.capabilities.tools },
    { name: 'capabilities.jsonStrict', field: m.capabilities.jsonStrict },
    { name: 'capabilities.streaming', field: m.capabilities.streaming },
    { name: 'capabilities.vision', field: m.capabilities.vision },
    { name: 'capabilities.reasoning', field: m.capabilities.reasoning },
    { name: 'capabilities.contextTokens', field: m.capabilities.contextTokens },
    { name: 'capabilities.maxOutputTokens', field: m.capabilities.maxOutputTokens },
    { name: 'endpoint', field: m.endpoint },
    { name: 'price.inputPerMTok', field: m.price.inputPerMTok },
    { name: 'price.outputPerMTok', field: m.price.outputPerMTok },
    { name: 'availability.requiresPreviewAccess', field: m.availability.requiresPreviewAccess },
    { name: 'availability.minAccountTier', field: m.availability.minAccountTier },
  ];
  // The regions `{ value: 'unknown' }` sentinel is the sanctioned no-provenance
  // escape hatch (mirrors CapabilityCheck's catalogValue: 'unknown'); it is
  // exempt from the source/checkedAt requirement. A provenanced regions IS checked.
  if ('source' in m.availability.regions) {
    out.push({ name: 'availability.regions', field: m.availability.regions });
  }
  return out;
}

/**
 * Check every catalog record. Returns ALL violations (not first-fail), like
 * validateRegistry. Pure over its inputs: `deprecatedIds` is the set of `deprecated`
 * ids from the deprecation registry, passed in so this stays clock/fs/network-free.
 */
export function validateActiveModels(
  catalog: readonly ActiveModel[],
  deprecatedIds: ReadonlySet<string>,
): ActiveModelValidation {
  const violations: ActiveModelViolation[] = [];
  const add = (entryId: string, code: ActiveModelViolationCode, message: string): void => {
    violations.push({ entryId, code, message });
  };
  const byId = new Map<string, ActiveModel[]>();

  for (const m of catalog) {
    const id = m.entryId || activeEntryIdFor(m);

    for (const { name, field } of provenancedFields(m)) {
      if (!field.source?.trim()) {
        add(id, 'missing_field_source', `field "${name}" has an empty "source" — every catalog fact must name where it came from`);
      }
      if (!ISO_DATE_RE.test(field.checkedAt ?? '')) {
        add(id, 'missing_field_checked_at', `field "${name}" has a missing/invalid ISO "checkedAt": ${String(field.checkedAt)}`);
      }
    }

    if (!VALID_LIFECYCLES.has(m.lifecycle)) {
      add(id, 'invalid_lifecycle', `lifecycle "${m.lifecycle}" is not one of active | preview`);
    }

    const derived = activeEntryIdFor(m);
    if (!m.entryId) {
      add(id, 'missing_entry_id', `record has no "entryId" — expected "${derived}"`);
    } else if (m.entryId !== derived) {
      add(id, 'entry_id_mismatch', `entryId "${m.entryId}" does not match the derived id "${derived}" — the id is generated, not chosen`);
    }

    if (deprecatedIds.has(m.modelId)) {
      add(id, 'active_id_is_deprecated', `modelId "${m.modelId}" is listed as a deprecated id in the deprecation registry — the catalog may never recommend a model that registry says is dying`);
    }

    byId.set(id, [...(byId.get(id) ?? []), m]);
  }

  for (const [id, claimants] of byId) {
    if (claimants.length < 2) continue;
    for (const _ of claimants) {
      add(id, 'duplicate_entry_id', `entryId "${id}" is claimed by ${claimants.length} records — an id that names two records cannot look either up`);
    }
  }

  return { recordsChecked: catalog.length, violations };
}

/** Render a validation result for a terminal (mirrors formatValidation). */
export function formatActiveModelValidation(result: ActiveModelValidation): string[] {
  const { recordsChecked, violations } = result;
  if (violations.length === 0) {
    return [`active-model catalog OK: 0 violations across ${recordsChecked} records.`];
  }
  const lines = [`active-model catalog INVALID: ${violations.length} violation(s):`, ''];
  for (const v of violations) {
    lines.push(`  ${v.entryId}`);
    lines.push(`    [${v.code}] ${v.message}`);
  }
  return lines;
}
