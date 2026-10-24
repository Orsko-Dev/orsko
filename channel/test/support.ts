import type { Logger } from "../src/log.js";
import type { Sleep } from "../src/sleep.js";

/** Waits until `check` is true, polling briefly. Fails loudly on timeout. */
export async function waitFor(
  check: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function fakeClock(start = 0): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface RecordingSleep {
  sleep: Sleep;
  readonly calls: number[];
  /** Sleeps still holding a timer. Zero once every wait has settled. */
  readonly outstanding: number;
}

/**
 * A sleep that records what it was asked to wait and then waits `realMs`
 * instead. Tests that race a sleep against real I/O (a post waiting for its
 * ack) pass a few milliseconds so the I/O has a fair chance to win.
 *
 * It honours the cancel signal exactly as the real sleep does, and counts the
 * timers it still holds, so a test can assert nothing was left running.
 */
export function recordingSleep(realMs = 1): RecordingSleep {
  const calls: number[] = [];
  let live = 0;
  return {
    calls,
    get outstanding() {
      return live;
    },
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        calls.push(ms);
        if (signal?.aborted) {
          resolve();
          return;
        }
        live += 1;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", settle);
          live -= 1;
          resolve();
        };
        timer = setTimeout(settle, realMs);
        signal?.addEventListener("abort", settle, { once: true });
      }),
  };
}

export const silentLogger: Logger = { event: () => undefined };
