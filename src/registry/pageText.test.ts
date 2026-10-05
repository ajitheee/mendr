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

  it('never matches an empty quote', () => {
    expect(quoteIsOnPage('   ', HTML)).toBe(false);
  });

  it('ignores script and style content entirely', () => {
    expect(normalizePageText('<script>returns a 400 error</script><p>ok</p>')).toBe('ok');
  });
});
