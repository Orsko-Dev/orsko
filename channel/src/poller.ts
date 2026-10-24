import { OrskoApiError, type OrskoClient } from "./client.js";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, POLL_WAIT_SECONDS } from "./config.js";
import type { Injector } from "./inject.js";
import { errorClass, type Logger } from "./log.js";
import { raceSleep, type Sleep } from "./sleep.js";

export type { ChannelEvent } from "./inject.js";

export interface PollerDeps {
  readonly client: OrskoClient;
  readonly roomId: string;
  /** Shared with the stream transport: one cursor, one resend backlog. */
  readonly injector: Injector;
  readonly sleep: Sleep;
  readonly log: Logger;
  readonly waitSeconds?: number;
}

export interface Poller {
  start(): void;
  /** Resolves when the loop ends: archived room, fatal error, or `stop()`. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/** API errors that mean the loop can never succeed again. */
const FATAL_CODES = new Set(["invalid_token", "forbidden", "room_not_found"]);

function backoffFor(failures: number): number {
  const grown = BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(BACKOFF_MAX_MS, grown);
}

export function createPoller(deps: PollerDeps): Poller {
  const waitSeconds = deps.waitSeconds ?? POLL_WAIT_SECONDS;
  let controller = new AbortController();
  let failures = 0;
  let stopped = false;
  let loop: Promise<void> = Promise.resolve();
  let resolveStopped: () => void = () => undefined;
  let stopSignal = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  /** A sleep that ends early when the poller is shutting down, timer and all. */
  async function rest(ms: number): Promise<void> {
    await raceSleep(deps.sleep, ms, stopSignal, undefined);
  }

  /** One poll. Returns false when the loop should end. */
  async function step(): Promise<boolean> {
    const result = await deps.client.poll({
      since: deps.injector.cursor(),
      waitSeconds,
      signal: controller.signal,
    });
    failures = 0;
    const injected = await deps.injector.deliver(result.messages, result.nextSince);
    if (stopped) return false;
    if (result.mode === "archived") {
      await deps.injector.finish(
        "archived",
        `Room ${deps.roomId} is archived. No more messages will arrive; the channel has stopped polling.`,
        injected,
      );
      return false;
    }
    if (result.mode === "slow") {
      const seconds = result.retryAfterSeconds ?? 30;
      deps.log.event("channel.slow", { retryAfterSeconds: seconds });
      await rest(seconds * 1000);
    }
    return true;
  }

  async function handleFailure(error: unknown): Promise<boolean> {
    if (stopped) return false;
    if (error instanceof OrskoApiError && error.code === "room_archived") {
      await deps.injector.finish(
        "archived",
        `Room ${deps.roomId} is archived. The channel has stopped polling.`,
      );
      return false;
    }
    if (error instanceof OrskoApiError && FATAL_CODES.has(error.code)) {
      deps.log.event("channel.fatal", { code: error.code, status: error.status });
      await deps.injector.finish(
        "stopped",
        `The Orsko channel stopped polling room ${deps.roomId}: the room rejected its membership (${error.code}). Restart the session to rejoin.`,
      );
      return false;
    }
    failures += 1;
    const wait = backoffFor(failures);
    deps.log.event("channel.poll_failed", { failures, backoffMs: wait, error: errorClass(error) });
    await rest(wait);
    return true;
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        if (!(await step())) return;
      } catch (error) {
        if (!(await handleFailure(error))) return;
      }
    }
  }

  return {
    start() {
      if (stopped) {
        // A restart after a fallback ended: give the loop a fresh abort
        // controller and stop signal, or it would abort its first request.
        stopped = false;
        failures = 0;
        controller = new AbortController();
        stopSignal = new Promise<void>((resolve) => {
          resolveStopped = resolve;
        });
      }
      // `run()` already catches the errors it knows how to recover from, but
      // anything that still escapes (e.g. a throw from the failure path
      // itself) must not become an unhandled rejection: log it and stop the
      // poller cleanly instead of leaving `loop` a dangling rejected promise.
      loop = run().catch((error: unknown) => {
        stopped = true;
        deps.log.event("channel.loop_crashed", { error: errorClass(error) });
      });
    },
    get done() {
      return loop;
    },
    async stop() {
      stopped = true;
      resolveStopped();
      controller.abort();
      await loop.catch(() => undefined);
    },
  };
}
