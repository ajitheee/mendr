import { describe, expect, it } from 'vitest';
import { backoffMs, withRetry } from './retry.js';

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
  }
}
const retryable = (e: unknown) => !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
const retryAfter = (e: unknown) => (e instanceof HttpError ? e.retryAfterMs : undefined);

function harness() {
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  return { slept, opts: { sleep, random: () => 0.5, isRetryable: retryable, retryAfterMs: retryAfter } };
}

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const h = harness();
    let calls = 0;
    const out = await withRetry(async () => ++calls, h.opts);
    expect(out).toBe(1);
    expect(h.slept).toEqual([]);
  });

  it('retries a 429 and a 503 with exponential backoff, then succeeds', async () => {
    const h = harness();
    const answers = [new HttpError(429), new HttpError(503), 'ok'];
    let calls = 0;
    const out = await withRetry(async () => {
      const a = answers[calls++];
      if (a instanceof Error) throw a;
      return a;
    }, h.opts);
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(h.slept).toEqual([500, 1000]); // random=0.5 → zero jitter
  });

  it('honors a server-given delay (Retry-After) instead of backoff, capped', async () => {
    const h = harness();
    let calls = 0;
    await withRetry(
      async () => {
        if (calls++ === 0) throw new HttpError(429, 7_000);
        return 'ok';
      },
      { ...h.opts, maxDelayMs: 5_000 },
    );
    expect(h.slept).toEqual([5_000]);
  });

  it('gives up after the last attempt and rethrows the last error', async () => {
    const h = harness();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new HttpError(502);
      }, h.opts),
    ).rejects.toThrow('HTTP 502');
    expect(calls).toBe(3);
    expect(h.slept.length).toBe(2);
  });

  it('does not retry a failure the caller says is final (a 404, a 400)', async () => {
    const h = harness();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new HttpError(404);
      }, h.opts),
    ).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
    expect(h.slept).toEqual([]);
  });

  it('retries a network error (not an HTTP status at all)', async () => {
    const h = harness();
    let calls = 0;
    const out = await withRetry(async () => {
      if (calls++ === 0) throw new TypeError('fetch failed');
      return 'ok';
    }, h.opts);
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('attempts=1 means no retry at all', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(503);
        },
        { attempts: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('backoffMs', () => {
  it('doubles per retry with ±25% jitter and a cap', () => {
    expect(backoffMs(1, 500, 30_000, () => 0.5)).toBe(500);
    expect(backoffMs(2, 500, 30_000, () => 0.5)).toBe(1000);
    expect(backoffMs(3, 500, 30_000, () => 0.5)).toBe(2000);
    expect(backoffMs(1, 500, 30_000, () => 1)).toBe(625);
    expect(backoffMs(1, 500, 30_000, () => 0)).toBe(375);
    expect(backoffMs(20, 500, 30_000, () => 0.5)).toBe(30_000);
  });
});
