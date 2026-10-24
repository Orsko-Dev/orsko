import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "../../src/account/reconcile";
import { createRoomViaHttp } from "../helpers";

afterEach(() => vi.restoreAllMocks());

describe("reconcile", () => {
  it("repairs a stale index row from the room object", async () => {
    const { roomId } = await createRoomViaHttp();
    await env.DB.prepare("UPDATE rooms SET state = 'live', last_activity_at = ? WHERE room_id = ?")
      .bind(Date.now() - 48 * 3_600_000, roomId)
      .run();
    await env.ROOM.getByName(roomId).forceState("archived", Date.now() - 48 * 3_600_000);
    const result = await reconcile(env);
    expect(result.checked).toBeGreaterThan(0);
    const row = await env.DB.prepare("SELECT state FROM rooms WHERE room_id = ?")
      .bind(roomId)
      .first<{ state: string }>();
    expect(row?.state).toBe("archived");
  });

  it("marks a room whose object storage is gone as expired", async () => {
    const stale = Date.now() - 48 * 3_600_000;
    await env.DB.prepare(
      "INSERT INTO rooms (room_id, creator_user_id, private, purpose, created_at, state, last_activity_at) VALUES (?, NULL, 0, NULL, ?, 'live', ?)",
    )
      .bind("gone000000001", stale, stale)
      .run();
    await reconcile(env);
    const row = await env.DB.prepare("SELECT expired_at FROM rooms WHERE room_id = ?")
      .bind("gone000000001")
      .first<{ expired_at: number | null }>();
    expect(row?.expired_at).not.toBeNull();
  });

  it("stamps reconciled_at on every attempted row, including one whose object is gone", async () => {
    const stale = Date.now() - 48 * 3_600_000;
    const ids = ["stv0000000001", "stv0000000002", "stv0000000003"] as const;
    for (const [i, id] of ids.entries()) {
      await env.DB.prepare(
        "INSERT INTO rooms (room_id, creator_user_id, private, purpose, created_at, state, last_activity_at) VALUES (?, NULL, 0, NULL, ?, 'live', ?)",
      )
        .bind(id, stale - i * 1_000, stale - i * 1_000)
        .run();
    }
    await reconcile(env);
    const rows = await env.DB.prepare(
      `SELECT room_id, reconciled_at FROM rooms WHERE room_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ room_id: string; reconciled_at: number | null }>();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results) expect(row.reconciled_at).not.toBeNull();
  });

  it("does not let a room that repairs to the same state starve a never-reconciled one", async () => {
    const stale = Date.now() - 48 * 3_600_000;
    // Room A: forced to "slow" and left that way, so repairing it leaves it
    // unchanged and therefore still a candidate on the next pass. Its
    // last_activity_at is older than room B's, so a naive
    // `ORDER BY last_activity_at ASC` would always pick it first.
    const { roomId: roomA } = await createRoomViaHttp();
    await env.ROOM.getByName(roomA).forceState("slow", stale - 100_000);
    await env.DB.prepare("UPDATE rooms SET state = 'slow', last_activity_at = ? WHERE room_id = ?")
      .bind(stale - 100_000, roomA)
      .run();
    await reconcile(env);
    const afterFirst = await env.DB.prepare(
      "SELECT reconciled_at, state FROM rooms WHERE room_id = ?",
    )
      .bind(roomA)
      .first<{ reconciled_at: number | null; state: string }>();
    expect(afterFirst?.reconciled_at).not.toBeNull();
    expect(afterFirst?.state).toBe("slow");

    // Room B: freshly stale, never reconciled, with a more recent
    // last_activity_at than room A.
    const { roomId: roomB } = await createRoomViaHttp();
    await env.ROOM.getByName(roomB).forceState("slow", stale - 50_000);
    await env.DB.prepare("UPDATE rooms SET state = 'slow', last_activity_at = ? WHERE room_id = ?")
      .bind(stale - 50_000, roomB)
      .run();

    const original = env.ROOM.getByName.bind(env.ROOM);
    const order: string[] = [];
    vi.spyOn(env.ROOM, "getByName").mockImplementation((id: string) => {
      order.push(id);
      return original(id);
    });
    await reconcile(env);
    // Room B, never reconciled, is looked at before room A, which was
    // already reconciled once — the fix that stops a repeatedly-repaired
    // room from monopolizing every pass ahead of one nobody has checked yet.
    const firstLookedAt = order.find((id) => id === roomA || id === roomB);
    expect(firstLookedAt).toBe(roomB);
  });
});

describe("nightly sweep", () => {
  it("deletes expired sessions and magic links and leaves live ones alone", async () => {
    const now = Date.now();
    const user = await env.DB.prepare(
      "INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, 'free', ?)",
    )
      .bind("u_sweep0000000001", "sweep@example.com", now)
      .run();
    expect(user.success).toBe(true);
    for (const [idHash, expiresAt] of [
      ["sweep-dead", now - 1_000],
      ["sweep-live", now + 86_400_000],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, '')",
      )
        .bind(idHash, "u_sweep0000000001", now, expiresAt)
        .run();
    }
    for (const [tokenHash, expiresAt] of [
      ["link-dead", now - 1_000],
      ["link-live", now + 600_000],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, 'sweep@example.com', ?, ?)",
      )
        .bind(tokenHash, now, expiresAt)
        .run();
    }
    const inviteRoom = "sweeproom0001";
    await env.DB.prepare(
      "INSERT INTO rooms (room_id, creator_user_id, private, purpose, created_at, state, last_activity_at) VALUES (?, ?, 1, NULL, ?, 'archived', ?)",
    )
      .bind(inviteRoom, "u_sweep0000000001", now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO invites (id, room_id, issued_by_user_id, token_hash, created_at, expires_at)
       VALUES ('inv_swept0001', ?, 'u_sweep0000000001', 'hash-swept', ?, ?)`,
    )
      .bind(inviteRoom, now, now - 1_000)
      .run();

    const result = await reconcile(env);
    expect(result.sweptSessions).toBeGreaterThanOrEqual(1);
    expect(result.sweptMagicLinks).toBeGreaterThanOrEqual(1);

    const sessions = await env.DB.prepare(
      "SELECT id_hash FROM sessions WHERE id_hash IN ('sweep-dead', 'sweep-live')",
    ).all<{ id_hash: string }>();
    expect(sessions.results.map((r) => r.id_hash)).toEqual(["sweep-live"]);

    const links = await env.DB.prepare(
      "SELECT token_hash FROM magic_links WHERE token_hash IN ('link-dead', 'link-live')",
    ).all<{ token_hash: string }>();
    expect(links.results.map((r) => r.token_hash)).toEqual(["link-live"]);

    // An expired invite is history, not litter: the sweep never touches it.
    const invite = await env.DB.prepare("SELECT id FROM invites WHERE id = 'inv_swept0001'").first<{
      id: string;
    }>();
    expect(invite?.id).toBe("inv_swept0001");
  });
});
