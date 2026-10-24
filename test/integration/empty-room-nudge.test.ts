import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EMPTY_ROOM_NUDGE_GRACE_MS, EMPTY_ROOM_NUDGE_MS } from "../../src/config/constants";
import { TIERS } from "../../src/config/tiers";
import type { RoomObject } from "../../src/room/RoomObject";
import { generateRoomId } from "../../src/util/ids";

const NUDGE_PREFIX = "No other agent has joined in 10 minutes.";

function ctxOf(instance: RoomObject): DurableObjectState {
  return (instance as unknown as { ctx: DurableObjectState }).ctx;
}

async function room() {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: null, tier: "free" });
  return { roomId, stub };
}

/** Moves every agent's join `ms` into the past, as if the clock had run on. */
async function joinedAgo(stub: DurableObjectStub<RoomObject>, ms: number): Promise<void> {
  await runInDurableObject(stub, (instance: RoomObject) => {
    ctxOf(instance).storage.sql.exec(
      "UPDATE members SET joined_at = ? WHERE role = 'agent'",
      Date.now() - ms,
    );
  });
}

async function nudges(stub: DurableObjectStub<RoomObject>): Promise<string[]> {
  return (await stub.transcript()).map((m) => m.text).filter((t) => t.startsWith(NUDGE_PREFIX));
}

async function emptyNudgeAt(stub: DurableObjectStub<RoomObject>): Promise<number | null> {
  return runInDurableObject(stub, (instance: RoomObject) => {
    const row = ctxOf(instance)
      .storage.sql.exec<{ empty_nudge_at: number | null }>(
        "SELECT empty_nudge_at FROM room WHERE id = 1",
      )
      .one();
    return row.empty_nudge_at;
  });
}

/**
 * Moves both the lone agent's join time and the room's last-activity clock
 * `ms` into the past, as if the clock had run on with nothing happening.
 * Unlike `joinedAgo`, this also ages `last_activity_at`, so it can simulate
 * a room old enough to owe both the nudge and an idle-lifecycle transition.
 */
async function agedRoom(stub: DurableObjectStub<RoomObject>, ms: number): Promise<void> {
  await runInDurableObject(stub, (instance: RoomObject) => {
    const past = Date.now() - ms;
    const sql = ctxOf(instance).storage.sql;
    sql.exec("UPDATE members SET joined_at = ? WHERE role = 'agent'", past);
    sql.exec("UPDATE room SET last_activity_at = ? WHERE id = 1", past);
  });
}

describe("empty-room nudge", () => {
  it("schedules the shared alarm for ten minutes after the first agent joins", async () => {
    const { stub } = await room();
    const before = Date.now();
    await stub.join({ name: "alice", role: "agent" });
    const after = Date.now();
    const alarm = await runInDurableObject(stub, (instance: RoomObject) =>
      ctxOf(instance).storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(alarm ?? 0).toBeGreaterThanOrEqual(before + EMPTY_ROOM_NUDGE_MS);
    expect(alarm ?? 0).toBeLessThanOrEqual(after + EMPTY_ROOM_NUDGE_MS);
  });

  it("posts the nudge once, with the room link, when the alarm finds one agent alone", async () => {
    const { roomId, stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await nudges(stub)).toEqual([
      `No other agent has joined in 10 minutes. Check that the room link reached them: ${env.PUBLIC_BASE_URL}/r/${roomId}`,
    ]);

    // The next alarm is the lifecycle one; it must not nudge again.
    await runDurableObjectAlarm(stub);
    expect(await nudges(stub)).toHaveLength(1);
  });

  it("does not nudge before ten minutes have passed", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    await runDurableObjectAlarm(stub);
    expect(await nudges(stub)).toEqual([]);
  });

  it("never nudges once a second agent has joined, even if it left again", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    const bob = await stub.join({ name: "bob", role: "agent" });
    if (!bob.ok) throw new Error("join failed");
    await stub.leave(bob.value.token);
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);
    await runDurableObjectAlarm(stub);
    expect(await nudges(stub)).toEqual([]);
  });

  it("does not nudge an agent that has already left", async () => {
    const { stub } = await room();
    const alice = await stub.join({ name: "alice", role: "agent" });
    if (!alice.ok) throw new Error("join failed");
    await stub.leave(alice.value.token);
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);
    await runDurableObjectAlarm(stub);
    expect(await nudges(stub)).toEqual([]);
  });

  it("ignores observers when counting agents", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    await stub.join({ name: "viewer-1", role: "observer" });
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);
    await runDurableObjectAlarm(stub);
    expect(await nudges(stub)).toHaveLength(1);
  });

  it("does not count as room activity: last_activity_at is unchanged after the nudge fires", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    const before = (await stub.getMeta())?.lastActivityAt;

    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await nudges(stub)).toHaveLength(1);
    expect((await stub.getMeta())?.lastActivityAt).toBe(before);
  });

  it("moves a lone agent's room from live to slow at join time + idleToSlowSeconds, and still stamps a too-late nudge without posting it, in the same alarm tick", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });

    // Old enough for the idle-to-slow transition (30 minutes) to be due in
    // the same alarm tick as the nudge — but the idle window alone puts the
    // nudge well past its own grace period, so it is stamped, not sent. Were
    // the stamp itself counted as activity, it would refresh
    // last_activity_at to "now" just before the lifecycle check ran, and the
    // room would stay live.
    await agedRoom(stub, TIERS.free.idleToSlowSeconds * 1000 + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await nudges(stub)).toEqual([]);
    expect(await emptyNudgeAt(stub)).not.toBeNull();
    expect((await stub.getMeta())?.state).toBe("slow");
  });

  it("still posts once when the nudge is overdue by less than the grace period", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + EMPTY_ROOM_NUDGE_GRACE_MS - 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await nudges(stub)).toHaveLength(1);
    expect(await emptyNudgeAt(stub)).not.toBeNull();
  });

  it("stamps empty_nudge_at without posting when the nudge is overdue by more than the grace period", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    // A room that has been sitting untouched since before this deploy: its
    // one agent joined long before the grace window even started.
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + EMPTY_ROOM_NUDGE_GRACE_MS + 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await nudges(stub)).toEqual([]);
    expect(await emptyNudgeAt(stub)).not.toBeNull();
  });

  it("leaves an already-slow room slow when the nudge fires", async () => {
    const { stub } = await room();
    await stub.join({ name: "alice", role: "agent" });
    await stub.forceState("slow", Date.now());
    await joinedAgo(stub, EMPTY_ROOM_NUDGE_MS + 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await nudges(stub)).toHaveLength(1);
    expect((await stub.getMeta())?.state).toBe("slow");
  });
});
