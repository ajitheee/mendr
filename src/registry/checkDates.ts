// The weekly literal check: every shutdown date the registry ships must be
// written on the provider's own page, against that exact model id.
//
// `verified` on a registry entry says the REPLACEMENT is listed in a public
// catalog. It never looked at the claim a customer acts on: THIS id stops
// serving on THIS date. On 2026-10-04 four entries carried a date the provider
// never wrote (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro` on 2026-12-11:
// OpenAI retires only the dated snapshots that day and names no alias), each
// stamped verified and auto-appliable. Nothing failed.
//
// The page is read through readModelRows, the parser discovery uses, so the
// two can never disagree about what a provider wrote. This module fetches
// nothing and writes nothing: the caller hands in the rows it read.

import type { LlmModelIdDeprecation, LlmRegistry } from '../types.js';
import { canonicalizeId } from './normalize.js';
import {
  DISCOVER_PROVIDERS,
  parseShutdownDate,
  PROVIDER_SOURCES,
  type DiscoverProvider,
  type ModelRowFact,
} from './discover.js';

export type DateVerdict =
  /** The page has a row naming this id with this date. */
  | 'confirmed'
  /**
   * A past date the page no longer lists (providers prune rows after the
   * shutdown), quoted from that page by the entry's own stored evidence.
   */
  | 'was-stated'
  /**
   * A past date for an id the provider never names, inferred from a snapshot
   * the page DOES state with that date (`inferredFrom`). Past only: the
   * snapshot is gone, so calls fail today; that is a report, not a forecast.
   */
  | 'inferred'
  /** The page names this id, but only with other dates. */
  | 'date-differs'
  /** The page names this id, in rows that state no date. */
  | 'date-unstated'
  /** A future date inferred rather than stated. The provider decides an alias's future. */
  | 'inferred-future'
  /** The entry cites this page, and nothing on it, nor in the entry's evidence, supports the date. */
  | 'absent'
  /** Nothing this check can test: no date claimed, or a page it does not read. */
  | 'unchecked';

/** Verdicts that fail the weekly job: the registry states a date the page does not. */
export const FAILING_VERDICTS: ReadonlySet<DateVerdict> = new Set([
  'date-differs',
  'date-unstated',
  'inferred-future',
  'absent',
]);

/** Every date written anywhere in a quoted row, cell by cell. */
function datesIn(text: string): Set<string> {
  const dates = new Set<string>();
  for (const cell of text.split('|')) {
    const date = parseShutdownDate(cell);
    if (date !== undefined) dates.add(date);
  }
  return dates;
}

/** Does `text` name `id` as a whole token (not as a prefix of a longer id)? */
function namesId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9.-])${escaped}([^a-z0-9.-]|$)`, 'i').test(text);
}

export interface DateCheck {
  entryId: string;
  provider: string;
  deprecated: string;
  claimedDate?: string;
  verdict: DateVerdict;
  /** Every date the page gives this id, in page order. */
  pageDates: string[];
  /**
   * Set only on a confirmed date: the page names a replacement for this id on
   * that date and the registry's is not among them. A warning, not a failure:
   * the registry retargets some old rows off replacements that have since died.
   */
  replacementOnPage?: string[];
  reason: string;
}

/** The provider's deprecations page, compared without a #fragment or trailing slash. */
function samePage(a: string | undefined, b: string): boolean {
  const clean = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '');
  return a !== undefined && clean(a) === clean(b);
}

/**
 * Check every model-id entry's shutdown date against the rows read off its
 * provider's page. `pages` holds the rows per provider that was read; a
 * provider missing from it is reported `unchecked`, and the CLI treats that as
 * a run that could not finish rather than a pass. `today` (YYYY-MM-DD) is
 * injected, never read from the clock, so a run is reproducible: it decides
 * which dates are past, and only a past date may rest on an inference or on a
 * row the provider has since removed.
 */
export function checkDates(
  registry: LlmRegistry,
  pages: Partial<Record<DiscoverProvider, readonly ModelRowFact[]>>,
  today: string,
): DateCheck[] {
  const results: DateCheck[] = [];
  for (const entry of registry) {
    if (entry.kind !== 'model_id') continue;
    const e = entry as LlmModelIdDeprecation;
    const base = {
      entryId: e.entryId ?? `${e.provider}.${e.deprecated}`,
      provider: e.provider,
      deprecated: e.deprecated,
      claimedDate: e.shutdownDate,
    };
    const unchecked = (reason: string): DateCheck => ({ ...base, verdict: 'unchecked', pageDates: [], reason });

    if (e.shutdownDate === undefined) {
      results.push(unchecked('claims no shutdown date'));
      continue;
    }
    if (!(DISCOVER_PROVIDERS as readonly string[]).includes(e.provider)) {
      results.push(unchecked(`no deprecation page is read for provider "${e.provider}"`));
      continue;
    }
    const provider = e.provider as DiscoverProvider;
    const facts = pages[provider];
    if (facts === undefined) {
      results.push(unchecked(`${provider}'s deprecation page could not be read this run`));
      continue;
    }

    const id = canonicalizeId(e.deprecated);
    const naming = facts.filter((f) => f.deprecatedIds.some((d) => canonicalizeId(d) === id));
    const pageDates = [...new Set(naming.map((f) => f.shutdownDate).filter((d): d is string => d !== undefined))];
    const page = PROVIDER_SOURCES[provider];

    if (naming.length === 0) {
      const past = e.shutdownDate < today;
      const failing = (verdict: DateVerdict, reason: string): DateCheck => ({ ...base, verdict, pageDates, reason });

      if (e.inferredFrom !== undefined) {
        if (!past) {
          results.push(
            failing(
              'inferred-future',
              `${e.shutdownDate} is inferred from ${e.inferredFrom}, not stated; a future retirement must be stated by the provider`,
            ),
          );
          continue;
        }
        const source = canonicalizeId(e.inferredFrom);
        const stated = facts.some(
          (f) => f.shutdownDate === e.shutdownDate && f.deprecatedIds.some((d) => canonicalizeId(d) === source),
        );
        results.push(
          stated
            ? {
                ...base,
                verdict: 'inferred',
                pageDates,
                reason: `${page} never names ${e.deprecated}; it states ${e.inferredFrom}, which it pointed to, with ${e.shutdownDate}`,
              }
            : failing('absent', `inferred from ${e.inferredFrom}, which ${page} does not state with ${e.shutdownDate}`),
        );
        continue;
      }

      // A past row the provider has since pruned, still quoted by the entry's
      // stored evidence from that very page. A FUTURE row that vanished is not
      // accepted this way: the provider may have withdrawn the retirement.
      const quoted =
        past &&
        (e.evidence ?? []).some(
          (ref) =>
            samePage(ref.sourceUrl, page) &&
            ref.excerpt !== undefined &&
            namesId(ref.excerpt, e.deprecated) &&
            datesIn(ref.excerpt).has(e.shutdownDate!),
        );
      if (quoted) {
        results.push({
          ...base,
          verdict: 'was-stated',
          pageDates,
          reason: `${page} no longer lists ${e.deprecated}; the entry's evidence quotes it stating ${e.shutdownDate}`,
        });
        continue;
      }

      results.push(
        samePage(e.sourceUrl, page)
          ? failing('absent', `cites ${page}, which names ${e.deprecated} in no row`)
          : unchecked(
              `cites ${e.sourceUrl ?? 'no source'}, a page this check does not read, and ${page} does not name it`,
            ),
      );
      continue;
    }
    if (pageDates.includes(e.shutdownDate)) {
      const sameDay = naming.filter((f) => f.shutdownDate === e.shutdownDate);
      const named = [...new Set(sameDay.flatMap((f) => f.replacementIds))];
      const differs =
        named.length > 0 && !named.some((r) => canonicalizeId(r) === canonicalizeId(e.replacement));
      results.push({
        ...base,
        verdict: 'confirmed',
        pageDates,
        ...(differs ? { replacementOnPage: named } : {}),
        reason: `${page} names ${e.deprecated} with ${e.shutdownDate}`,
      });
      continue;
    }
    results.push(
      pageDates.length === 0
        ? {
            ...base,
            verdict: 'date-unstated',
            pageDates,
            reason: `${page} names ${e.deprecated} only in rows that state no date`,
          }
        : {
            ...base,
            verdict: 'date-differs',
            pageDates,
            reason: `${page} gives ${e.deprecated} ${pageDates.join(', ')}, not ${e.shutdownDate}`,
          },
    );
  }
  return results;
}
