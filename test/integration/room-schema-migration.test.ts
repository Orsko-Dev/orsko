import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomObject } from "../../src/room/RoomObject";
import { migrateMembers } from "../../src/room/storage";
import { generateRoomId } from "../../src/util/ids";

const OLD_ROOM_COLUMNS =
  "id, room_id, tier, state, purpose, created_at, last_activity_at, next_seq, budget_day, budget_used_seconds, budget_live_since, archived_at" as const;

const OLD_ROOM_TABLE = `
  CREATE TABLE room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    room_id TEXT NOT NULL, tier TEXT NOT NULL, state TEXT NOT NULL, purpose TEXT,
    created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, next_seq INTEGER NOT NULL,
    budget_day TEXT NOT NULL, budget_used_seconds INTEGER NOT NULL, budget_live_since INTEGER,
    archived_at INTEGER
  );
`;

const OLD_MEMBERS_COLUMNS =
  "member_id, name, name_lower, role, token_hash, joined_at, left_at" as const;

const OLD_MEMBERS_TABLE = `
  CREATE TABLE members (
    member_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, left_at INTEGER
  );
`;

function sqlOf(instance: RoomObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

function memberColumns(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('members')")
    .toArray()
    .map((r) => r.name);
}

/**
 * Puts `members` back into the shape it had before the presence columns
 * shipped, keeping the rows: exactly what a room created in production
 * before the change looks like on disk.
 */
function rewindMembersTable(sql: SqlStorage): void {
  sql.exec("ALTER TABLE members RENAME TO members_pre_presence");
  sql.exec(OLD_MEMBERS_TABLE);
  sql.exec(
    `INSERT INTO members (${OLD_MEMBERS_COLUMNS})
     SELECT ${OLD_MEMBERS_COLUMNS} FROM members_pre_presence`,
  );
  sql.exec("DROP TABLE members_pre_presence");
  sql.exec("CREATE INDEX IF NOT EXISTS members_name_lower ON members(name_lower)");
}

describe("members schema migration", () => {
  it("serves a pre-presence room through the public API alone", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const alice = await stub.join({ name: "alice", role: "agent" });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      rewindMembersTable(sql);
      expect(memberColumns(sql)).not.toContain("read_through");
      expect(memberColumns(sql)).not.toContain("last_seen_at");
    });
    // The live actor still holds the old schema in memory; drop it so the
    // next call takes the same path a deploy does for an existing room.
    await evictDurableObject(stub);

    const bob = await stub.join({ name: "bob", role: "agent" });
    expect(bob).toMatchObject({ ok: true });
    if (!bob.ok) return;
    const posted = await stub.postMessage(alice.value.token, {
      text: "still working",
      attachmentIds: [],
    });
    expect(posted).toMatchObject({ ok: true });
    const polled = await stub.poll(alice.value.token, { since: 0, waitSeconds: 0 });
    expect(polled).toMatchObject({ ok: true });
    if (!polled.ok) return;
    // A second poll acknowledges everything the first one returned, which is
    // what moves the read cursor to the end of the room.
    const caughtUp = await stub.poll(alice.value.token, {
      since: polled.value.nextSince,
      waitSeconds: 0,
    });
    expect(caughtUp).toMatchObject({ ok: true });
    const presence = await stub.members(alice.value.token);
    expect(presence).toMatchObject({ ok: true });
    if (!presence.ok) return;

    const names = presence.value.members.map((m) => m.name);
    expect(names).toEqual(["alice", "bob"]);
    const aliceRow = presence.value.members.find((m) => m.name === "alice");
    expect(aliceRow?.readThrough).toBe(presence.value.lastSeq);
    expect(aliceRow?.lastSeenAt).not.toBeNull();
  });

  it("is idempotent when the columns already exist", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      expect(() => {
        migrateMembers(sql);
        migrateMembers(sql);
      }).not.toThrow();
      expect(memberColumns(sql)).toContain("read_through");
      expect(memberColumns(sql)).toContain("last_seen_at");
    });
  });

  it("defaults the new columns for rows written before the change", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    await stub.join({ name: "carol", role: "agent" });

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      rewindMembersTable(sql);
      migrateMembers(sql);
      const row = sql
        .exec<{ read_through: number; last_seen_at: number | null }>(
          "SELECT read_through, last_seen_at FROM members WHERE name = 'carol'",
        )
        .one();
      expect(row.read_through).toBe(0);
      expect(row.last_seen_at).toBeNull();
    });
  });

  it("adds delivered_through at zero to a members table that predates it", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    await stub.join({ name: "dora", role: "agent" });

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      rewindMembersTable(sql);
      expect(memberColumns(sql)).not.toContain("delivered_through");
      migrateMembers(sql);
      const row = sql
        .exec<{ delivered_through: number }>(
          "SELECT delivered_through FROM members WHERE name = 'dora'",
        )
        .one();
      expect(row.delivered_through).toBe(0);
    });
  });
});

/**
 * Puts `room` back into the shape it had before `creator_user_id` and
 * `private` shipped, keeping the row: exactly what a room created in
 * production before the accounts change looks like on disk.
 */
function rewindRoomTable(sql: SqlStorage): void {
  sql.exec("ALTER TABLE room RENAME TO room_pre_accounts");
  sql.exec(OLD_ROOM_TABLE);
  sql.exec(
    `INSERT INTO room (${OLD_ROOM_COLUMNS})
     SELECT ${OLD_ROOM_COLUMNS} FROM room_pre_accounts`,
  );
  sql.exec("DROP TABLE room_pre_accounts");
}

function roomColumns(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('room')")
    .toArray()
    .map((r) => r.name);
}

describe("room table schema migration", () => {
  it("serves a pre-accounts room through the public API alone", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const alice = await stub.join({ name: "alice", role: "agent" });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      rewindRoomTable(sql);
      expect(roomColumns(sql)).not.toContain("creator_user_id");
      expect(roomColumns(sql)).not.toContain("private");
    });
    // The live actor still holds the old schema in memory; evict it so the
    // next call takes the same path a deploy does for an existing room.
    await evictDurableObject(stub);

    const meta = await stub.getMeta();
    expect(meta).not.toBeNull();
    expect(meta?.private).toBe(false);

    const bob = await stub.join({ name: "bob", role: "agent" });
    expect(bob).toMatchObject({ ok: true });
    if (!bob.ok) return;
    const posted = await stub.postMessage(alice.value.token, {
      text: "still working",
      attachmentIds: [],
    });
    expect(posted).toMatchObject({ ok: true });
  });

  it("gives a pre-outcome room no outcome and lets an agent record one", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const alice = await stub.join({ name: "alice", role: "agent" });
    if (!alice.ok) throw new Error("join failed");
    await runInDurableObject(stub, (instance: RoomObject) => {
      rewindRoomTable(sqlOf(instance));
      expect(roomColumns(sqlOf(instance))).not.toContain("outcome_text");
      expect(roomColumns(sqlOf(instance))).not.toContain("empty_nudge_at");
    });
    await evictDurableObject(stub);

    expect((await stub.getMeta())?.outcome).toBeNull();
    expect(await stub.setOutcome(alice.value.token, "migrated fine")).toMatchObject({ ok: true });
    expect((await stub.getMeta())?.outcome?.text).toBe("migrated fine");

    await runInDurableObject(stub, (instance: RoomObject) => {
      expect(roomColumns(sqlOf(instance))).toContain("empty_nudge_at");
    });
  });
});
