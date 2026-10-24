import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Member, type Message, OrskoApiError } from "../src/client.js";
import { MAX_STREAM_FRAME_BYTES, streamUrlFor } from "../src/config.js";
import type { StreamState, WelcomeFrame } from "../src/frames.js";
import {
  createStream,
  defaultSocketFactory,
  type SocketFactory,
  type StreamClient,
  StreamUnavailableError,
} from "../src/stream.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";
import { attachStream, type FakeStream } from "./fake-stream.js";
import { type RecordingSleep, recordingSleep, silentLogger, waitFor } from "./support.js";

interface Harness {
  readonly stream: StreamClient;
  readonly welcomes: WelcomeFrame[];
  readonly messages: Message[];
  readonly states: StreamState[];
  readonly presence: Array<readonly Member[]>;
  readonly failures: number[];
  readonly connects: number[];
  readonly sleeps: number[];
  readonly sleeper: RecordingSleep;
}

describe("stream client", () => {
  let fake: FakeOrsko;
  let server: FakeStream;
  let client: StreamClient | null = null;

  beforeEach(async () => {
    fake = await startFakeOrsko();
    server = attachStream(fake);
  });

  afterEach(async () => {
    if (client) await client.stop();
    client = null;
    await server.close();
    await fake.close();
  });

  async function join(name = "alice", role = "agent"): Promise<string> {
    const response = await fetch(`${fake.baseUrl}/api/rooms/${fake.roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, role }),
    });
    const body = (await response.json()) as { token: string };
    return body.token;
  }

  function connect(
    token: string,
    options: {
      since?: number;
      socketFactory?: SocketFactory;
      sleepMs?: number;
      now?: () => number;
    } = {},
  ): Harness {
    const welcomes: WelcomeFrame[] = [];
    const messages: Message[] = [];
    const states: StreamState[] = [];
    const presence: Array<readonly Member[]> = [];
    const failures: number[] = [];
    const connects: number[] = [];
    const sleeper = recordingSleep(options.sleepMs ?? 1);
    const stream = createStream({
      url: streamUrlFor(fake.baseUrl, fake.roomId),
      token,
      since: () => options.since ?? 0,
      onWelcome: async (frame) => {
        welcomes.push(frame);
      },
      onMessage: async (message) => {
        messages.push(message);
      },
      onState: async (state) => {
        states.push(state);
      },
      onPresence: (members) => {
        presence.push(members);
      },
      onConnected: () => {
        connects.push(1);
      },
      onConnectFailure: (consecutive) => {
        failures.push(consecutive);
      },
      sleep: sleeper.sleep,
      log: silentLogger,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    client = stream;
    stream.start();
    return {
      stream,
      sleeper,
      welcomes,
      messages,
      states,
      presence,
      failures,
      connects,
      sleeps: sleeper.calls,
    };
  }

  it("sends hello with the token and cursor and reports the welcome", async () => {
    const token = await join();
    const harness = connect(token, { since: 1 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    expect(server.hellos[0]).toEqual({ token, since: 1 });
    expect(harness.welcomes[0]?.you.name).toBe("alice");
    expect(harness.stream.connected).toBe(true);
    expect(harness.stream.members?.map((m) => m.name)).toEqual(["alice"]);
  });

  it("replays the messages after the cursor, then pushes new ones live", async () => {
    const token = await join();
    fake.push("bob", "before one");
    fake.push("bob", "before two");
    const harness = connect(token, { since: 2 });
    await waitFor(() => harness.messages.length === 1, "the replayed message");
    expect(harness.messages[0]?.text).toBe("before two");

    fake.push("bob", "live one");
    await waitFor(() => harness.messages.length === 2, "the live message");
    expect(harness.messages[1]?.text).toBe("live one");
  });

  it("posts over the socket and resolves on the matching ack", async () => {
    const token = await join();
    const harness = connect(token, { sleepMs: 200 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    const posted = await harness.stream.post({ text: "on it" });
    expect(posted.text).toBe("on it");
    expect(fake.messages.at(-1)).toMatchObject({ from: "alice", text: "on it" });
  });

  it("resolves a post with the unread count from its ack", async () => {
    const token = await join();
    const harness = connect(token, { sleepMs: 200 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    fake.push("bob", "did you see this?");
    await waitFor(
      () => harness.messages.some((message) => message.text === "did you see this?"),
      "bob's message",
    );
    const posted = await harness.stream.post({ text: "replying without reading" });
    expect(posted.unread).toBe(1);
  });

  it("rejects a post the room refuses, with the room's error code", async () => {
    const token = await join();
    const harness = connect(token, { sleepMs: 200 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    await expect(harness.stream.post({ text: "token sk-live-abc" })).rejects.toMatchObject({
      name: "OrskoApiError",
      code: "secret_detected",
    });
    await expect(harness.stream.post({ text: "token sk-live-abc" })).rejects.toBeInstanceOf(
      OrskoApiError,
    );
  });

  it("refuses to post while the socket is down", async () => {
    server.refuse = true;
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.failures.length > 0, "a failed connect");
    await expect(harness.stream.post({ text: "nobody is listening" })).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
  });

  it("gives up on a post that is never acked, so the caller can use HTTP", async () => {
    const token = await join();
    // A socket that quietly drops `post` frames: the ack never comes.
    const dropPosts: SocketFactory = (url) => {
      const socket = defaultSocketFactory(url);
      return {
        ...socket,
        send: (data: string) => {
          if (!data.includes('"post"')) socket.send(data);
        },
      };
    };
    const harness = connect(token, { socketFactory: dropPosts });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    await expect(harness.stream.post({ text: "into the void" })).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
    expect(harness.sleeps).toContain(10_000);
  });

  it("sends read frames when asked", async () => {
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    fake.push("bob", "read me");
    await waitFor(() => harness.messages.length === 1, "bob's message");
    harness.stream.sendRead(2);
    await waitFor(() => server.reads.length > 0, "the read frame");
    expect(server.reads.at(-1)).toEqual({ member: "alice", since: 2 });
  });

  it("updates the members cache from presence frames", async () => {
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    await join("bob");
    await waitFor(
      () => (harness.stream.members ?? []).some((m) => m.name === "bob"),
      "bob in the members cache",
    );
    expect(harness.presence.length).toBeGreaterThan(0);
    expect(harness.stream.lastSeq).toBeGreaterThan(0);
  });

  it("reconnects after a drop and says hello with the cursor it has now", async () => {
    const token = await join();
    let since = 0;
    const sleeper = recordingSleep();
    const welcomes: WelcomeFrame[] = [];
    const stream = createStream({
      url: streamUrlFor(fake.baseUrl, fake.roomId),
      token,
      since: () => since,
      onWelcome: async (frame) => {
        welcomes.push(frame);
      },
      onMessage: async () => undefined,
      onState: async () => undefined,
      onPresence: () => undefined,
      onConnected: () => undefined,
      onConnectFailure: () => undefined,
      sleep: sleeper.sleep,
      log: silentLogger,
    });
    client = stream;
    stream.start();
    await waitFor(() => welcomes.length === 1, "the first welcome");
    since = 7;
    server.dropAll();
    await waitFor(() => welcomes.length === 2, "the welcome after reconnecting");
    expect(server.hellos.map((hello) => hello.since)).toEqual([0, 7]);
  });

  it("backs off from a second to thirty, and honours a retry floor", async () => {
    server.refuse = true;
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.failures.length >= 4, "four failed connects");
    expect(harness.failures.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(harness.sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);

    await waitFor(() => harness.sleeps.length >= 8, "the backoff to reach its ceiling");
    expect(Math.max(...harness.sleeps)).toBe(30_000);

    harness.stream.setRetryFloorMs(60_000);
    const before = harness.sleeps.length;
    await waitFor(() => harness.sleeps.length > before + 1, "a sleep under the floor");
    expect(harness.sleeps.at(-1)).toBe(60_000);
  });

  it("reports a state frame and stops for good once the room is archived", async () => {
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    server.broadcastState("archived");
    await harness.stream.done;
    expect(harness.states).toEqual(["archived"]);
    expect(harness.stream.connected).toBe(false);
  });

  it("survives a socket factory that throws instead of connecting", async () => {
    const token = await join();
    const harness = connect(token, {
      socketFactory: () => {
        throw new Error("no sockets today");
      },
    });
    await waitFor(() => harness.failures.length >= 2, "two failed connects");
    expect(harness.failures.slice(0, 2)).toEqual([1, 2]);
    expect(harness.stream.connected).toBe(false);
  });

  it("refuses a post whose frame is over the stream's frame limit", async () => {
    const token = await join();
    const harness = connect(token, { sleepMs: 200 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    // 40 KiB of quotes: every one is escaped, so the JSON frame is past 64 KiB
    // even though the text itself is not.
    const quoted = '"'.repeat(40 * 1024);
    expect(quoted.length).toBeLessThan(MAX_STREAM_FRAME_BYTES);
    await expect(harness.stream.post({ text: quoted })).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
    // Nothing went on the wire, so there is no post id to reconcile.
    await expect(harness.stream.post({ text: quoted })).rejects.toMatchObject({
      postId: undefined,
    });
    expect(fake.messages.some((message) => message.text.includes('""'))).toBe(false);
  });

  it("still posts a frame that only just fits", async () => {
    const token = await join();
    const harness = connect(token, { sleepMs: 200 });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    const posted = await harness.stream.post({ text: "x".repeat(60 * 1024) });
    expect(posted.text).toHaveLength(60 * 1024);
  });

  it("names the unanswered post so the caller can reconcile it", async () => {
    const token = await join();
    const dropPosts: SocketFactory = (url) => {
      const socket = defaultSocketFactory(url);
      return {
        ...socket,
        send: (data: string) => {
          if (!data.includes('"post"')) socket.send(data);
        },
      };
    };
    const harness = connect(token, { socketFactory: dropPosts });
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    const failure = await harness.stream.post({ text: "into the void" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StreamUnavailableError);
    expect((failure as StreamUnavailableError).postId).toMatch(/^[0-9a-f-]{36}$/);
    // The ack timer is cancelled by the race, not left to fire later.
    expect(harness.sleeper.outstanding).toBe(0);
  });

  it("counts a welcomed session that closes at once towards the failure count", async () => {
    server.dropOnWelcome = true;
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.failures.length >= 3, "three flapping sessions");
    expect(harness.failures.slice(0, 3)).toEqual([1, 2, 3]);
    expect(harness.welcomes.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the failure count at zero for a session that outlives the flap window", async () => {
    server.dropOnWelcome = true;
    const token = await join();
    let clock = 0;
    const harness = connect(token, {
      now: () => {
        clock += 10_000;
        return clock;
      },
    });
    await waitFor(() => harness.welcomes.length >= 3, "three welcomes");
    expect(harness.failures).toEqual([]);
  });

  it("closes the socket on stop and does not reconnect", async () => {
    const token = await join();
    const harness = connect(token);
    await waitFor(() => harness.welcomes.length === 1, "the welcome frame");
    await harness.stream.stop();
    client = null;
    await waitFor(() => server.openCount === 0, "the socket to close");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.openCount).toBe(0);
    expect(harness.welcomes).toHaveLength(1);
  });
});
