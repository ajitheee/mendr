// The weekly literal check for PARAMETER rules: every sentence a rule quotes must still be on
// the provider's page, word for word.
//
// A parameter rule edits a customer's request (renames `max_tokens`, deletes `temperature`), so it
// is held to the same standard as a shutdown date: the provider said it, on a page anyone can open,
// and it is still there. The four rules shipped before 2026-10-05 had a note and no source, and
// three notes read "VERIFY the exact model set against Anthropic's live docs before production".
//
// Pure: the caller fetches the pages and hands in their text, so tests need no network.

import type { LlmParamDeprecation, LlmRegistry, ParamQuote } from '../types.js';
import { quoteIsOnPage } from './pageText.js';

export type QuoteVerdict =
  /** The sentence is on the page. */
  | 'confirmed'
  /** The page was read and the sentence is not on it. */
  | 'missing'
  /** The page could not be read this run: not a pass, and not a failure of the rule. */
  | 'unread';

export interface QuoteCheck {
  sourceUrl: string;
  about: ParamQuote['about'];
  text: string;
  verdict: QuoteVerdict;
}

export interface RuleCheck {
  /** `<provider>.<kind>.<param>`, the id the validator reports a rule under. */
  rule: string;
  /** No `rule` quote at all: nothing shows the provider ever said it. */
  unquoted: boolean;
  quotes: QuoteCheck[];
}

function paramRules(registry: LlmRegistry): LlmParamDeprecation[] {
  return registry.filter(
    (e): e is LlmParamDeprecation => e.kind === 'param_rename' || e.kind === 'param_removal',
  );
}

/** Every page some rule quotes, once each, in first-seen order: what the caller must fetch. */
export function rulePageUrls(registry: LlmRegistry): string[] {
  return [...new Set(paramRules(registry).flatMap((r) => (r.quotes ?? []).map((q) => q.sourceUrl)))];
}

/**
 * Judge every quote of every parameter rule against the page it cites. `pages` maps a URL to the
 * page's raw text, or to `undefined` when the page could not be fetched.
 */
export function checkRules(registry: LlmRegistry, pages: ReadonlyMap<string, string | undefined>): RuleCheck[] {
  return paramRules(registry).map((rule) => {
    const quotes = (rule.quotes ?? []).map((q): QuoteCheck => {
      const page = pages.get(q.sourceUrl);
      const verdict: QuoteVerdict =
        page === undefined ? 'unread' : quoteIsOnPage(q.text, page) ? 'confirmed' : 'missing';
      return { sourceUrl: q.sourceUrl, about: q.about, text: q.text, verdict };
    });
    return {
      rule: `${rule.provider}.${rule.kind}.${rule.param}`,
      unquoted: !quotes.some((q) => q.about === 'rule'),
      quotes,
    };
  });
}

/** Does this result fail the weekly job? A sentence gone from its page, or a rule with none. */
export function ruleCheckFails(check: RuleCheck): boolean {
  return check.unquoted || check.quotes.some((q) => q.verdict === 'missing');
}
