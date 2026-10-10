import { describe, it, expect } from 'vitest';
import type { LlmModelIdDeprecation } from '../types.js';
import { checkDates, FAILING_VERDICTS, type DateCheck } from './checkDates.js';
import { PROVIDER_SOURCES, readModelRows } from './discover.js';

// Hermetic: the page is fixture markup in the shape OpenAI publishes (rows
// copied from developers.openai.com/api/docs/deprecations on 2026-10-04), read
// through the same parser discovery uses. No network.

const OPENAI_PAGE = `
<table> <tr> <th>Shutdown date</th> <th>Model snapshot</th> <th>Substitute model</th> </tr>
<tr> <td>October 23, 2026</td> <td><code>o1-2024-12-17</code> | <code>o1</code></td> <td><code>gpt-5.6-sol</code></td> </tr>
<tr> <td>October 23, 2026</td> <td><code>gpt-4.1-nano</code> | <code>gpt-4.1-nano-2025-04-14</code></td> <td><code>gpt-5.6-luna</code></td> </tr>
<tr> <td>October 23, 2026</td> <td><code>gpt-image-1</code></td> <td><code>gpt-image-2.5-sunburst</code> or <code>gpt-image-2.5-flare</code></td> </tr>
</table>
<table>
<tr> <th>Shutdown date</th> <th>Model / system</th> <th>Recommended replacement</th> </tr>
<tr> <td>Dec 11, 2026</td> <td><code>gpt-5-2025-08-07</code></td> <td><code>gpt-5.6-sol</code></td> </tr>
<tr> <td>2025-07-14</td> <td><code>gpt-4.5-preview</code></td> <td><code>gpt-4.1</code></td> </tr>
</table>
<table>
<tr> <th>Model</th> <th>Recommended replacement</th> </tr>
<tr> <td><code>gpt-3.5-turbo-instruct</code></td> <td><code>gpt-5.6-terra</code></td> </tr>
</table>`;

const PAGES = { openai: readModelRows(OPENAI_PAGE, 'openai').facts };
const DEPRECATIONS = PROVIDER_SOURCES.openai;
const TODAY = '2026-10-04';

function entry(over: Partial<LlmModelIdDeprecation>): LlmModelIdDeprecation {
  return {
    provider: 'openai',
    kind: 'model_id',
    deprecated: 'o1',
    replacement: 'gpt-5.6-sol',
    status: 'deprecated',
    shutdownDate: '2026-10-23',
    sourceUrl: DEPRECATIONS,
    ...over,
  };
}

function one(over: Partial<LlmModelIdDeprecation>, pages: Parameters<typeof checkDates>[1] = PAGES): DateCheck {
  const [result] = checkDates([entry(over)], pages, TODAY);
  return result;
}

/** Evidence the way discover stores it: the row as read off a page, plus its hash. */
function quoted(excerpt: string, sourceUrl = DEPRECATIONS) {
  return [{ sourceUrl, contentHash: `sha256:${'a'.repeat(64)}`, retrievedAt: '2026-09-14T23:54:46.353Z', excerpt }];
}

describe('checkDates: the date the registry ships must be on the provider page', () => {
  it('confirms an alias the page lists beside its snapshot', () => {
    expect(one({})).toMatchObject({ verdict: 'confirmed', pageDates: ['2026-10-23'] });
  });

  it('matches the page across `.` and `-` spellings of one id', () => {
    // The page writes gpt-4.1-nano; an entry spelled with a dash is the same model.
    expect(one({ deprecated: 'gpt-4-1-nano', replacement: 'gpt-5.6-luna' }).verdict).toBe('confirmed');
  });

  it('FAILS an alias the page never names: the gpt-5 deadline that shipped verified', () => {
    // OpenAI retires gpt-5-2025-08-07 on 2026-12-11 and says nothing about `gpt-5`.
    const result = one({ deprecated: 'gpt-5', shutdownDate: '2026-12-11' });
    expect(result.verdict).toBe('absent');
    expect(result.reason).toMatch(/names gpt-5 in no row/);
  });

  it('FAILS a date the page contradicts, and says which date the page gives', () => {
    const result = one({ shutdownDate: '2026-12-11' });
    expect(result).toMatchObject({ verdict: 'date-differs', pageDates: ['2026-10-23'] });
    expect(result.reason).toMatch(/gives o1 2026-10-23, not 2026-12-11/);
  });

  it('FAILS an id the page names only in a table that states no date', () => {
    const result = one({ deprecated: 'gpt-3.5-turbo-instruct', replacement: 'gpt-5.6-terra', shutdownDate: '2026-09-28' });
    expect(result.verdict).toBe('date-unstated');
  });

  it('reads the date even when the row offers a choice of replacement, and warns on the replacement', () => {
    // Discovery refuses this row (a human picks the replacement); the DATE on it is still a fact.
    const result = one({ deprecated: 'gpt-image-1', replacement: 'gpt-image-2' });
    expect(result.verdict).toBe('confirmed');
    expect(result.replacementOnPage).toEqual(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
  });

  it('does not warn when the registry replacement is one the page names', () => {
    expect(one({}).replacementOnPage).toBeUndefined();
  });

  it("confirms a Veo date: Google's veo- ids are read off the page", () => {
    // Until 2026-10-10 the page reader dropped every veo- row, so this entry could only be
    // reported "absent" from a page that states its date.
    const google = `<table><tr><td><b>Model</b></td><td><b>Release date</b></td><td><b>Shutdown date</b></td><td><b>Recommended replacement</b></td></tr>
<tr><td><code>veo-3.1-generate-preview</code></td><td>October 15, 2025</td><td>October 22, 2026</td><td><code>gemini-omni-1.1-flash</code></td></tr></table>`;
    const result = one(
      {
        provider: 'google',
        deprecated: 'veo-3.1-generate-preview',
        replacement: 'gemini-omni-1.1-flash',
        shutdownDate: '2026-10-22',
        sourceUrl: PROVIDER_SOURCES.google,
      },
      { google: readModelRows(google, 'google').facts },
    );
    expect(result).toMatchObject({ verdict: 'confirmed', pageDates: ['2026-10-22'] });
  });

  it('does not judge an entry whose source is a page this check does not read', () => {
    const result = one({ deprecated: 'o9-imaginary', sourceUrl: 'https://developers.openai.com/api/docs/models/o9' });
    expect(result.verdict).toBe('unchecked');
    expect(result.reason).toMatch(/a page this check does not read/);
  });

  it('does not judge an entry that claims no date', () => {
    expect(one({ shutdownDate: undefined }).verdict).toBe('unchecked');
  });

  it('does not judge a provider it reads no page for', () => {
    expect(one({ provider: 'mistral', deprecated: 'mistral-large-2411' }).verdict).toBe('unchecked');
  });

  it('reports a provider whose page could not be read as unchecked, never confirmed', () => {
    expect(one({}, {}).verdict).toBe('unchecked');
    expect(one({}, {}).reason).toMatch(/could not be read this run/);
  });

  it('fails on exactly the verdicts where the registry states what the page does not', () => {
    expect([...FAILING_VERDICTS].sort()).toEqual(['absent', 'date-differs', 'date-unstated', 'inferred-future']);
  });

  it('checks only model-id entries', () => {
    const param = { provider: 'openai', kind: 'param_rename', model: 'o1', from: 'max_tokens', to: 'max_completion_tokens' };
    expect(checkDates([param as never], PAGES, TODAY)).toEqual([]);
  });
});

describe('checkDates: an inference is allowed only for a date already past', () => {
  it('accepts a past alias inferred from a snapshot the page states with that date', () => {
    // gpt-4.5 was never an API id; gpt-4.5-preview was, and shut down 2025-07-14.
    const result = one({ deprecated: 'gpt-4.5', replacement: 'gpt-4.1', shutdownDate: '2025-07-14', inferredFrom: 'gpt-4.5-preview' });
    expect(result.verdict).toBe('inferred');
  });

  it('FAILS an inference whose snapshot the page states with another date', () => {
    const result = one({ deprecated: 'gpt-4.5', shutdownDate: '2025-06-01', inferredFrom: 'gpt-4.5-preview' });
    expect(result.verdict).toBe('absent');
    expect(result.reason).toMatch(/inferred from gpt-4\.5-preview, which \S+ does not state with 2025-06-01/);
  });

  it('FAILS a future date inferred from a snapshot: the gpt-5 alias case, even when labelled', () => {
    const result = one({ deprecated: 'gpt-5', shutdownDate: '2026-12-11', inferredFrom: 'gpt-5-2025-08-07' });
    expect(result.verdict).toBe('inferred-future');
    expect(result.reason).toMatch(/a future retirement must be stated by the provider/);
  });

  it('treats a date of today as not yet past', () => {
    expect(one({ deprecated: 'gpt-4.5', shutdownDate: TODAY, inferredFrom: 'gpt-4.5-preview' }).verdict).toBe('inferred-future');
  });
});

describe('checkDates: a past row the provider has pruned, quoted by the entry itself', () => {
  // Google removes a row after the shutdown. gemini-omni-flash-preview's row was
  // captured on 2026-09-14 and is gone from the page after 2026-09-30.
  const pruned = { deprecated: 'gpt-4-32k', replacement: 'gpt-4o', shutdownDate: '2025-06-06' };

  it('accepts the date when stored evidence from that page quotes the row stating it', () => {
    const result = one({ ...pruned, evidence: quoted('gpt-4-32k | June 6, 2024 | June 6, 2025 | gpt-4o') });
    expect(result.verdict).toBe('was-stated');
  });

  it('FAILS the same pruned row when its date is still in the future: the retirement may be withdrawn', () => {
    const result = one({ ...pruned, shutdownDate: '2027-01-01', evidence: quoted('gpt-4-32k | 2026-01-01 | 2027-01-01 | gpt-4o') });
    expect(result.verdict).toBe('absent');
  });

  it('FAILS when the evidence was quoted from a different page', () => {
    const result = one({ ...pruned, evidence: quoted('gpt-4-32k | 2025-06-06 | gpt-4o', 'https://example.test/blog') });
    expect(result.verdict).toBe('absent');
  });

  it('FAILS when the quoted row states another date', () => {
    expect(one({ ...pruned, evidence: quoted('gpt-4-32k | 2025-07-01 | gpt-4o') }).verdict).toBe('absent');
  });

  it('FAILS when the quoted row names only a longer id', () => {
    expect(one({ ...pruned, evidence: quoted('gpt-4-32k-0613 | 2025-06-06 | gpt-4o') }).verdict).toBe('absent');
  });
});
