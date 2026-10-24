import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomObject } from "../../src/room/RoomObject";
import { migrateRoomSchema } from "../../src/room/storage";
import * as hooks from "../../src/room/webhook-store";
import { generateRoomId } from "../../src/util/ids";

const PRE_WEBHOOK_COLUMNS =
  "member_id, name, name_lower, role, token_hash, joined_at, left_at, read_through, last_seen_at" as const;

const PRE_WEBHOOK_MEMBERS = `
  CREATE TABLE members (
    member_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, left_at INTEGER,
    read_through INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER
  );
`;

function sqlOf(instance: RoomObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

function columns(sql: SqlStorage, table: string): string[] {
  return sql
    .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .toArray()
    .map((r) => r.name);
}

function tableExists(sql: SqlStorage, table: string): boolean {
  return (
    sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )
      .one().n > 0
  );
}

/** Puts the room back into the shape it had before webhooks shipped. */
function rewind(sql: SqlStorage): void {
  sql.exec("DROP TABLE IF EXISTS webhook_deliveries");
  sql.exec("ALTER TABLE members RENAME TO members_pre_webhook");
  sql.exec(PRE_WEBHOOK_MEMBERS);
  sql.exec(
    `INSERT INTO members (${PRE_WEBHOOK_COLUMNS})
     SELECT ${PRE_WEBHOOK_COLUMNS} FROM members_pre_webhook`,
  );
  sql.exec("DROP TABLE members_pre_webhook");
  sql.exec("CREATE INDEX IF NOT EXISTS members_name_lower ON members(name_lower)");
}

async function room() {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: null, tier: "free" });
  return { roomId, stub };
}

describe("webhook schema", () => {
  it("creates the deliveries table and member columns for a new room", async () => {
    const { stub } = await room();
    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      expect(tableExists(sql, "webhook_deliveries")).toBe(true);
      expect(columns(sql, "webhook_deliveries")).toEqual([
        "delivery_id",
        "member_id",
        "seq",
        "attempts",
        "next_at",
        "created_at",
      ]);
      expect(columns(sql, "members")).toEqual(
        expect.arrayContaining([
          "webhook_url",
          "webhook_secret",
          "webhook_status",
          "webhook_failures",
        ]),
      );
    });
  });

  it("migrates a room created before webhooks shipped", async () => {
    const { stub } = await room();
    const alice = await stub.join({ name: "alice", role: "agent" });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      rewind(sql);
      expect(tableExists(sql, "webhook_deliveries")).toBe(false);
      expect(columns(sql, "members")).not.toContain("webhook_url");
    });
    await evictDurableObject(stub);

    // The public API alone must bring the old room up to date.
    const bob = await stub.join({ name: "bob", role: "agent" });
    expect(bob).toMatchObject({ ok: true });
    const presence = await stub.members(alice.value.token);
    expect(presence).toMatchObject({ ok: true });
    if (!presence.ok) return;
    expect(presence.value.members.map((m) => m.webhookStatus)).toEqual([null, null]);

    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      expect(tableExists(sql, "webhook_deliveries")).toBe(true);
      const row = sql
        .exec<{ webhook_status: string | null; webhook_failures: number }>(
          "SELECT webhook_status, webhook_failures FROM members WHERE name = 'alice'",
        )
        .one();
      expect(row.webhook_status).toBeNull();
      expect(row.webhook_failures).toBe(0);
    });
  });

  it("is idempotent when everything already exists", async () => {
    const { stub } = await room();
    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      expect(() => {
        migrateRoomSchema(sql);
        migrateRoomSchema(sql);
      }).not.toThrow();
      expect(tableExists(sql, "webhook_deliveries")).toBe(true);
    });
  });
});

describe("delivery rows", () => {
  it("stores, finds due, reschedules and deletes", async () => {
    const { stub } = await room();
    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      expect(hooks.earliestDeliveryAt(sql)).toBeNull();

      hooks.insertDelivery(sql, { delivery_id: "d_a", member_id: "u_1", seq: 1, next_at: 100 }, 50);
      hooks.insertDelivery(sql, { delivery_id: "d_b", member_id: "u_2", seq: 1, next_at: 300 }, 50);
      expect(hooks.earliestDeliveryAt(sql)).toBe(100);
      expect(hooks.listDueDeliveries(sql, 99).map((d) => d.delivery_id)).toEqual([]);
      expect(hooks.listDueDeliveries(sql, 100).map((d) => d.delivery_id)).toEqual(["d_a"]);
      expect(hooks.listDueDeliveries(sql, 1000).map((d) => d.delivery_id)).toEqual(["d_a", "d_b"]);
      expect(hooks.listDueDeliveries(sql, 1000)[0]?.attempts).toBe(0);

      hooks.rescheduleDelivery(sql, "d_a", 1, 5000);
      const rescheduled = hooks.listDueDeliveries(sql, 5000).find((d) => d.delivery_id === "d_a");
      expect(rescheduled?.attempts).toBe(1);
      expect(rescheduled?.next_at).toBe(5000);
      expect(hooks.earliestDeliveryAt(sql)).toBe(300);

      hooks.deleteDelivery(sql, "d_a");
      expect(hooks.listDueDeliveries(sql, 10_000).map((d) => d.delivery_id)).toEqual(["d_b"]);
      hooks.deleteMemberDeliveries(sql, "u_2");
      expect(hooks.earliestDeliveryAt(sql)).toBeNull();
    });
  });

  it("drops every pending delivery when the room is cleared", async () => {
    const { stub } = await room();
    await runInDurableObject(stub, (instance: RoomObject) => {
      const sql = sqlOf(instance);
      hooks.insertDelivery(sql, { delivery_id: "d_c", member_id: "u_1", seq: 2, next_at: 1 }, 1);
      hooks.deleteAllDeliveries(sql);
      expect(hooks.earliestDeliveryAt(sql)).toBeNull();
    });
  });
});
