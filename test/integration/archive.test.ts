import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  archiveKey,
  readArchivedMeta,
  readArchivedRoom,
  readArchivedTranscript,
  writeArchive,
} from "../../src/room/archive";
import type { RoomMeta } from "../../src/room/types";

const meta: RoomMeta = {
  roomId: "archroom",
  purpose: "p",
  tier: "free",
  state: "archived",
  createdAt: "2026-09-07T00:00:00.000Z",
  lastActivityAt: "2026-09-07T00:30:00.000Z",
  messageCount: 0,
  attachmentCount: 0,
  members: [],
  private: false,
  outcome: null,
};

describe("archive reads", () => {
  it("readArchivedRoom returns null when nothing was written", async () => {
    expect(await readArchivedRoom(env.ARCHIVE, "free", "missing-room")).toBeNull();
  });

  it("readArchivedMeta returns null when nothing was written", async () => {
    expect(await readArchivedMeta(env.ARCHIVE, "free", "missing-room")).toBeNull();
  });

  it("readArchivedRoom and readArchivedMeta return the written record", async () => {
    await writeArchive(env.ARCHIVE, meta, [], [], "2026-09-07T01:00:00.000Z");
    const room = await readArchivedRoom(env.ARCHIVE, "free", meta.roomId);
    expect(room?.meta).toEqual(meta);
    expect(room?.archivedAt).toBe("2026-09-07T01:00:00.000Z");
    expect(await readArchivedMeta(env.ARCHIVE, "free", meta.roomId)).toEqual(meta);
  });

  it("readArchivedTranscript returns null when nothing was written", async () => {
    expect(await readArchivedTranscript(env.ARCHIVE, "free", "missing-room")).toBeNull();
  });

  it("archiveKey namespaces by tier, room, and file", () => {
    expect(archiveKey("paid", "r1", "room.json")).toBe("paid/rooms/r1/room.json");
  });
});
