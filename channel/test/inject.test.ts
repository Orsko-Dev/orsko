import { describe, expect, it } from "vitest";
import type { Message } from "../src/client.js";
import { type ChannelEvent, createInjector } from "../src/inject.js";
import { PendingTracker } from "../src/pending.js";
import { fakeClock, silentLogger } from "./support.js";

const ROOM = "dvz35u66ge8v";

function message(seq: number, from: string, text: string, attachmentIds: string[] = []): Message {
  return {
    id: `msg_${seq}`,
    seq,
    roomId: ROOM,
    from,
    text,
    attachmentIds,
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}

function setup(cursor = 1) {
  const events: ChannelEvent[] = [];
  const cursors: number[] = [];
  const clock = fakeClock();
  const pending = new PendingTracker();
  const injector = createInjector({
    roomId: ROOM,
    selfName: "alice",
    cursor,
    emit: async (event) => {
      events.push(event);
    },
    saveCursor: async (next) => {
      cursors.push(next);
    },
    now: clock.now,
    pending,
    log: silentLogger,
  });
  return { events, cursors, clock, pending, injector };
}

describe("injector", () => {
  it("injects another member's message with routing meta and advances the cursor", async () => {
    const { events, cursors, injector } = setup();
    const injected = await injector.deliver([message(2, "bob", "look at the logs")], 2);
    expect([...injected]).toEqual([2]);
    expect(events[0]).toEqual({
      content: "look at the logs",
      meta: { room: ROOM, from: "bob", seq: "2", kind: "message" },
    });
    expect(cursors).toEqual([2]);
    expect(injector.cursor()).toBe(2);
  });

  it("skips the channel's own messages but still advances the cursor", async () => {
    const { events, injector } = setup();
    const injected = await injector.deliver([message(2, "alice", "mine")], 2);
    expect(injected.size).toBe(0);
    expect(events).toHaveLength(0);
    expect(injector.cursor()).toBe(2);
  });

  it("skips messages at or below the cursor, so two transports cannot double-inject", async () => {
    const { events, injector } = setup();
    await injector.deliver([message(2, "bob", "once")], 2);
    await injector.deliver([message(2, "bob", "once")], 2);
    expect(events).toHaveLength(1);
  });

  it("marks system messages and lists attachments", async () => {
    const { events, injector } = setup();
    await injector.deliver([message(2, "system", "carol joined")], 2);
    await injector.deliver([message(3, "bob", "the log", ["a_1", "a_2"])], 3);
    expect(events[0]?.meta.kind).toBe("system");
    expect(events[1]?.content).toBe("the log\nattachments: a_1, a_2");
  });

  it("prefixes resend lines for seqs unacknowledged for over a minute", async () => {
    const { events, clock, injector, pending } = setup();
    await injector.deliver([message(2, "bob", "first")], 2);
    expect(pending.size).toBe(1);
    clock.advance(61_000);
    await injector.deliver([message(3, "bob", "second")], 3);
    expect(events[1]?.content).toBe(
      ["[resent, not yet acknowledged] bob (seq 2): first", "second"].join("\n"),
    );
    expect(pending.size).toBe(1);
  });

  it("attaches the pending backlog to a terminal event, minus the excluded seqs", async () => {
    const { events, injector } = setup();
    await injector.deliver([message(2, "bob", "earlier")], 2);
    const injected = await injector.deliver([message(3, "bob", "just now")], 3);
    await injector.finish("archived", "Room closed.", injected);
    const last = events.at(-1);
    expect(last?.meta).toEqual({ room: ROOM, event: "archived" });
    expect(last?.content).toContain("[resent, not yet acknowledged] bob (seq 2): earlier");
    expect(last?.content).not.toContain("just now");
    expect(last?.content).toContain("Room closed.");
  });

  it("serialises overlapping deliveries so ordering and the cursor stay sound", async () => {
    const { events, injector } = setup();
    const first = injector.deliver([message(2, "bob", "one")], 2);
    const second = injector.deliver([message(3, "bob", "two")], 3);
    await Promise.all([first, second]);
    expect(events.map((event) => event.content)).toEqual(["one", "two"]);
    expect(injector.cursor()).toBe(3);
  });
});
