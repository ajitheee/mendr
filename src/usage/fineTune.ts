import type { LlmModelIdDeprecation } from '../types.js';
import { modelMatches } from './llmRegistry.js';

// FINE-TUNED MODEL IDS, in one place for the usage audit and both source scanners.
//
// OpenAI names a fine-tuned model `ft:<base>:<org>:<suffix>:<job id>` (the suffix is often
// empty: `ft:gpt-3.5-turbo-0125:acme::9abc`), and retires fine-tunes in deprecation rows of their
// own, spelled `ft-<base>`. Those rows do not share the base model's date: babbage-002 shut down
// on 2026-09-28, while its fine-tunes run until 2026-10-23.
//
// The usage audit has joined an observed fine-tune to its row since v0.5.9-alpha. The source
// scanners did not look for one at all: `create({ model: 'ft:gpt-3.5-turbo-0125:acme::9abc' })`
// matched no registry value, so `audit` concluded no exposure and `fix-llm` printed "Nothing to
// fix". Both now resolve a fine-tune through the same rule, below.
//
// A fine-tune is never swapped. Every replacement the registry names is a base model, and
// putting a base model where a fine-tune was drops the training the customer paid for.

/** How OpenAI's deprecations page names a row that retires fine-tunes: `ft-<base>`. */
export const FINE_TUNE_ROW_PREFIX = 'ft-';

/**
 * The base model of a fine-tune AS A PROVIDER REPORTS IT (`ft:<base>:<org>::<id>` gives
 * `<base>`), or undefined when the string is not one.
 *
 * Loose on purpose: a usage API only reports model ids, so anything it reports with this prefix
 * is a fine-tune. A string in source code is not known to be a model id, so the scanners use
 * {@link sourceFineTuneBase} instead.
 */
export function reportedFineTuneBase(raw: string): string | undefined {
  const ft = /^ft:([^:]+):/.exec(raw);
  return ft ? ft[1] : undefined;
}

/**
 * The whole shape of a fine-tuned model id: `ft:`, a base model id, the organisation, the
 * suffix (often empty), the job id, and optionally the `ckpt-step-<n>` a checkpoint adds.
 * Anchored at both ends, so a string that merely contains `ft:` (a sentence, a log line, a
 * `draft:` key, an id with a space or a fifth free-form segment) is not one.
 */
const SOURCE_FINE_TUNE_ID =
  /^ft:([a-z0-9][a-z0-9._-]*):[A-Za-z0-9._-]*:[A-Za-z0-9._-]*:[A-Za-z0-9]+(?::ckpt-step-\d+)?$/;

/**
 * The base model of a fine-tuned model id WRITTEN IN SOURCE CODE, or undefined when the whole
 * string is not one. Strict, unlike {@link reportedFineTuneBase}: the value must be nothing but
 * a fine-tune id, so text that only contains one never matches.
 */
export function sourceFineTuneBase(value: string): string | undefined {
  const m = SOURCE_FINE_TUNE_ID.exec(value);
  return m ? m[1] : undefined;
}

/**
 * The registry id a fine-tune of `base` joins.
 *
 * A fine-tune joins its base model, unless the provider retires fine-tunes of that base in a row
 * of their own. A row names a base model or a family of snapshots, so `ft-gpt-3.5-turbo` covers
 * a fine-tune of `gpt-3.5-turbo-1106`, by the exact-segment rule parameter rules use
 * ({@link modelMatches}): `ft-gpt-4` covers `gpt-4-0613` but never `gpt-4o-2024-08-06`. The most
 * specific row wins. `provider` is the provider that reported the fine-tune, or `'unknown'` to
 * accept a row of any provider (source code names no provider).
 */
export function fineTuneRowId(
  base: string,
  provider: string,
  entries: readonly LlmModelIdDeprecation[],
): string {
  let row: string | undefined;
  for (const e of entries) {
    if (!e.deprecated.startsWith(FINE_TUNE_ROW_PREFIX)) continue;
    if (e.provider !== provider && provider !== 'unknown') continue;
    if (!modelMatches(base, [e.deprecated.slice(FINE_TUNE_ROW_PREFIX.length)])) continue;
    if (row === undefined || e.deprecated.length > row.length) row = e.deprecated;
  }
  return row ?? base;
}

/** A fine-tuned model id found in source code, with the registry records it joins. */
export interface SourceFineTune {
  /** The base model the id names, e.g. `gpt-3.5-turbo-0125`. */
  base: string;
  /** Every registry record for the row it joins: its `ft-` row, or its base model's. */
  records: LlmModelIdDeprecation[];
}

/**
 * Resolve a string from source code that may be a fine-tuned model id: undefined unless the whole
 * value is one AND the registry has a row for it, found by {@link fineTuneRowId} with no provider
 * filter. `byValue` is the scanner's own index of records by their `deprecated` id.
 */
export function resolveSourceFineTune(
  value: string,
  byValue: ReadonlyMap<string, LlmModelIdDeprecation[]>,
  entries: readonly LlmModelIdDeprecation[],
): SourceFineTune | undefined {
  const base = sourceFineTuneBase(value);
  if (base === undefined) return undefined;
  const records = byValue.get(fineTuneRowId(base, 'unknown', entries));
  return records ? { base, records } : undefined;
}

/**
 * The sentence a held fine-tune carries in both scanners: what the id is, why mendr leaves it,
 * and what a person does instead.
 */
export function fineTuneHoldReason(value: string, base: string, replacement: string): string {
  return (
    `${value} is a fine-tune of ${base}, so mendr never swaps it: replacing it with ${replacement} ` +
    `would drop the customer's training. Fine-tune a current model on the same data, or accept ` +
    `${replacement} without the training, and change the id by hand.`
  );
}

/**
 * Every substring a file holding a fine-tune of a registry row must contain: `ft:<family>` for
 * each `ft-<family>` row. For the registry pre-filter, which tests raw file text: the row id
 * itself (`ft-gpt-4`) never appears in a fine-tune id (`ft:gpt-4-0613:acme::x`).
 */
export function fineTuneTextTokens(entries: readonly LlmModelIdDeprecation[]): string[] {
  return entries
    .filter((e) => e.deprecated.startsWith(FINE_TUNE_ROW_PREFIX))
    .map((e) => `ft:${e.deprecated.slice(FINE_TUNE_ROW_PREFIX.length)}`);
}
