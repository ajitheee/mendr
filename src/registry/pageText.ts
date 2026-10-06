// One normalization for "is this sentence on that page?", shared by every literal check.
//
// Provider docs ship the same sentence as HTML (`Setting <code>temperature</code>, ...`) and as
// Markdown (`Setting \`temperature\`, ...`). A literal check has to see through both without
// becoming fuzzy, so the page and the quote go through the SAME steps and are then compared as
// plain substrings: markup and emphasis removed, entities decoded, whitespace collapsed, and the
// space a removed tag leaves before punctuation taken back out. Nothing is stemmed, reordered or
// paraphrased; a quote that is not on the page, word for word, does not match.

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

/** Normalize a page (HTML or Markdown) or a quote into the form literal checks compare. */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:)!?])/g, '$1')
    .replace(/\( /g, '(')
    .trim();
}

/** Is `quote`, word for word, on `page`? Both are normalized the same way first. */
export function quoteIsOnPage(quote: string, page: string): boolean {
  const q = normalizePageText(quote);
  return q.length > 0 && normalizePageText(page).includes(q);
}
