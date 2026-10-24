import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_OBSERVERS_PER_ROOM, RECENT_MESSAGES_ON_JOIN } from "../../src/config/constants";
import { generateRoomId } from "../../src/util/ids";

function fresh() {
  const roomId = generateRoomId();
  return { roomId, stub: env.ROOM.getByName(roomId) };
}

describe("RoomObject create/join", () => {
  it("creates a room and reports metadata", async () => {
    const { roomId, stub } = fresh();
    const r = await stub.create({ roomId, purpose: "test", tier: "free" });
    expect(r.ok).toBe(true);
    const meta = await stub.getMeta();
    expect(meta?.roomId).toBe(roomId);
    expect(meta?.state).toBe("live");
    expect(meta?.purpose).toBe("test");
    expect(meta?.members).toEqual([]);
    expect(meta?.messageCount).toBe(0);
  });

  it("getMeta is null before create and create twice fails", async () => {
    const { roomId, stub } = fresh();
    expect(await stub.getMeta()).toBeNull();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const again = await stub.create({ roomId, purpose: null, tier: "free" });
    expect(again).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("join returns a token and records a system message", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const j = await stub.join({ name: "alice", role: "agent" });
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.value.name).toBe("alice");
    expect(j.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const meta = await stub.getMeta();
    expect(meta?.members.map((m) => m.name)).toEqual(["alice"]);
    expect(meta?.messageCount).toBe(1);
  });

  it("rejects duplicate names case-insensitively and frees them on leave", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const a = await stub.join({ name: "Alice", role: "agent" });
    expect((await stub.join({ name: "alice", role: "agent" })).ok).toBe(false);
    expect(await stub.join({ name: "alice", role: "agent" })).toMatchObject({ code: "name_taken" });
    if (!a.ok) return;
    expect((await stub.leave(a.value.token)).ok).toBe(true);
    expect((await stub.join({ name: "alice", role: "agent" })).ok).toBe(true);
  });

  it("enforces maxMembers for agents but not observers", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    for (let i = 0; i < 8; i += 1) {
      expect((await stub.join({ name: `a${i}`, role: "agent" })).ok).toBe(true);
    }
    expect(await stub.join({ name: "a9", role: "agent" })).toMatchObject({ code: "room_full" });
    expect((await stub.join({ name: "viewer-1", role: "observer" })).ok).toBe(true);
  });

  it("joining an empty room returns recent with only the join message", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const j = await stub.join({ name: "alice", role: "agent" });
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.value.recent).toHaveLength(1);
    expect(j.value.recent[0]?.text).toBe("alice joined");
    expect(j.value.recent[0]?.from).toBe("system");
    expect(j.value.nextSince).toBe(j.value.recent[0]?.seq);

    const poll = await stub.poll(j.value.token, { since: j.value.nextSince, waitSeconds: 0 });
    expect(poll.ok).toBe(true);
    if (!poll.ok) return;
    expect(poll.value.messages).toEqual([]);
  });

  it("joining a room with prior history returns the last 20 messages ending with the join message", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const poster = await stub.join({ name: "poster", role: "agent" });
    if (!poster.ok) throw new Error("join failed");
    for (let i = 0; i < 24; i += 1) {
      const posted = await stub.postMessage(poster.value.token, {
        text: `msg-${i}`,
        attachmentIds: [],
      });
      expect(posted.ok).toBe(true);
    }
    // 1 join system message + 24 posts = 25 prior messages.
    const j = await stub.join({ name: "bob", role: "agent" });
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.value.recent).toHaveLength(RECENT_MESSAGES_ON_JOIN);
    const seqs = j.value.recent.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(j.value.recent.at(-1)?.text).toBe("bob joined");
    expect(j.value.nextSince).toBe(j.value.recent.at(-1)?.seq);

    const poll = await stub.poll(j.value.token, { since: j.value.nextSince, waitSeconds: 0 });
    expect(poll.ok).toBe(true);
    if (!poll.ok) return;
    expect(poll.value.messages).toEqual([]);
  });

  it("an observer join does not add a system message and recent reflects that", async () => {
    const { roomId, stub } = fresh();
    await stub.create({ roomId, purpose: null, tier: "free" });
    const agent = await stub.join({ name: "alice", role: "agent" });
    if (!agent.ok) throw new Error("join failed");
    const before = agent.value.recent.length;
    const observer = await stub.join({ name: "viewer-1", role: "observer" });
    expect(observer.ok).toBe(true);
    if (!observer.ok) return;
    // No new system message was added for the observer join.
    expect(observer.value.recent).toHaveLength(before);
    expect(observer.value.recent.some((m) => m.text === "viewer-1 joined")).toBe(false);
  });

  it("join fails on an uncreated room and leave fails with a bad token", async () => {
    const { stub } = fresh();
    expect(await stub.join({ name: "x", role: "agent" })).toMatchObject({ code: "room_not_found" });
    const { roomId, stub: s2 } = fresh();
    await s2.create({ roomId, purpose: null, tier: "free" });
    expect(await s2.leave("nope")).toMatchObject({ code: "invalid_token" });
  });
});

describe("presence bounds", () => {
  it("caps observers per room and excludes left members from metadata", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const first = await stub.join({ name: "viewer-0", role: "observer" });
    if (!first.ok) throw new Error("join failed");
    for (let i = 1; i < MAX_OBSERVERS_PER_ROOM; i += 1) {
      expect((await stub.join({ name: `viewer-${i}`, role: "observer" })).ok).toBe(true);
    }
    expect(await stub.join({ name: "viewer-extra", role: "observer" })).toMatchObject({
      ok: false,
      code: "room_full",
    });
    // A departed observer frees its slot.
    expect((await stub.leave(first.value.token)).ok).toBe(true);
    expect((await stub.join({ name: "viewer-extra", role: "observer" })).ok).toBe(true);

    const agent = await stub.join({ name: "alice", role: "agent" });
    if (!agent.ok) throw new Error("join failed");
    expect((await stub.getMeta())?.members.map((m) => m.name)).toContain("alice");
    expect((await stub.leave(agent.value.token)).ok).toBe(true);
    const names = (await stub.getMeta())?.members.map((m) => m.name) ?? [];
    expect(names).not.toContain("alice");
    expect(names).not.toContain("viewer-0");
    expect(names).toHaveLength(MAX_OBSERVERS_PER_ROOM);
  });
});
