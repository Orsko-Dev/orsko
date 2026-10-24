import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrskoClient } from "../src/client.js";
import { type ChannelEvent, createInjector } from "../src/inject.js";
import { PendingTracker } from "../src/pending.js";
import { createPoller, type Poller } from "../src/poller.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";
import { fakeClock, recordingSleep, silentLogger, waitFor } from "./support.js";

/** An injector that swallows its events, for tests about the loop itself. */
function quietInjector(roomId: string, cursor: number, now: () => number) {
  return createInjector({
    roomId,
    selfName: "alice",
    cursor,
    emit: async () => undefined,
    saveCursor: async () => undefined,
    now,
    pending: new PendingTracker(),
    log: silentLogger,
  });
}

describe("poller", () => {
  let fake: FakeOrsko;
  let poller: Poller | null = null;

  beforeEach(async () => {
    fake = await startFakeOrsko();
  });

  afterEach(async () => {
    if (poller) await poller.stop();
    poller = null;
    await fake.close();
  });

  async function setup(options: { waitSeconds?: number } = {}) {
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const join = await base.join({ name: "alice" });
    const events: ChannelEvent[] = [];
    const cursors: number[] = [];
    const clock = fakeClock();
    const sleeper = recordingSleep();
    const pending = new PendingTracker();
    const injector = createInjector({
      roomId: fake.roomId,
      selfName: "alice",
      cursor: join.nextSince,
      emit: async (event) => {
        events.push(event);
      },
      saveCursor: async (cursor) => {
        cursors.push(cursor);
      },
      now: clock.now,
      pending,
      log: silentLogger,
    });
    poller = createPoller({
      client: base.withToken(join.token),
      roomId: fake.roomId,
      injector,
      waitSeconds: options.waitSeconds ?? 25,
      sleep: sleeper.sleep,
      log: silentLogger,
    });
    poller.start();
    return { events, cursors, clock, sleeper, pending };
  }

  it("injects a message from another member with room, from, seq and kind meta", async () => {
    const { events, cursors } = await setup();
    fake.push("bob", "does the deploy look right?");
    await waitFor(() => events.length > 0, "bob's message");
    expect(events[0]).toEqual({
      content: "does the deploy look right?",
      meta: { room: fake.roomId, from: "bob", seq: "2", kind: "message" },
    });
    expect(cursors.at(-1)).toBe(2);
  });

  it("marks system messages with kind=system and lists attachments", async () => {
    const { events } = await setup();
    fake.push("system", "carol joined");
    fake.push("bob", "the log", ["a_1234", "a_5678"]);
    await waitFor(() => events.length >= 2, "two events");
    expect(events[0]?.meta.kind).toBe("system");
    expect(events[1]?.content).toBe("the log\nattachments: a_1234, a_5678");
  });

  it("skips the channel's own messages", async () => {
    const { events, cursors } = await setup();
    fake.push("alice", "this is mine");
    fake.push("bob", "this is not");
    await waitFor(() => events.length > 0, "bob's message");
    expect(events).toHaveLength(1);
    expect(events[0]?.meta.from).toBe("bob");
    expect(cursors.at(-1)).toBe(3);
  });

  it("sleeps for retryAfterSeconds in slow mode", async () => {
    const { sleeper } = await setup();
    fake.mode = "slow";
    fake.retryAfterSeconds = 7;
    await waitFor(() => sleeper.calls.length > 0, "a slow-mode sleep");
    expect(sleeper.calls[0]).toBe(7_000);
  });

  it("injects a final event and stops when the room is archived", async () => {
    const { events } = await setup();
    fake.push("bob", "last word");
    fake.mode = "archived";
    await poller?.done;
    expect(events.at(-1)?.meta).toEqual({ room: fake.roomId, event: "archived" });
    expect(events.at(-1)?.content).toMatch(/archived/i);
    expect(events.map((e) => e.content)).toContain("last word");
  });

  it("backs off from 2s and doubles after failures, then recovers", async () => {
    const { events, sleeper } = await setup();
    fake.failPolls = 3;
    fake.push("bob", "still here");
    await waitFor(() => events.length > 0, "recovery after backoff");
    expect(sleeper.calls.slice(0, 3)).toEqual([2_000, 4_000, 8_000]);
  });

  it("caps the backoff at 60s", async () => {
    const { sleeper } = await setup();
    fake.failPolls = 10;
    await waitFor(() => sleeper.calls.length >= 8, "eight backoffs");
    expect(Math.max(...sleeper.calls)).toBe(60_000);
  });

  it("prefixes resent lines for seqs unacknowledged for over a minute", async () => {
    const { events, clock, pending } = await setup();
    fake.push("bob", "first, unacknowledged");
    await waitFor(() => events.length === 1, "the first event");
    expect(pending.size).toBe(1);

    clock.advance(30_000);
    fake.push("bob", "second, still fresh");
    await waitFor(() => events.length === 2, "the second event");
    expect(events[1]?.content).toBe("second, still fresh");

    clock.advance(61_000);
    fake.push("bob", "third");
    await waitFor(() => events.length === 3, "the third event");
    expect(events[2]?.content).toBe(
      [
        "[resent, not yet acknowledged] bob (seq 2): first, unacknowledged",
        "[resent, not yet acknowledged] bob (seq 3): second, still fresh",
        "third",
      ].join("\n"),
    );
    // The resend cleared the backlog, so only the newest event stays pending.
    expect(pending.size).toBe(1);
  });

  it("stops when the token is rejected", async () => {
    const { events } = await setup();
    fake.rejectTokens = true;
    fake.push("bob", "you cannot see this");
    await poller?.done;
    expect(events.at(-1)?.meta.event).toBe("stopped");
  });

  it("sends the default waitSeconds=25 on the wire when not overridden", async () => {
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const join = await base.join({ name: "alice" });
    poller = createPoller({
      client: base.withToken(join.token),
      roomId: fake.roomId,
      injector: quietInjector(fake.roomId, join.nextSince, fakeClock().now),
      // waitSeconds intentionally omitted: exercise the default.
      sleep: recordingSleep().sleep,
      log: silentLogger,
    });
    poller.start();
    await waitFor(() => fake.pollRequests.length > 0, "the first poll request");
    expect(fake.pollRequests[0]?.waitSeconds).toBe(25);
  });

  it("includes pending, unacknowledged messages in the final archived event", async () => {
    const { events, pending } = await setup();
    fake.push("bob", "please review before you go");
    await waitFor(() => events.length > 0, "bob's message");
    expect(pending.size).toBe(1);

    // Setting `mode` alone does not wake an outstanding long poll (only
    // `push` does), so flip the mode first and then push a message on the
    // same tick, mirroring how the fake server wakes waiters elsewhere in
    // this file -- otherwise the next poll blocks for its full waitSeconds.
    fake.mode = "archived";
    fake.push("system", "room closed");
    await poller?.done;

    const last = events.at(-1);
    expect(last?.meta).toEqual({ room: fake.roomId, event: "archived" });
    expect(last?.content).toContain(
      "[resent, not yet acknowledged] bob (seq 2): please review before you go",
    );
    expect(last?.content).toMatch(/archived/i);
  });

  it("does not double-show a message that arrives together with the archived signal", async () => {
    const { events, pending } = await setup();
    fake.push("bob", "please review before you go");
    await waitFor(() => events.length > 0, "bob's first message");
    expect(pending.size).toBe(1);

    // Setting `mode` alone does not wake an outstanding long poll (only
    // `push` does), so flip the mode first and then push a message on the
    // same tick, mirroring how the fake server wakes waiters elsewhere in
    // this file -- otherwise the next poll blocks for its full waitSeconds.
    fake.mode = "archived";
    fake.push("bob", "and closing out");
    await poller?.done;

    // The new message, delivered in the same step that returned
    // mode: "archived", is injected exactly once as its own event...
    const injections = events.filter((event) => event.content === "and closing out");
    expect(injections).toHaveLength(1);
    expect(injections[0]?.meta.kind).toBe("message");

    // ...and must not also ride along on the final archived event, since
    // that would show it a second time framed as unacknowledged.
    const last = events.at(-1);
    expect(last?.meta).toEqual({ room: fake.roomId, event: "archived" });
    expect(last?.content).not.toContain("and closing out");

    // A message pending from an earlier poll, on the other hand, was never
    // injected in this final step, so it still must ride along.
    expect(last?.content).toContain(
      "[resent, not yet acknowledged] bob (seq 2): please review before you go",
    );
    expect(last?.content).toMatch(/archived/i);
  });

  it("does not crash the process when the failure path's sleep rejects", async () => {
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const join = await base.join({ name: "alice" });
    const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
    let rejectNextSleep = true;
    const sleep = async (_ms: number): Promise<void> => {
      if (rejectNextSleep) {
        rejectNextSleep = false;
        throw new Error("sleep boom");
      }
    };

    let crashed = false;
    const onUnhandledRejection = () => {
      crashed = true;
    };
    process.once("unhandledRejection", onUnhandledRejection);

    try {
      // One poll failure drives handleFailure's generic branch, which awaits
      // `rest(wait)` -> `deps.sleep`. That call is not wrapped in its own
      // try/catch, so before the fix its rejection escaped `run()` and
      // became an unhandled rejection on the `loop` promise nothing awaited.
      fake.failPolls = 1;
      poller = createPoller({
        client: base.withToken(join.token),
        roomId: fake.roomId,
        injector: quietInjector(fake.roomId, join.nextSince, Date.now),
        sleep,
        log: { event: (name, fields = {}) => events.push({ name, fields }) },
      });
      poller.start();

      await waitFor(() => events.some((e) => e.name === "channel.loop_crashed"), "the crash log");
      // Give a spare microtask turn for an unhandled rejection to have fired.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }

    expect(crashed).toBe(false);
    const crash = events.find((e) => e.name === "channel.loop_crashed");
    expect(crash?.fields.error).toBe("Error");
  });
});
