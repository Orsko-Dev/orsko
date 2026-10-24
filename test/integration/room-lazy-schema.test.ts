import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import type { RoomObject } from "../../src/room/RoomObject";
import { generateRoomId } from "../../src/util/ids";

function tableNames(instance: RoomObject): string[] {
  const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .map((r) => r.name)
    .filter((n) => !n.startsWith("_cf") && !n.startsWith("sqlite_"));
}

describe("RoomObject lazy schema", () => {
  it("getMeta on a never-created room creates no tables", async () => {
    const stub = env.ROOM.getByName(generateRoomId());
    expect(await stub.getMeta()).toBeNull();
    await runInDurableObject(stub, (instance: RoomObject) => {
      expect(tableNames(instance)).not.toContain("room");
    });
  });

  it("every RPC on a never-created room returns room_not_found", async () => {
    const stub = env.ROOM.getByName(generateRoomId());
    expect(await stub.join({ name: "alice", role: "agent" })).toMatchObject({
      ok: false,
      code: "room_not_found",
    });
    expect(await stub.postMessage("t", { text: "hi", attachmentIds: [] })).toMatchObject({
      ok: false,
      code: "room_not_found",
    });
    expect(await stub.poll("t", { since: 0, waitSeconds: 0 })).toMatchObject({
      ok: false,
      code: "room_not_found",
    });
    expect(await stub.leave("t")).toMatchObject({ ok: false, code: "room_not_found" });
    expect(await stub.authorizeDownload("t", "a_0000000000000000")).toMatchObject({
      ok: false,
      code: "room_not_found",
    });
    expect(
      await stub.authorizeUpload("t", { filename: "a", size: 1, contentType: "x" }),
    ).toMatchObject({
      ok: false,
      code: "room_not_found",
    });
    expect(await stub.transcript()).toEqual([]);
    await runInDurableObject(stub, (instance: RoomObject) => {
      expect(tableNames(instance)).not.toContain("room");
    });
  });

  it("after retention expiry no tables remain and getMeta is null", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
    await runDurableObjectAlarm(stub);
    await stub.forceArchivedAt(Date.now() - (TIERS.free.archiveRetentionDays + 1) * 86400 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getMeta()).toBeNull();
    await runInDurableObject(stub, (instance: RoomObject) => {
      expect(tableNames(instance)).toEqual([]);
    });
  });
});
