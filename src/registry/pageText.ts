// One normalization for "is this sentence on that page?", shared by every literal check.
//
// Provider docs ship the same sentence as HTML (`Setting <code>temperature</code>, ...`) and as
// Markdown (`Setting \`temperature\`, ...`). A literal check has to see through both without
// becoming fuzzy, so the page and the quote go through the SAME steps and are then compared as
// plain substrings: markup and emphasis removed, entities decoded, whitespace collapsed, and the
// space a removed tag leaves before punctuation taken back out. Nothing is stemmed, reordered or
// paraphrased; a quote that is not on the page, word for word, does not match.
//
// One piece of structure survives the flattening: every table ROW, and the start of every section,
// is a line break no quote can cross. Flattened, a table reads as one run of text, and a quote could
// start in one row and end in the next: "rerank-v3.5 2025-04-30 rerank-multilingual-v2.0" is
// contiguous on Cohere's page once the rows are joined, and pairs a replacement with the next row's
// shutdown date. A quote is normalized the same way and never keeps a line break, so it can only
// ever match inside one row, or inside one section's prose.

/** Marks a row or section boundary while the text is flattened; becomes a line break at the end. */
const BREAK = '\u001e';

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&rdquo;': '"',
  '&ldquo;': '"',
};

/**
 * Normalize a page (HTML or Markdown) or a quote into the form literal checks compare: one line per
 * table row, and per run of prose up to the next heading.
 */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // HTML: a row starts and ends a line; a heading starts one.
    .replace(/<\/?tr\b[^>]*>|<h[1-6]\b[^>]*>/gi, BREAK)
    // Markdown: a pipe-table row is its own line, and its |---|---| separator carries no text.
    .replace(/^[ \t]*\|.*$/gm, (row) => (/^[\s|:-]+$/.test(row) ? BREAK : `${BREAK}${row}${BREAK}`))
    // Markdown: a heading starts a line.
    .replace(/^[ \t]*#{1,6}[ \t]/gm, (heading) => `${BREAK}${heading}`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // A Markdown escape renders as the character itself: the page's `\$1.00` reads "$1.00".
    .replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
    .replace(/[*`]/g, '')
    // A table row is quoted with its cells joined by " | " (Markdown writes them that way too);
    // flattened HTML separates the same cells with whitespace. Read a pipe as a cell boundary.
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:)!?])/g, '$1')
    .replace(/\( /g, '(')
    .replace(/ ?\u001e[ \u001e]*/g, '\n')
    .trim();
}

/** Does the quote, normalized, run across a table row or into another section? */
export function quoteCrossesRows(quote: string): boolean {
  return normalizePageText(quote).includes('\n');
}

/**
 * Is `quote`, word for word, on `page`, inside one row or one section? Both are normalized the
 * same way first; a quote that crosses a row boundary is never on the page.
 */
export function quoteIsOnPage(quote: string, page: string): boolean {
  const q = normalizePageText(quote);
  return q.length > 0 && !q.includes('\n') && normalizePageText(page).includes(q);
}
