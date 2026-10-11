/**
 * Resolve `p`, or reject once `ms` has passed.
 *
 * The underlying request is NOT cancelled — this is a deadline on the ANSWER, not on the work.
 * That is only safe around reads: an abandoned attempt must change nothing. Never wrap a write
 * in this. A caller that reads and then writes (the install recovery) puts the deadline around
 * the reads and does the writes afterwards, so a late answer is discarded rather than applied.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
