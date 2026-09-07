// Retry with backoff for the App's outbound calls. GitHub answers with 429 or a
// secondary-rate-limit 403 under load and with 5xx now and then; a network
// blip or a 30-second timeout looks the same from here. Each caller decides
// what counts as retryable and how long GitHub asked us to wait; this module
// only owns the loop: a bounded number of attempts, honoring a server-given
// delay when there is one, otherwise exponential backoff with jitter.

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Is this failure worth another try? Default: yes for anything that is not an Error with a `status` in 400–499 other than 429/403-rate-limit — callers should pass their own. */
  isRetryable?: (error: unknown) => boolean;
  /** A server-given wait (ms) for this failure, e.g. from Retry-After. Undefined = use backoff. */
  retryAfterMs?: (error: unknown) => number | undefined;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 30_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for the n-th retry (1-based): base·2^(n−1), ±25% jitter, capped. */
export function backoffMs(retry: number, base = DEFAULT_BASE_DELAY_MS, max = DEFAULT_MAX_DELAY_MS, random: () => number = Math.random): number {
  const nominal = Math.min(max, base * 2 ** Math.max(0, retry - 1));
  const jitter = nominal * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(nominal + jitter));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const isRetryable = opts.isRetryable ?? (() => true);
  const sleep = opts.sleep ?? wait;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      const asked = opts.retryAfterMs?.(error);
      const delay = asked !== undefined && Number.isFinite(asked) ? Math.min(max, Math.max(0, asked)) : backoffMs(attempt, opts.baseDelayMs, max, opts.random);
      await sleep(delay);
    }
  }
  throw lastError;
}
