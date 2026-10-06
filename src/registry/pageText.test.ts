import { describe, expect, it } from 'vitest';
import { normalizePageText, quoteIsOnPage } from './pageText.js';

// The sentence Anthropic publishes in its Opus 5.5 migration guide, in the two forms the page is
// served in (HTML and Markdown), read 2026-10-05.
const SENTENCE =
  'Setting temperature, top_p, or top_k to any non-default value on Claude Opus 4.7 and later models, including Claude Opus 5.5, returns a 400 error.';
const HTML =
  '<p><strong>Sampling parameters removed:</strong> Setting <code>temperature</code>, <code>top_p</code>, or <code>top_k</code> to any non-default value on Claude Opus 4.7 and later models, including Claude Opus 5.5, returns a 400 error.</p>';
const MARKDOWN =
  '**Sampling parameters removed:** Setting `temperature`, `top_p`, or `top_k` to any non-default value on Claude Opus 4.7 and later models, including Claude Opus 5.5, returns a 400 error.';

describe('quoteIsOnPage: one sentence, whatever markup it is served in', () => {
  it('finds the sentence in the HTML page', () => {
    expect(quoteIsOnPage(SENTENCE, HTML)).toBe(true);
  });

  it('finds the same sentence in the Markdown page', () => {
    expect(quoteIsOnPage(SENTENCE, MARKDOWN)).toBe(true);
  });

  it('is word for word: a paraphrase does not match', () => {
    expect(quoteIsOnPage(SENTENCE.replace('returns a 400 error', 'is rejected'), HTML)).toBe(false);
    expect(quoteIsOnPage(SENTENCE.replace('Opus 4.7', 'Opus 4.8'), HTML)).toBe(false);
  });

  it('decodes entities and curly quotes the same way on both sides', () => {
    expect(quoteIsOnPage("the model's behavior", '<p>Use prompting to guide the model&#x27;s behavior.</p>')).toBe(true);
    expect(quoteIsOnPage("the model's behavior", 'Use prompting to guide the model’s behavior.')).toBe(true);
  });

  it('matches a table row quoted with " | " against the HTML row and the Markdown row alike', () => {
    const quote = 'llama-3.1-70b-versatile | 2026-12-20 | llama-3.3-70b-versatile';
    expect(quoteIsOnPage(quote, '<tr><td>llama-3.1-70b-versatile</td><td>2026-12-20</td><td>llama-3.3-70b-versatile</td></tr>')).toBe(true);
    expect(quoteIsOnPage(quote, '| llama-3.1-70b-versatile | 2026-12-20 | llama-3.3-70b-versatile |')).toBe(true);
    // Cells in another order are another row.
    expect(quoteIsOnPage('2026-12-20 | llama-3.1-70b-versatile', '<tr><td>llama-3.1-70b-versatile</td><td>2026-12-20</td></tr>')).toBe(false);
  });

  it('reads through a Markdown escape: the page\'s `\\$1.00` is "$1.00"', () => {
    // The quote starts before the "$", so it matches only if the backslash is read through.
    expect(quoteIsOnPage('rerank-english-v2.0 | $1.00 / 1K searches', '| 2025-04-30 | `rerank-english-v2.0` | \\$1.00 / 1K searches |')).toBe(true);
  });

  it('never matches an empty quote', () => {
    expect(quoteIsOnPage('   ', HTML)).toBe(false);
  });

  it('ignores script and style content entirely', () => {
    expect(normalizePageText('<script>returns a 400 error</script><p>ok</p>')).toBe('ok');
  });
});

describe('a quote stays inside one row, and inside one section', () => {
  const HTML_ROWS = '<table><tr><td>model-a</td><td>2025-04-30</td></tr><tr><td>model-b</td><td>2025-05-31</td></tr></table>';
  const MD_ROWS = '| Model | Date |\n| --- | --- |\n| model-a | 2025-04-30 |\n| model-b | 2025-05-31 |';

  it('puts each row on its own line and drops the Markdown separator row', () => {
    expect(normalizePageText(HTML_ROWS)).toBe('model-a 2025-04-30\nmodel-b 2025-05-31');
    expect(normalizePageText(MD_ROWS)).toBe('Model Date\nmodel-a 2025-04-30\nmodel-b 2025-05-31');
  });

  it('never matches a quote that runs from one row into the next', () => {
    for (const page of [HTML_ROWS, MD_ROWS]) {
      expect(quoteIsOnPage('model-a 2025-04-30', page)).toBe(true);
      expect(quoteIsOnPage('2025-04-30 model-b', page)).toBe(false);
    }
  });

  it('never matches a quote that carries two rows itself, even when both rows are on the page', () => {
    expect(quoteIsOnPage('| model-a | 2025-04-30 |\n| model-b | 2025-05-31 |', MD_ROWS)).toBe(false);
  });

  it('never matches a quote that runs into the next section', () => {
    const md = 'Retired: model-a.\n\n### 2025-05-31: Model B\n\nmodel-b is retired.';
    expect(quoteIsOnPage('### 2025-05-31: Model B model-b is retired.', md)).toBe(true);
    expect(quoteIsOnPage('model-a. ### 2025-05-31', md)).toBe(false);
    expect(quoteIsOnPage('model-a. 2025-05-31', '<p>Retired: model-a.</p><h3>2025-05-31: Model B</h3>')).toBe(false);
  });

  it('keeps a list under its sentence on one line, so the sentence and its items can be quoted together', () => {
    expect(normalizePageText('Retiring on 2026-04-04:\n\n* `model-a`\n* `model-b`')).toBe('Retiring on 2026-04-04: model-a model-b');
  });
});
