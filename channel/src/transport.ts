/**
 * Picks how the channel talks to the room. The stream is primary: one socket,
 * pushed both ways. Long-poll is the fallback for when the socket cannot be
 * held, and it hands the room back the moment a socket connects again. Both
 * paths share one injector, so the cursor and the resend backlog stay single.
 */

import type { Member, MembersResult, Message, OrskoClient, PostedMessage } from "./client.js";
import { STREAM_FALLBACK_AFTER_FAILURES, STREAM_FALLBACK_RETRY_MS } from "./config.js";
import type { WelcomeFrame } from "./frames.js";
import type { ChannelEvent, Injector } from "./inject.js";
import { errorClass, type Logger } from "./log.js";
import { createPoller } from "./poller.js";
import type { Sleep } from "./sleep.js";
import { createStream, type SocketFactory, StreamUnavailableError } from "./stream.js";

export interface TransportDeps {
  readonly client: OrskoClient;
  readonly roomId: string;
  /** This channel's own member name, for recognising its own messages. */
  readonly selfName: string;
  readonly streamUrl: string;
  readonly token: string;
  readonly injector: Injector;
  readonly emit: (event: ChannelEvent) => Promise<void>;
  /** The joined event's body when the socket got there first. */
  readonly joinedFromStream: (welcome: WelcomeFrame) => Promise<string>;
  /** The joined event's body when long-poll had to carry the room. */
  readonly joinedFromPoll: () => Promise<string>;
  readonly sleep: Sleep;
  readonly log: Logger;
  readonly socketFactory?: SocketFactory;
  readonly waitSeconds?: number;
}

export interface RoomTransport {
  start(): void;
  stop(): Promise<void>;
  post(input: {
    readonly text: string;
    readonly attachmentIds?: readonly string[];
  }): Promise<PostedMessage>;
  members(): Promise<MembersResult>;
  /** True while the socket is connected and carrying the room. */
  readonly streaming: boolean;
  /** Resolves when the room is archived or `stop()` is called. */
  readonly done: Promise<void>;
}

export function createTransport(deps: TransportDeps): RoomTransport {
  let joined = false;
  let fallback = false;
  let finished = false;
  let pollerRunning = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const poller = createPoller({
    client: deps.client,
    roomId: deps.roomId,
    injector: deps.injector,
    sleep: deps.sleep,
    log: deps.log,
    ...(deps.waitSeconds === undefined ? {} : { waitSeconds: deps.waitSeconds }),
  });

  async function emitJoined(body: () => Promise<string>): Promise<void> {
    if (joined || finished) return;
    try {
      const content = await body();
      if (joined) return;
      joined = true;
      await deps.emit({ content, meta: { room: deps.roomId, event: "joined" } });
    } catch (error) {
      // Leave `joined` false: whichever transport settles next tries again.
      deps.log.event("channel.joined_failed", { error: errorClass(error) });
    }
  }

  function startPoller(): void {
    if (pollerRunning || finished) return;
    pollerRunning = true;
    poller.start();
    void poller.done.then(() => {
      // The loop only ends on its own when the room is over.
      if (pollerRunning && !finished) void finish("the long poll ended");
    });
  }

  async function stopPoller(): Promise<void> {
    if (!pollerRunning) return;
    pollerRunning = false;
    await poller.stop().catch(() => undefined);
  }

  /** Long-poll takes over until a socket connects again. */
  async function enterFallback(): Promise<void> {
    if (fallback || finished) return;
    fallback = true;
    deps.log.event("channel.fallback_started");
    stream.setRetryFloorMs(STREAM_FALLBACK_RETRY_MS);
    startPoller();
    await emitJoined(deps.joinedFromPoll);
  }

  async function leaveFallback(): Promise<void> {
    stream.setRetryFloorMs(0);
    if (!fallback) return;
    fallback = false;
    deps.log.event("channel.fallback_ended");
    await stopPoller();
  }

  /**
   * The room is over: no transport will produce anything more. Both loops are
   * stopped, including the socket's — a poller-detected archive or a fatal
   * token error must not leave it reconnecting to a room nobody is reading.
   */
  async function finish(reason: string): Promise<void> {
    if (finished) return;
    finished = true;
    deps.log.event("channel.transport_finished", { reason });
    await stopPoller();
    await stream.stop().catch(() => undefined);
    resolveDone();
  }

  /**
   * A stream post whose ack never came may still have been appended. One
   * no-wait read of everything since the post went out answers whether it was:
   * a message from this member with the same text means the room already has
   * it, and re-posting would double it.
   */
  async function alreadyLanded(since: number, text: string): Promise<Message | null> {
    try {
      const result = await deps.client.poll({ since, waitSeconds: 0 });
      const mine = result.messages.filter(
        (message) => message.from === deps.selfName && message.text === text,
      );
      return mine.at(-1) ?? null;
    } catch (error) {
      // The probe is best-effort: if it cannot run, the idempotency key on the
      // HTTP post is the remaining guard.
      deps.log.event("channel.post_probe_failed", { error: errorClass(error) });
      return null;
    }
  }

  const stream = createStream({
    url: deps.streamUrl,
    token: deps.token,
    since: () => deps.injector.cursor(),
    onWelcome: async (welcome) => {
      await leaveFallback();
      await emitJoined(() => deps.joinedFromStream(welcome));
      stream.sendRead(deps.injector.cursor());
    },
    onMessage: async (message) => {
      await deps.injector.deliver([message], message.seq);
      stream.sendRead(deps.injector.cursor());
    },
    onState: async (state) => {
      if (state !== "archived") {
        deps.log.event("channel.state", { state });
        return;
      }
      await deps.injector.finish(
        "archived",
        `Room ${deps.roomId} is archived. No more messages will arrive; the channel has stopped listening.`,
      );
      await finish("the room was archived");
    },
    onPresence: () => undefined,
    onConnected: () => deps.log.event("channel.stream_connected"),
    onConnectFailure: (consecutive) => {
      if (consecutive >= STREAM_FALLBACK_AFTER_FAILURES) void enterFallback();
    },
    sleep: deps.sleep,
    log: deps.log,
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
  });

  return {
    start() {
      stream.start();
    },
    get streaming() {
      return stream.connected;
    },
    get done() {
      return done;
    },
    async post(input) {
      if (stream.connected) {
        const since = deps.injector.cursor();
        try {
          return await stream.post(input);
        } catch (error) {
          if (!(error instanceof StreamUnavailableError)) throw error;
          deps.log.event("channel.post_over_http", { reason: errorClass(error) });
          const postId = error.postId;
          if (postId !== undefined) {
            const landed = await alreadyLanded(since, input.text);
            if (landed) {
              deps.log.event("channel.post_already_landed", { seq: landed.seq });
              return landed;
            }
            return deps.client.post({ ...input, idempotencyKey: postId });
          }
        }
      }
      return deps.client.post(input);
    },
    async members() {
      const cached: readonly Member[] | null = stream.connected ? stream.members : null;
      if (cached) return { members: cached, lastSeq: stream.lastSeq };
      return deps.client.members();
    },
    async stop() {
      finished = true;
      await stream.stop().catch(() => undefined);
      await stopPoller();
      resolveDone();
    },
  };
}
