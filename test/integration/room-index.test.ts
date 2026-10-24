import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_SIZE,
  listRoomsForUser,
  markMemberLeft,
  updateRoomState,
  upsertRoom,
  upsertRoomMember,
} from "../../src/account/room-index";
import { IndexWriter } from "../../src/room/index-writer";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

const BASE_URL = "https://orsko.test";

function roomInput(roomId: string, userId: string | null, at: number) {
  return {
    roomId,
    creatorUserId: userId,
    private: false,
    purpose: "p",
    createdAt: at,
    state: "live",
    lastActivityAt: at,
  };
}

async function seedUser(id: string): Promise<string> {
  await env.DB.prepare("INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, 'free', ?)")
    .bind(id, `${id}@example.com`, Date.now())
    .run();
  return id;
}

describe("room index", () => {
  it("is idempotent and never unlinks a room from its creator", async () => {
    const userId = await seedUser("u_idem");
    await upsertRoom(env.DB, roomInput("idem00000001", userId, 1_000));
    await upsertRoom(env.DB, { ...roomInput("idem00000001", null, 900), state: "slow" });
    const row = await env.DB.prepare(
      "SELECT creator_user_id, state, last_activity_at FROM rooms WHERE room_id = ?",
    )
      .bind("idem00000001")
      .first<{ creator_user_id: string; state: string; last_activity_at: number }>();
    expect(row).toMatchObject({ creator_user_id: userId, state: "slow", last_activity_at: 1_000 });
  });

  it("pages through a user's rooms newest first", async () => {
    const userId = await seedUser("u_page");
    const total = HISTORY_PAGE_SIZE + 3;
    for (let i = 0; i < total; i += 1) {
      await upsertRoom(env.DB, roomInput(`page${String(i).padStart(8, "0")}`, userId, 10_000 + i));
    }
    const first = await listRoomsForUser(env.DB, userId, "all", null, BASE_URL);
    expect(first.rooms).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.rooms[0]?.lastActivityAt).toBe(10_000 + total - 1);
    expect(first.rooms[0]?.url).toBe(`${BASE_URL}/r/${first.rooms[0]?.roomId}`);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRoomsForUser(env.DB, userId, "all", first.nextCursor, BASE_URL);
    expect(second.rooms).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    // A malformed cursor shows the first page rather than failing the request.
    const garbage = await listRoomsForUser(env.DB, userId, "all", "not-a-cursor", BASE_URL);
    expect(garbage.rooms).toHaveLength(HISTORY_PAGE_SIZE);
  });

  it("separates created from joined and reports both", async () => {
    const owner = await seedUser("u_owner");
    const guest = await seedUser("u_guest");
    await upsertRoom(env.DB, roomInput("own000000001", owner, 20_000));
    await upsertRoomMember(env.DB, {
      roomId: "own000000001",
      memberId: "m_guest0000000001",
      name: "bob",
      role: "agent",
      userId: guest,
      inviteId: null,
      joinedAt: 20_001,
      leftAt: null,
    });
    await upsertRoomMember(env.DB, {
      roomId: "own000000001",
      memberId: "m_owner0000000001",
      name: "alice",
      role: "agent",
      userId: owner,
      inviteId: null,
      joinedAt: 20_002,
      leftAt: null,
    });
    const created = await listRoomsForUser(env.DB, guest, "created", null, BASE_URL);
    expect(created.rooms).toHaveLength(0);
    const joined = await listRoomsForUser(env.DB, guest, "joined", null, BASE_URL);
    expect(joined.rooms[0]).toMatchObject({ roomId: "own000000001", yourRole: "joined" });
    expect(joined.rooms[0]?.members.map((m) => m.name)).toEqual(["bob", "alice"]);
    const ownerView = await listRoomsForUser(env.DB, owner, "all", null, BASE_URL);
    expect(ownerView.rooms[0]?.yourRole).toBe("both");
  });

  it("stamps a departure once and hides expired rooms", async () => {
    const userId = await seedUser("u_left");
    await upsertRoom(env.DB, roomInput("left00000001", userId, 30_000));
    await upsertRoomMember(env.DB, {
      roomId: "left00000001",
      memberId: "m_left00000000001",
      name: "carol",
      role: "observer",
      userId,
      inviteId: null,
      joinedAt: 30_001,
      leftAt: null,
    });
    await markMemberLeft(env.DB, "m_left00000000001", 30_100);
    await markMemberLeft(env.DB, "m_left00000000001", 30_200);
    const member = await env.DB.prepare("SELECT left_at FROM room_members WHERE member_id = ?")
      .bind("m_left00000000001")
      .first<{ left_at: number }>();
    expect(member?.left_at).toBe(30_100);
    await updateRoomState(env.DB, "left00000001", { expiredAt: 30_300 });
    expect((await listRoomsForUser(env.DB, userId, "all", null, BASE_URL)).rooms).toHaveLength(0);
    // An empty patch is a no-op rather than invalid SQL.
    await expect(updateRoomState(env.DB, "left00000001", {})).resolves.toBeUndefined();
  });
});

describe("index writer", () => {
  it("does nothing without a D1 binding", async () => {
    const writer = new IndexWriter(undefined);
    await writer.roomCreated(roomInput("nodb00000001", null, 1));
    await writer.memberLeft("nodb00000001", "m_x", 2);
    const row = await env.DB.prepare("SELECT room_id FROM rooms WHERE room_id = ?")
      .bind("nodb00000001")
      .first();
    expect(row).toBeNull();
  });

  it("swallows a failing write and keeps accepting later ones", async () => {
    const failing = {
      prepare: () => {
        throw new Error("d1 is down");
      },
    } as unknown as D1Database;
    const writer = new IndexWriter(failing);
    await expect(writer.stateChanged("fail00000001", "slow", 5)).resolves.toBeUndefined();
    await expect(writer.archived("fail00000001", 6)).resolves.toBeUndefined();
    await expect(writer.expired("fail00000001", 7)).resolves.toBeUndefined();
  });

  it("throttles activity() to at most one D1 write per room per throttle window", async () => {
    const userId = await seedUser("u_activity");
    await upsertRoom(env.DB, roomInput("act00000001", userId, 1_000));
    const writer = new IndexWriter(env.DB);

    writer.activity("act00000001", 1_100);
    // A second call a second later, well inside the 60s throttle, must not
    // move the stamp again.
    writer.activity("act00000001", 2_100);
    await flushWriterQueue(writer);
    const afterFirst = await env.DB.prepare("SELECT last_activity_at FROM rooms WHERE room_id = ?")
      .bind("act00000001")
      .first<{ last_activity_at: number }>();
    expect(afterFirst?.last_activity_at).toBe(1_100);

    // Past the throttle window, the next call writes again.
    writer.activity("act00000001", 1_100 + 60_000);
    await flushWriterQueue(writer);
    const afterSecond = await env.DB.prepare("SELECT last_activity_at FROM rooms WHERE room_id = ?")
      .bind("act00000001")
      .first<{ last_activity_at: number }>();
    expect(afterSecond?.last_activity_at).toBe(1_100 + 60_000);
  });
});

/** Drains an IndexWriter's chained write queue: every method returns void
 * or a promise that resolves once its own write (or no-op) settles, so any
 * public method's return value works as the drain point. */
async function flushWriterQueue(writer: IndexWriter): Promise<void> {
  await writer.stateChanged("__flush__", "live", 0);
}

describe("append mirrors activity through the throttle", () => {
  it("two posts in quick succession produce one D1 activity write", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    const readLastActivity = async () =>
      (
        await env.DB.prepare("SELECT last_activity_at FROM rooms WHERE room_id = ?")
          .bind(roomId)
          .first<{ last_activity_at: number }>()
      )?.last_activity_at;

    const firstPost = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ text: "one" }),
    });
    expect(firstPost.status).toBe(201);
    const afterFirst = await readLastActivity();
    expect(afterFirst).toBeDefined();

    const secondPost = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ text: "two" }),
    });
    expect(secondPost.status).toBe(201);
    const afterSecond = await readLastActivity();
    // The room's own SQLite row moved on both posts; the throttled mirror
    // into D1 did not move again on the second, well within the 60s window.
    expect(afterSecond).toBe(afterFirst);
  });
});
