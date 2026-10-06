import { describe, expect, it } from 'vitest';
import {
  allDatesIn,
  buildPrompt,
  chatCompletionsClient,
  endpointProblem,
  readPage,
  verifyClaim,
  verifyReading,
} from './aiReader.js';

// Hermetic: a fixture page in the two shapes providers use (a sentence, a table row), and a fake
// client standing in for the model. The point under test is not the model: it is that NOTHING the
// model says survives unless the page literally supports it.

const PAGE = `
<h2>Deprecations</h2>
<p>On September 15, 2026 we will retire <code>command-r-08-2024</code>; please migrate to <code>command-a-03-2025</code>.</p>
<table>
  <tr><th>Model</th><th>Shutdown date</th><th>Recommended replacement</th></tr>
  <tr><td>llama-3.1-70b-versatile</td><td>2026-12-20</td><td>llama-3.3-70b-versatile</td></tr>
</table>
<p>Embed v2 models were retired on March 4, 2026.</p>`;

const prose = {
  deprecated: 'command-r-08-2024',
  shutdown_date: '2026-09-15',
  replacements: ['command-a-03-2025'],
  quote: 'On September 15, 2026 we will retire command-r-08-2024; please migrate to command-a-03-2025.',
};
const row = {
  deprecated: 'llama-3.1-70b-versatile',
  shutdown_date: '2026-12-20',
  replacements: ['llama-3.3-70b-versatile'],
  quote: 'llama-3.1-70b-versatile | 2026-12-20 | llama-3.3-70b-versatile',
};

describe('verifyClaim: the page decides, not the model', () => {
  it('keeps a claim whose quote is a sentence on the page, through the markup', () => {
    expect(verifyClaim(prose, PAGE)).toMatchObject({ deprecated: 'command-r-08-2024', replacements: ['command-a-03-2025'] });
  });

  it('keeps a claim whose quote is a table row', () => {
    expect(verifyClaim(row, PAGE)).toMatchObject({ shutdownDate: '2026-12-20' });
  });

  it('REJECTS an invented id: it has no sentence on the page to point to', () => {
    const invented = { ...prose, deprecated: 'command-r-plus-99', quote: 'We will retire command-r-plus-99 on September 15, 2026.' };
    expect(verifyClaim(invented, PAGE)).toMatchObject({ why: 'quote is not on the page, word for word' });
  });

  it('REJECTS a paraphrased quote, even when the facts are right', () => {
    const paraphrase = { ...prose, quote: 'command-r-08-2024 retires on September 15, 2026.' };
    expect(verifyClaim(paraphrase, PAGE)).toMatchObject({ why: 'quote is not on the page, word for word' });
  });

  it('REJECTS a real quote attached to a model it does not name', () => {
    expect(verifyClaim({ ...prose, deprecated: 'command-r' }, PAGE)).toMatchObject({ why: 'quote does not name command-r' });
  });

  it('REJECTS a date the quote does not state', () => {
    expect(verifyClaim({ ...prose, shutdown_date: '2026-09-16' }, PAGE)).toMatchObject({ why: 'quote does not state 2026-09-16' });
  });

  it('DROPS a replacement the quote does not name, and keeps the claim', () => {
    const guessed = { ...row, replacements: ['llama-3.3-70b-versatile', 'llama-4-scout'] };
    expect(verifyClaim(guessed, PAGE)).toMatchObject({
      replacements: ['llama-3.3-70b-versatile'],
      droppedReplacements: ['llama-4-scout'],
    });
  });

  it('REJECTS a claim with no ISO date, or an id with spaces', () => {
    expect(verifyClaim({ ...prose, shutdown_date: 'September 15, 2026' }, PAGE)).toMatchObject({ why: 'no ISO shutdown date' });
    expect(verifyClaim({ ...prose, deprecated: 'Embed v2' }, PAGE)).toMatchObject({ why: 'no usable model id' });
  });
});

// The shapes measured on real pages, 2026-10-05: Cohere's Markdown (a dated sentence over a list,
// a pipe table with an escaped price) and Groq's HTML tables (numeric dates, one model per row).
const COHERE_MD = [
  '### 2026-04-04: Embed v2.0, Aya Expanse 8B',
  '',
  'Effective April 4th, 2026, the following models will be retired:',
  '',
  '* `embed-english-v2.0`',
  '* `embed-english-light-v2.0`',
  '',
  '### 2024-12-02: Rerank v2.0',
  '',
  '| Shutdown Date | Deprecated Model           | Deprecated Model Price | Recommended Replacement |',
  '| ------------- | -------------------------- | ---------------------- | ----------------------- |',
  '| 2025-04-30    | `rerank-english-v2.0`      | \\$1.00 / 1K searches   | `rerank-v3.5`           |',
  '| 2025-04-30    | `rerank-multilingual-v2.0` | \\$1.00 / 1K searches   | `rerank-v3.5`           |',
].join('\n');
const GROQ_HTML =
  '<table><tr><th>Deprecated Model</th><th>Shutdown Date</th><th>Recommended Replacement Model ID</th></tr>' +
  '<tr><td>llama-3.1-8b-instant</td><td>08/16/26</td><td>openai/gpt-oss-20b</td></tr>' +
  '<tr><td>llama3-70b-8192</td><td>08/30/25</td><td>llama-3.3-70b-versatile</td></tr>' +
  '<tr><td>gemma2-9b-it</td><td>10/08/25</td><td>llama-3.1-8b-instant</td></tr></table>';

describe('verifyClaim on the shapes real pages use', () => {
  it('keeps a dated sentence quoted with the list under it, ordinal date and all', () => {
    const quote = 'Effective April 4th, 2026, the following models will be retired: embed-english-v2.0 embed-english-light-v2.0';
    expect(verifyClaim({ deprecated: 'embed-english-light-v2.0', shutdown_date: '2026-04-04', replacements: [], quote }, COHERE_MD)).toMatchObject({
      shutdownDate: '2026-04-04',
    });
  });

  it('REJECTS a list quote that skips the items in between: that text is not on the page', () => {
    const quote = 'Effective April 4th, 2026, the following models will be retired: embed-english-light-v2.0';
    expect(verifyClaim({ deprecated: 'embed-english-light-v2.0', shutdown_date: '2026-04-04', replacements: [], quote }, COHERE_MD)).toMatchObject({
      why: 'quote is not on the page, word for word',
    });
  });

  it('keeps a Markdown table row quoted as rendered, escaped dollar sign and all', () => {
    const quote = '2025-04-30 | rerank-english-v2.0 | $1.00 / 1K searches | rerank-v3.5';
    expect(verifyClaim({ deprecated: 'rerank-english-v2.0', shutdown_date: '2025-04-30', replacements: ['rerank-v3.5'], quote }, COHERE_MD)).toMatchObject({
      replacements: ['rerank-v3.5'],
    });
  });

  it('REJECTS a quote that runs from one row into the next, the replacement paired with the next row\'s date', () => {
    // Contiguous text once the rows are flattened; says nothing about rerank-v3.5 retiring.
    const straddle = { deprecated: 'rerank-v3.5', shutdown_date: '2025-04-30', replacements: [], quote: 'rerank-v3.5 2025-04-30 rerank-multilingual-v2.0' };
    expect(verifyClaim(straddle, COHERE_MD)).toMatchObject({ why: 'quote is not on the page, word for word' });
    const html = { deprecated: 'openai/gpt-oss-20b', shutdown_date: '2025-08-30', replacements: [], quote: 'openai/gpt-oss-20b llama3-70b-8192 08/30/25' };
    expect(verifyClaim(html, GROQ_HTML)).toMatchObject({ why: 'quote is not on the page, word for word' });
  });

  it('REJECTS a quote that carries two rows itself', () => {
    const twoRows = { deprecated: 'rerank-v3.5', shutdown_date: '2025-04-30', replacements: [], quote: '| a | rerank-v3.5 |\n| 2025-04-30 | b |' };
    expect(verifyClaim(twoRows, COHERE_MD)).toMatchObject({ why: 'quote runs across table rows or into another section' });
  });

  it('REJECTS an id the quote names only as a base model or a replacement', () => {
    // Read by a model on Cohere's real page, 2026-10-05: the fine-tunes retire, not the model.
    const page = '<p>On March 08, 2025, we will sunset all models fine-tuned with Command-R-03-2024.</p>' +
      '<p>On August 8, 2025, we announced the deprecation of gemma2-9b-it in favor of llama-3.1-8b-instant, shutting it down on October 8, 2025.</p>';
    const fineTunes = { deprecated: 'command-r-03-2024', shutdown_date: '2025-03-08', replacements: [], quote: 'On March 08, 2025, we will sunset all models fine-tuned with Command-R-03-2024.' };
    expect(verifyClaim(fineTunes, page)).toMatchObject({ why: 'quote names command-r-03-2024 only as a replacement or a base model' });
    const sentence = 'we announced the deprecation of gemma2-9b-it in favor of llama-3.1-8b-instant, shutting it down on October 8, 2025.';
    const successor = { deprecated: 'llama-3.1-8b-instant', shutdown_date: '2025-10-08', replacements: [], quote: sentence };
    expect(verifyClaim(successor, page)).toMatchObject({ why: 'quote names llama-3.1-8b-instant only as a replacement or a base model' });
    // The same sentence still supports the model it does retire.
    expect(verifyClaim({ ...successor, deprecated: 'gemma2-9b-it', replacements: ['llama-3.1-8b-instant'] }, page)).toMatchObject({
      replacements: ['llama-3.1-8b-instant'],
    });
  });

  it('keeps a row whose numeric date has one reading, and refuses one whose date has two', () => {
    const plain = { deprecated: 'llama-3.1-8b-instant', shutdown_date: '2026-08-16', replacements: ['openai/gpt-oss-20b'], quote: 'llama-3.1-8b-instant | 08/16/26 | openai/gpt-oss-20b' };
    expect(verifyClaim(plain, GROQ_HTML)).toMatchObject({ shutdownDate: '2026-08-16' });
    const twoReadings = { deprecated: 'gemma2-9b-it', shutdown_date: '2025-10-08', replacements: [], quote: 'gemma2-9b-it | 10/08/25 | llama-3.1-8b-instant' };
    expect(verifyClaim(twoReadings, GROQ_HTML)).toMatchObject({ why: 'quote does not state 2025-10-08' });
  });
});

describe('chatCompletionsClient: an answer counts only when it is a chat completion', () => {
  const endpoint = { url: 'https://llm.example/v1/chat/completions', model: 'some-model' };
  const answering = (status: number, body: string, seen?: { init?: RequestInit }) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      if (seen) seen.init = init;
      return new Response(body, { status });
    }) as typeof fetch;

  it('returns the completion, asks at temperature 0 for JSON, and sends a key only when there is one', async () => {
    const seen: { init?: RequestInit } = {};
    const completion = JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] });
    expect(await chatCompletionsClient(endpoint, answering(200, completion, seen))('s', 'u')).toBe('{"claims":[]}');
    const sent = JSON.parse(String(seen.init?.body));
    expect(sent).toMatchObject({ model: 'some-model', temperature: 0, response_format: { type: 'json_object' } });
    expect(seen.init?.headers).not.toHaveProperty('authorization');
    await chatCompletionsClient({ ...endpoint, key: 'k' }, answering(200, completion, seen))('s', 'u');
    expect(seen.init?.headers).toHaveProperty('authorization', 'Bearer k');
  });

  it('refuses a 200 that is not a completion, the way the retired GitHub Models host answers', async () => {
    await expect(chatCompletionsClient(endpoint, answering(200, 'OK\n'))('s', 'u')).rejects.toThrow(
      'the endpoint answered, but not with a chat completion; it sent "OK\\n"',
    );
  });

  it('says which HTTP status came back', async () => {
    await expect(chatCompletionsClient(endpoint, answering(401, '{"error":"bad key"}'))('s', 'u')).rejects.toThrow('the endpoint answered HTTP 401');
  });
});

describe('endpointProblem', () => {
  it('allows https anywhere and plain http only on this machine', () => {
    expect(endpointProblem('https://llm.example/v1/chat/completions')).toBeUndefined();
    expect(endpointProblem('http://localhost:11434/v1/chat/completions')).toBeUndefined();
    expect(endpointProblem('http://[::1]:8080/v1/chat/completions')).toBeUndefined();
    expect(endpointProblem('http://llm.example/v1/chat/completions')).toMatch(/is not https/);
    expect(endpointProblem('not a url')).toMatch(/is not a URL/);
  });
});

describe('verifyReading: the whole answer', () => {
  it('keeps what the page supports, rejects the rest, and says why', () => {
    const answer = JSON.stringify({ claims: [prose, row, { ...prose, deprecated: 'invented-model-1', quote: 'not on the page' }] });
    const reading = verifyReading(answer, PAGE);
    expect(reading.accepted.map((c) => c.deprecated)).toEqual(['command-r-08-2024', 'llama-3.1-70b-versatile']);
    expect(reading.rejected).toHaveLength(1);
  });

  it('is deterministic: the same answer on the same page gives the same reading', () => {
    const answer = JSON.stringify({ claims: [prose, row] });
    expect(verifyReading(answer, PAGE)).toEqual(verifyReading(answer, PAGE));
  });

  it('reports an answer that is not the requested JSON instead of guessing at it', () => {
    expect(verifyReading('Here are the retirements: ...', PAGE)).toMatchObject({ accepted: [], error: 'the answer is not JSON' });
    expect(verifyReading('{"items":[]}', PAGE)).toMatchObject({ error: 'the answer has no "claims" array' });
  });

  it('counts a duplicate claim once', () => {
    expect(verifyReading(JSON.stringify({ claims: [prose, prose] }), PAGE).accepted).toHaveLength(1);
  });
});

describe('readPage', () => {
  it('sends the page through the client and verifies the answer against the same page', async () => {
    let sent = '';
    const reading = await readPage('cohere', PAGE, async (_system, user) => {
      sent = user;
      return JSON.stringify({ claims: [prose] });
    });
    expect(sent).toContain('Provider: cohere');
    expect(sent).toContain('we will retire command-r-08-2024');
    expect(reading.accepted).toHaveLength(1);
  });

  it('asks for quotes copied exactly, and for no guessed replacement', () => {
    const { system } = buildPrompt('groq', PAGE);
    expect(system).toMatch(/copied EXACTLY from the page/);
    expect(system).toMatch(/Never guess a replacement/);
  });
});

describe('allDatesIn', () => {
  it('reads ISO and written-out dates, with or without the comma', () => {
    expect([...allDatesIn('retired 2026-12-20, or on March 4, 2026, or September 15 2026')].sort()).toEqual([
      '2026-03-04',
      '2026-09-15',
      '2026-12-20',
    ]);
  });

  it('reads an ordinal day', () => {
    expect([...allDatesIn('Effective April 4th, 2026, the following')]).toEqual(['2026-04-04']);
    expect([...allDatesIn('After January 31st, 2025, usage')]).toEqual(['2025-01-31']);
  });

  it('reads a numeric date only when one calendar reading exists', () => {
    expect([...allDatesIn('groq/compound 09/21/26')]).toEqual(['2026-09-21']);
    expect([...allDatesIn('playai-tts 12/31/2025')]).toEqual(['2025-12-31']);
    expect([...allDatesIn('kimi-k2-instruct 10/10/25')]).toEqual(['2025-10-10']);
    expect([...allDatesIn('gemma2-9b-it 10/08/25')]).toEqual([]);
    expect([...allDatesIn('tool-use-preview 1/6/25')]).toEqual([]);
  });

  it('never states a day the calendar does not have', () => {
    expect([...allDatesIn('2026-02-30, or February 30, 2026, or 13/13/26')]).toEqual([]);
  });
});
