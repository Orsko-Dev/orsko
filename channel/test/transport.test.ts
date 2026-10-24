import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrskoClient } from "../src/client.js";
import { streamUrlFor } from "../src/config.js";
import { type ChannelEvent, createInjector } from "../src/inject.js";
import { PendingTracker } from "../src/pending.js";
import { defaultSocketFactory, type SocketFactory } from "../src/stream.js";
import { createTransport, type RoomTransport } from "../src/transport.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";
import { attachStream, type FakeStream } from "./fake-stream.js";
import { fakeClock, recordingSleep, silentLogger, waitFor } from "./support.js";

describe("room transport", () => {
  let fake: FakeOrsko;
  let server: FakeStream;
  let transport: RoomTransport | null = null;

  beforeEach(async () => {
    fake = await startFakeOrsko();
    server = attachStream(fake);
  });

  afterEach(async () => {
    if (transport) await transport.stop();
    transport = null;
    await server.close();
    await fake.close();
  });

  async function setup(options: { sleepMs?: number; socketFactory?: SocketFactory } = {}) {
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const join = await base.join({ name: "alice" });
    const client = base.withToken(join.token);
    const events: ChannelEvent[] = [];
    const sleeper = recordingSleep(options.sleepMs ?? 1);
    const injector = createInjector({
      roomId: fake.roomId,
      selfName: "alice",
      cursor: join.nextSince,
      emit: async (event) => {
        events.push(event);
      },
      saveCursor: async () => undefined,
      now: fakeClock().now,
      pending: new PendingTracker(),
      log: silentLogger,
    });
    transport = createTransport({
      client,
      roomId: fake.roomId,
      selfName: "alice",
      streamUrl: streamUrlFor(fake.baseUrl, fake.roomId),
      token: join.token,
      injector,
      emit: async (event) => {
        events.push(event);
      },
      joinedFromStream: async (welcome) => `joined over the stream with ${welcome.members.length}`,
      joinedFromPoll: async () => "joined over long-poll",
      waitSeconds: 1,
      sleep: sleeper.sleep,
      log: silentLogger,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    });
    transport.start();
    return { events, injector, sleeper, token: join.token };
  }

  it("injects the joined event from the welcome frame and streams messages", async () => {
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event");
    expect(events[0]).toEqual({
      content: "joined over the stream with 1",
      meta: { room: fake.roomId, event: "joined" },
    });
    expect(transport?.streaming).toBe(true);

    fake.push("bob", "over the socket");
    await waitFor(() => events.length === 2, "bob's message");
    expect(events[1]).toMatchObject({ content: "over the socket", meta: { from: "bob" } });
    expect(fake.pollRequests).toHaveLength(0);
  });

  it("sends a read frame after each injection", async () => {
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event");
    fake.push("bob", "please read this");
    await waitFor(() => events.length === 2, "bob's message");
    await waitFor(() => server.reads.some((read) => read.since === 2), "the read frame");
  });

  it("falls back to long-poll after three failed connects, then recovers", async () => {
    server.refuse = true;
    const { events, sleeper } = await setup();
    await waitFor(() => events.length === 1, "the joined event from the fallback");
    expect(events[0]?.content).toBe("joined over long-poll");
    expect(transport?.streaming).toBe(false);
    await waitFor(() => fake.pollRequests.length > 0, "a long poll");
    // The socket keeps trying, but only once a minute while long-poll works.
    await waitFor(() => sleeper.calls.includes(60_000), "the fallback retry interval");

    fake.push("bob", "over http");
    await waitFor(() => events.length === 2, "bob's message over long-poll");
    expect(events[1]?.content).toBe("over http");

    server.refuse = false;
    await waitFor(() => transport?.streaming === true, "the socket to come back");
    fake.push("bob", "over the socket again");
    await waitFor(() => events.length === 3, "bob's message over the socket");
    expect(events[2]?.content).toBe("over the socket again");
    // Exactly once: the poller must have stopped when the socket recovered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((event) => event.content === "over the socket again")).toHaveLength(1);
  });

  it("posts over the socket while it is up", async () => {
    const { events } = await setup({ sleepMs: 200 });
    await waitFor(() => events.length === 1, "the joined event");
    const posted = await transport?.post({ text: "on it" });
    expect(posted?.text).toBe("on it");
    expect(fake.messages.at(-1)).toMatchObject({ from: "alice", text: "on it" });
  });

  it("posts over HTTP when the socket is down", async () => {
    server.refuse = true;
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event from the fallback");
    const posted = await transport?.post({ text: "http instead" });
    expect(posted?.text).toBe("http instead");
    expect(fake.messages.at(-1)).toMatchObject({ from: "alice", text: "http instead" });
  });

  it("surfaces a room error from a socket post instead of retrying over HTTP", async () => {
    const { events } = await setup({ sleepMs: 200 });
    await waitFor(() => events.length === 1, "the joined event");
    await expect(transport?.post({ text: "key sk-live-abc" })).rejects.toMatchObject({
      code: "secret_detected",
    });
    expect(fake.messages.some((message) => message.text.includes("sk-live-"))).toBe(false);
  });

  it("answers members from the presence cache while streaming, and HTTP otherwise", async () => {
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event");
    const streamed = await transport?.members();
    expect(streamed?.members.map((member) => member.name)).toEqual(["alice"]);
    expect(streamed?.members[0]).toHaveProperty("connected", true);

    await transport?.stop();
    const overHttp = await transport?.members();
    expect(overHttp?.members.map((member) => member.name)).toEqual(["alice"]);
  });

  it("posts an over-sized reply over HTTP instead of the socket", async () => {
    const { events } = await setup({ sleepMs: 200 });
    await waitFor(() => events.length === 1, "the joined event");
    // 40 KiB of quotes escapes to a frame past the 64 KiB stream limit.
    const quoted = '"'.repeat(40 * 1024);
    const posted = await transport?.post({ text: quoted });
    expect(posted?.text).toBe(quoted);
    expect(fake.messages.filter((message) => message.text === quoted)).toHaveLength(1);
    // Nothing was on the wire to reconcile, so no idempotency key was needed.
    expect(fake.postKeys).toEqual([null]);
  });

  it("treats a post whose ack was lost as sent rather than posting it twice", async () => {
    // The post reaches the room, but its ack never reaches the client.
    const swallowAcks: SocketFactory = (url) => {
      const socket = defaultSocketFactory(url);
      return {
        ...socket,
        addEventListener: (type, listener) =>
          socket.addEventListener(type, (event) => {
            if (type === "message" && String(event.data ?? "").includes('"ack"')) return;
            listener(event);
          }),
      };
    };
    const { events } = await setup({ socketFactory: swallowAcks });
    await waitFor(() => events.length === 1, "the joined event");
    const posted = await transport?.post({ text: "landed anyway" });
    expect(posted?.text).toBe("landed anyway");
    expect(fake.messages.filter((message) => message.text === "landed anyway")).toHaveLength(1);
    // Reconciled by reading the room, so no HTTP post was made at all.
    expect(fake.postKeys).toEqual([]);
  });

  it("re-posts over HTTP under the stream post's id when nothing landed", async () => {
    // The post frame never leaves the client, so the room never saw it.
    const dropPosts: SocketFactory = (url) => {
      const socket = defaultSocketFactory(url);
      return {
        ...socket,
        send: (data: string) => {
          if (!data.includes('"post"')) socket.send(data);
        },
      };
    };
    const { events } = await setup({ socketFactory: dropPosts });
    await waitFor(() => events.length === 1, "the joined event");
    const posted = await transport?.post({ text: "never made it" });
    expect(posted?.text).toBe("never made it");
    expect(fake.messages.filter((message) => message.text === "never made it")).toHaveLength(1);
    expect(fake.postKeys).toHaveLength(1);
    expect(fake.postKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stops the socket loop when the long-poll fallback ends the room", async () => {
    server.refuse = true;
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event from the fallback");
    fake.mode = "archived";
    fake.push("system", "room closed");
    await transport?.done;
    // The socket loop must not outlive the poller's verdict: with the stream
    // endpoint answering again, nothing reconnects.
    server.refuse = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.openCount).toBe(0);
  });

  it("injects a final event and finishes when the room is archived", async () => {
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event");
    server.broadcastState("archived");
    await transport?.done;
    expect(events.at(-1)?.meta).toEqual({ room: fake.roomId, event: "archived" });
    expect(events.at(-1)?.content).toMatch(/archived/i);
  });

  it("finishes when the long-poll fallback sees the room archived", async () => {
    server.refuse = true;
    const { events } = await setup();
    await waitFor(() => events.length === 1, "the joined event from the fallback");
    fake.mode = "archived";
    fake.push("system", "room closed");
    await transport?.done;
    expect(events.at(-1)?.meta.event).toBe("archived");
  });
});
