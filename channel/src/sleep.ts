/**
 * The channel's one notion of waiting. Every wait is cancellable: a backoff
 * that loses a race against a stop signal, or an ack timeout that loses to the
 * ack itself, must not leave a timer behind holding the process open.
 */

/** Waits `ms`, or resolves early when `signal` aborts. Never rejects. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Races `work` against a sleep of `ms`, resolving to `timedOut` when the sleep
 * wins. The sleep is cancelled whichever way the race goes, so neither outcome
 * leaves a timer running.
 */
export async function raceSleep<T, R>(
  sleep: Sleep,
  ms: number,
  work: Promise<T>,
  timedOut: R,
): Promise<T | R> {
  const canceller = new AbortController();
  try {
    return await Promise.race([work, sleep(ms, canceller.signal).then(() => timedOut)]);
  } finally {
    canceller.abort();
  }
}
