/**
 * The channel's primary transport: one WebSocket to the room, held open, with
 * the handshake, frame handling, reconnect backoff, and post/ack correlation.
 * Everything the client does with time or sockets is injectable so the tests
 * never wait on a real clock.
 */

import { randomUUID } from "node:crypto";
import { type Message, OrskoApiError, type PostedMessage } from "./client.js";
import {
  MAX_STREAM_FRAME_BYTES,
  POST_ACK_TIMEOUT_MS,
  STREAM_BACKOFF_MAX_MS,
  STREAM_BACKOFF_MIN_MS,
  STREAM_FLAP_WINDOW_MS,
} from "./config.js";
import {
  helloFrame,
  parseServerFrame,
  postFrame,
  readFrame,
  type ServerFrame,
  type StreamMember,
  type StreamState,
  type WelcomeFrame,
} from "./frames.js";
import { errorClass, type Logger } from "./log.js";
import { raceSleep, type Sleep } from "./sleep.js";

/** The slice of the WebSocket API the client uses, so tests can stand in. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void;
}

export type SocketEventType = "open" | "message" | "close" | "error";

export interface SocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

export type SocketFactory = (url: string) => SocketLike;

interface GlobalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Node 22's global WebSocket, wrapped down to `SocketLike`. */
export const defaultSocketFactory: SocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => GlobalSocket }).WebSocket;
  if (!ctor) throw new Error("this runtime has no global WebSocket");
  const socket = new ctor(url);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) =>
      socket.addEventListener(type, (event) => listener((event ?? {}) as SocketEvent)),
  };
};

/** The socket cannot carry this call: not connected, closed, or no ack in time. */
export class StreamUnavailableError extends Error {
  /**
   * The client id of the post that went unanswered, when the frame may already
   * have reached the room. Undefined means nothing was put on the wire, so a
   * caller retrying over HTTP has nothing to reconcile.
   */
  readonly postId: string | undefined;

  constructor(message: string, postId?: string) {
    super(message);
    this.name = "StreamUnavailableError";
    this.postId = postId;
  }
}

export interface StreamDeps {
  readonly url: string;
  readonly token: string;
  /** The cursor to replay from; read afresh for every `hello`. */
  readonly since: () => number;
  readonly onWelcome: (frame: WelcomeFrame) => Promise<void>;
  readonly onMessage: (message: Message) => Promise<void>;
  readonly onState: (state: StreamState) => Promise<void>;
  readonly onPresence: (members: readonly StreamMember[]) => void;
  readonly onConnected: () => void;
  readonly onConnectFailure: (consecutive: number) => void;
  readonly sleep: Sleep;
  readonly log: Logger;
  readonly socketFactory?: SocketFactory;
  /** Injectable clock, so the flap window can be exercised without waiting. */
  readonly now?: () => number;
}

export interface StreamClient {
  start(): void;
  stop(): Promise<void>;
  readonly connected: boolean;
  /** Presence cache from `welcome` and `presence` frames; null before the first. */
  readonly members: readonly StreamMember[] | null;
  readonly lastSeq: number;
  post(input: {
    readonly text: string;
    readonly attachmentIds?: readonly string[];
  }): Promise<PostedMessage>;
  sendRead(since: number): void;
  /** Slows reconnect attempts while another transport is carrying the room. */
  setRetryFloorMs(ms: number): void;
  /** Resolves when the room is archived or `stop()` is called. */
  readonly done: Promise<void>;
}

/** How one connection ended, and when its `welcome` arrived (null: never). */
interface SessionOutcome {
  readonly outcome: "welcomed" | "failed";
  readonly welcomedAt: number | null;
}

interface PendingPost {
  readonly resolve: (message: PostedMessage) => void;
  readonly reject: (error: Error) => void;
}

function backoffFor(failures: number, floorMs: number): number {
  const grown = STREAM_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1);
  return Math.max(floorMs, Math.min(STREAM_BACKOFF_MAX_MS, grown));
}

export function createStream(deps: StreamDeps): StreamClient {
  const makeSocket = deps.socketFactory ?? defaultSocketFactory;
  const now = deps.now ?? Date.now;
  const pendingPosts = new Map<string, PendingPost>();

  let socket: SocketLike | null = null;
  let connected = false;
  let members: readonly StreamMember[] | null = null;
  let lastSeq = 0;
  let failures = 0;
  let floorMs = 0;
  let stopped = false;
  let loop: Promise<void> = Promise.resolve();
  let frames: Promise<unknown> = Promise.resolve();
  /**
   * True while a frame handler is running. `stop()` must not await the frame
   * chain from inside it: a handler that stops the stream (an `archived`
   * state) would be waiting on itself.
   */
  let applyingFrame = false;
  let resolveStopped: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  function failPending(reason: string): void {
    const waiting = [...pendingPosts.entries()];
    pendingPosts.clear();
    for (const [id, post] of waiting) post.reject(new StreamUnavailableError(reason, id));
  }

  function trySend(frame: string): boolean {
    if (!socket || !connected) return false;
    try {
      socket.send(frame);
      return true;
    } catch (error) {
      deps.log.event("stream.send_failed", { error: errorClass(error) });
      return false;
    }
  }

  async function applyFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "welcome":
        connected = true;
        members = frame.members;
        lastSeq = frame.lastSeq;
        deps.onConnected();
        await deps.onWelcome(frame);
        return;
      case "message":
        lastSeq = Math.max(lastSeq, frame.message.seq);
        await deps.onMessage(frame.message);
        return;
      case "presence":
        members = frame.members;
        deps.onPresence(frame.members);
        return;
      case "state": {
        const archived = frame.state === "archived";
        // Marked stopped before the handler runs: `onState` may await, and a
        // reconnect must not start behind its back.
        if (archived) stopped = true;
        await deps.onState(frame.state);
        if (archived) {
          resolveStopped();
          socket?.close(1000, "archived");
        }
        return;
      }
      case "ack": {
        lastSeq = Math.max(lastSeq, frame.seq);
        const waiting = pendingPosts.get(frame.id);
        pendingPosts.delete(frame.id);
        waiting?.resolve(
          frame.unread === undefined ? frame.message : { ...frame.message, unread: frame.unread },
        );
        return;
      }
      case "error": {
        const failed = frame.id === undefined ? undefined : pendingPosts.get(frame.id);
        if (frame.id !== undefined) pendingPosts.delete(frame.id);
        deps.log.event("stream.error_frame", {
          code: frame.code,
          correlated: failed !== undefined,
        });
        failed?.reject(new OrskoApiError(frame.code, frame.message, 0, frame.retryAfterSeconds));
        return;
      }
    }
  }

  /** Frames are applied strictly in order, however slow a handler is. */
  function enqueue(raw: unknown): void {
    const frame = parseServerFrame(raw);
    if (!frame) {
      deps.log.event("stream.frame_unreadable");
      return;
    }
    frames = frames.then(async () => {
      applyingFrame = true;
      try {
        await applyFrame(frame);
      } catch (error: unknown) {
        deps.log.event("stream.frame_failed", { type: frame.type, error: errorClass(error) });
      } finally {
        applyingFrame = false;
      }
    });
  }

  /** One connection, from the socket opening to it closing. */
  function session(): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let welcomedAt: number | null = null;
      let current: SocketLike;
      try {
        current = makeSocket(deps.url);
      } catch (error) {
        deps.log.event("stream.connect_failed", { error: errorClass(error) });
        resolve({ outcome: "failed", welcomedAt: null });
        return;
      }
      socket = current;

      const settle = (code?: number): void => {
        if (settled) return;
        settled = true;
        connected = false;
        socket = null;
        failPending("the room socket closed before the post was acknowledged");
        deps.log.event("stream.closed", { code: code ?? 0, welcomed: welcomedAt !== null });
        resolve({ outcome: welcomedAt === null ? "failed" : "welcomed", welcomedAt });
      };

      current.addEventListener("open", () => {
        if (!trySendOn(current, helloFrame(deps.token, deps.since()))) {
          settle();
        }
      });
      current.addEventListener("message", (event) => {
        if (welcomedAt === null) {
          const frame = parseServerFrame(event.data);
          if (frame?.type === "welcome") welcomedAt = now();
        }
        enqueue(event.data);
      });
      current.addEventListener("error", () => {
        deps.log.event("stream.socket_error");
        try {
          current.close(1011, "socket error");
        } catch {
          // The socket was already gone; the close event still settles us.
        }
        settle();
      });
      current.addEventListener("close", (event) => settle(event.code));
    });
  }

  /** `send` on a socket that is not yet the "connected" one (the hello). */
  function trySendOn(target: SocketLike, frame: string): boolean {
    try {
      target.send(frame);
      return true;
    } catch (error) {
      deps.log.event("stream.send_failed", { error: errorClass(error) });
      return false;
    }
  }

  /** Sleeps `ms` unless the stream stops first; either way no timer is left. */
  async function rest(ms: number): Promise<void> {
    await raceSleep(deps.sleep, ms, stopSignal, undefined);
  }

  /**
   * A session counts as working only if its `welcome` stood for longer than
   * the flap window. A server that welcomes and immediately drops would
   * otherwise reset the failure count every time and never reach the
   * long-poll fallback, replaying the room on every reconnect.
   */
  function worked(result: SessionOutcome): boolean {
    if (result.welcomedAt === null) return false;
    return now() - result.welcomedAt >= STREAM_FLAP_WINDOW_MS;
  }

  async function run(): Promise<void> {
    while (!stopped) {
      const result = await session();
      if (stopped) return;
      if (worked(result)) {
        failures = 0;
      } else {
        failures += 1;
        deps.onConnectFailure(failures);
      }
      await rest(backoffFor(failures, floorMs));
    }
  }

  return {
    start() {
      loop = run().catch((error: unknown) => {
        stopped = true;
        deps.log.event("stream.loop_crashed", { error: errorClass(error) });
      });
    },
    get done() {
      return loop;
    },
    get connected() {
      return connected;
    },
    get members() {
      return members;
    },
    get lastSeq() {
      return lastSeq;
    },
    setRetryFloorMs(ms) {
      floorMs = Math.max(0, ms);
    },
    sendRead(since) {
      trySend(readFrame(since));
    },
    async post(input) {
      if (!connected) throw new StreamUnavailableError("the room socket is not connected");
      const id = randomUUID();
      const frame = postFrame(id, input.text, input.attachmentIds);
      const bytes = new TextEncoder().encode(frame).byteLength;
      if (bytes > MAX_STREAM_FRAME_BYTES) {
        // Nothing goes on the wire, so no id: the caller has nothing to
        // reconcile before it posts this over HTTP.
        deps.log.event("stream.post_too_large", { bytes, limit: MAX_STREAM_FRAME_BYTES });
        throw new StreamUnavailableError(
          `the post frame is ${bytes} bytes, over the ${MAX_STREAM_FRAME_BYTES}-byte stream limit`,
        );
      }
      const acked = new Promise<PostedMessage>((resolve, reject) => {
        pendingPosts.set(id, { resolve, reject });
      });
      // A late rejection (socket closed after the timeout won) must not become
      // an unhandled rejection.
      const settled = acked.then(
        (message) => ({ message }) as const,
        (error: unknown) => ({ error }) as const,
      );
      if (!trySend(frame)) {
        pendingPosts.delete(id);
        throw new StreamUnavailableError("the room socket would not take the post", id);
      }
      const outcome = await raceSleep(deps.sleep, POST_ACK_TIMEOUT_MS, settled, "timeout" as const);
      if (outcome === "timeout") {
        pendingPosts.delete(id);
        throw new StreamUnavailableError("the room did not acknowledge the post in time", id);
      }
      if ("error" in outcome) throw outcome.error;
      return outcome.message;
    },
    async stop() {
      stopped = true;
      resolveStopped();
      failPending("the channel is shutting down");
      try {
        socket?.close(1000, "channel stopping");
      } catch {
        // Already closed; nothing else to do.
      }
      await loop.catch(() => undefined);
      // Not from inside a frame handler: the chain would be waiting on itself.
      if (!applyingFrame) await frames.catch(() => undefined);
    },
  };
}
