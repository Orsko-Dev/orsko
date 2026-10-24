import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { generateRoomId } from "../../src/util/ids";

async function roomWithTwo() {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: null, tier: "free" });
  const a = await stub.join({ name: "alice", role: "agent" });
  const b = await stub.join({ name: "bob", role: "agent" });
  const v = await stub.join({ name: "viewer-1", role: "observer" });
  if (!a.ok || !b.ok || !v.ok) throw new Error("join failed");
  return { roomId, stub, alice: a.value.token, bob: b.value.token, viewer: v.value.token };
}

describe("RoomObject messages", () => {
  it("posts and reads in order with increasing seq", async () => {
    const { stub, alice, bob } = await roomWithTwo();
    const m1 = await stub.postMessage(alice, { text: "hello", attachmentIds: [] });
    const m2 = await stub.postMessage(bob, { text: "hi", attachmentIds: [] });
    expect(m1.ok && m2.ok).toBe(true);
    if (!m1.ok || !m2.ok) return;
    expect(m2.value.seq).toBe(m1.value.seq + 1);
    const p = await stub.poll(alice, { since: 0, waitSeconds: 0 });
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.messages.map((m) => m.from)).toEqual(["system", "system", "alice", "bob"]);
    expect(p.value.nextSince).toBe(m2.value.seq);
    expect(p.value.mode).toBe("live");
  });

  it("long-poll wakes when a message arrives", async () => {
    const { stub, alice, bob } = await roomWithTwo();
    const first = await stub.poll(alice, { since: 0, waitSeconds: 0 });
    if (!first.ok) throw new Error("poll failed");
    const started = Date.now();
    const waiting = stub.poll(alice, { since: first.value.nextSince, waitSeconds: 10 });
    await new Promise((r) => setTimeout(r, 200));
    await stub.postMessage(bob, { text: "wake up", attachmentIds: [] });
    const p = await waiting;
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.messages.map((m) => m.text)).toEqual(["wake up"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("long-poll times out with an empty list", async () => {
    const { stub, alice } = await roomWithTwo();
    const first = await stub.poll(alice, { since: 0, waitSeconds: 0 });
    if (!first.ok) throw new Error("poll failed");
    const p = await stub.poll(alice, { since: first.value.nextSince, waitSeconds: 1 });
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.messages).toEqual([]);
    expect(p.value.nextSince).toBe(first.value.nextSince);
  });

  it("observers can poll but not post", async () => {
    const { stub, viewer } = await roomWithTwo();
    expect(await stub.postMessage(viewer, { text: "x", attachmentIds: [] })).toMatchObject({
      code: "forbidden",
    });
    expect((await stub.poll(viewer, { since: 0, waitSeconds: 0 })).ok).toBe(true);
  });

  it("rejects oversized text, unknown attachment ids, and bad tokens", async () => {
    const { stub, alice } = await roomWithTwo();
    const big = "x".repeat(32 * 1024 + 1);
    expect(await stub.postMessage(alice, { text: big, attachmentIds: [] })).toMatchObject({
      code: "message_too_large",
    });
    expect(
      await stub.postMessage(alice, { text: "x", attachmentIds: ["a_0000000000000000"] }),
    ).toMatchObject({
      code: "attachment_not_found",
    });
    expect(await stub.postMessage("bad", { text: "x", attachmentIds: [] })).toMatchObject({
      code: "invalid_token",
    });
    expect(await stub.poll("bad", { since: 0, waitSeconds: 0 })).toMatchObject({
      code: "invalid_token",
    });
  });

  it("rate limits a member at 60 posts per minute", async () => {
    const { stub, alice } = await roomWithTwo();
    // The counter is keyed by wall-clock minute, so a run that crosses a
    // minute boundary gets a fresh allowance: post until it refuses rather
    // than assuming the 61st call is the one that does.
    const attempts = 2 * TIERS.free.maxPostsPerMinutePerMember + 2;
    let refused: Awaited<ReturnType<typeof stub.postMessage>> | null = null;
    for (let i = 0; i < attempts && refused === null; i += 1) {
      const r = await stub.postMessage(alice, { text: `m${i}`, attachmentIds: [] });
      if (!r.ok) refused = r;
    }
    expect(refused).toMatchObject({ code: "rate_limited" });
    if (refused !== null && !refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("transcript returns everything without auth", async () => {
    const { stub, alice } = await roomWithTwo();
    await stub.postMessage(alice, { text: "t", attachmentIds: [] });
    const all = await stub.transcript();
    expect(all.at(-1)?.text).toBe("t");
  });
});

describe("token scoping", () => {
  it("rejects a token issued by another room", async () => {
    const roomA = generateRoomId();
    const stubA = env.ROOM.getByName(roomA);
    await stubA.create({ roomId: roomA, purpose: null, tier: "free" });
    const joined = await stubA.join({ name: "alice", role: "agent" });
    if (!joined.ok) throw new Error("join failed");
    const foreign = joined.value.token;

    const roomB = generateRoomId();
    const stubB = env.ROOM.getByName(roomB);
    await stubB.create({ roomId: roomB, purpose: null, tier: "free" });

    expect(await stubB.postMessage(foreign, { text: "hi", attachmentIds: [] })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await stubB.poll(foreign, { since: 0, waitSeconds: 0 })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await stubB.authorizeDownload(foreign, "a_0000000000000000")).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    // The same token still works in its own room.
    expect((await stubA.poll(foreign, { since: 0, waitSeconds: 0 })).ok).toBe(true);
  });
});
