import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { archiveKey, attachmentKey } from "../../src/room/archive";
import type { RoomObject } from "../../src/room/RoomObject";
import { generateRoomId } from "../../src/util/ids";

async function liveRoom() {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: "p", tier: "free" });
  const a = await stub.join({ name: "alice", role: "agent" });
  if (!a.ok) throw new Error("join failed");
  return { roomId, stub, alice: a.value.token };
}

describe("RoomObject lifecycle", () => {
  it("alarm moves an idle live room to slow", async () => {
    const { stub, alice } = await liveRoom();
    await stub.forceState("live", Date.now() - (TIERS.free.idleToSlowSeconds + 1) * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.getMeta())?.state).toBe("slow");
    const p = await stub.poll(alice, { since: 0, waitSeconds: 10 });
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.mode).toBe("slow");
    expect(p.value.retryAfterSeconds).toBe(30);
  });

  it("a new message flips slow back to live", async () => {
    const { stub, alice } = await liveRoom();
    await stub.forceState("slow", Date.now());
    await stub.postMessage(alice, { text: "back", attachmentIds: [] });
    expect((await stub.getMeta())?.state).toBe("live");
  });

  it("exhausted daily live budget yields slow polls but still accepts posts", async () => {
    const { stub, alice } = await liveRoom();
    await stub.forceBudget(TIERS.free.liveWindowSecondsPerDay ?? 0);
    const p = await stub.poll(alice, { since: 0, waitSeconds: 10 });
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.mode).toBe("slow");
    expect((await stub.postMessage(alice, { text: "still ok", attachmentIds: [] })).ok).toBe(true);
  });

  it("holding a long-poll accrues live seconds", async () => {
    const { stub, alice } = await liveRoom();
    const first = await stub.poll(alice, { since: 0, waitSeconds: 0 });
    if (!first.ok) throw new Error("poll failed");
    await stub.poll(alice, { since: first.value.nextSince, waitSeconds: 1 });
    expect(await stub.debugBudgetUsedSeconds()).toBeGreaterThanOrEqual(1);
  });

  it("alarm archives a slow room to R2 and blocks posting", async () => {
    const { roomId, stub, alice } = await liveRoom();
    await stub.postMessage(alice, { text: "keep me", attachmentIds: [] });
    await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.getMeta())?.state).toBe("archived");
    const obj = await env.ARCHIVE.get(archiveKey("free", roomId, "transcript.jsonl"));
    const lines = (await obj?.text())?.trim().split("\n") ?? [];
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1] ?? "{}").text).toBe("keep me");
    expect(await stub.postMessage(alice, { text: "no", attachmentIds: [] })).toMatchObject({
      code: "room_archived",
    });
    expect(await stub.join({ name: "late", role: "agent" })).toMatchObject({
      code: "room_archived",
    });
    const t = await stub.transcript();
    expect(t.map((m) => m.text)).toEqual(["alice joined", "keep me"]);
    const p = await stub.poll(alice, { since: 0, waitSeconds: 5 });
    if (!p.ok) throw new Error("poll failed");
    expect(p.value.mode).toBe("archived");
  });

  it("final alarm after retention deletes storage", async () => {
    const { stub } = await liveRoom();
    await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
    await runDurableObjectAlarm(stub);
    await stub.forceArchivedAt(Date.now() - (TIERS.free.archiveRetentionDays + 1) * 86400 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getMeta()).toBeNull();
  });
});

describe("attachment archival", () => {
  it("moves live uploads under the tier prefix when the room archives", async () => {
    const { roomId, stub, alice } = await liveRoom();
    const auth = await stub.authorizeUpload(alice, {
      filename: "notes.txt",
      size: 5,
      contentType: "text/plain",
    });
    if (!auth.ok) throw new Error("authorize failed");
    const liveKey = attachmentKey("free", roomId, auth.value.attachmentId, "live");
    expect(auth.value.key).toBe(liveKey);
    await env.ARCHIVE.put(liveKey, "hello", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { filename: "notes.txt" },
    });
    const rec = await stub.recordAttachment(alice, {
      attachmentId: auth.value.attachmentId,
      filename: "notes.txt",
      size: 5,
      contentType: "text/plain",
    });
    expect(rec.ok).toBe(true);

    await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const archivedKey = attachmentKey("free", roomId, auth.value.attachmentId, "archived");
    const moved = await env.ARCHIVE.get(archivedKey);
    expect(await moved?.text()).toBe("hello");
    expect(moved?.httpMetadata?.contentType).toBe("text/plain");
    expect(moved?.customMetadata?.filename).toBe("notes.txt");
    expect(await env.ARCHIVE.get(liveKey)).toBeNull();

    const dl = await stub.authorizeDownload(alice, auth.value.attachmentId);
    if (!dl.ok) throw new Error("download auth failed");
    expect(dl.value.key).toBe(archivedKey);
  });
});

describe("live budget across actor restarts", () => {
  it("clears a stale budget_live_since when the actor is reconstructed", async () => {
    const { stub } = await liveRoom();
    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      sql.exec("UPDATE room SET budget_live_since = ? WHERE id = 1", Date.now() - 3_600_000);
    });
    expect(await stub.debugBudgetUsedSeconds()).toBeGreaterThan(3000);

    await evictDurableObject(stub);
    expect(await stub.getMeta()).not.toBeNull();
    const first = await stub.debugBudgetUsedSeconds();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await stub.debugBudgetUsedSeconds();
    expect(first).toBe(0);
    expect(second).toBe(first);
  });
});
