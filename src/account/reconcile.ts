import type { Env } from "../env";
import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { updateRoomState } from "./room-index";

/**
 * How quiet a room must be before the index is presumed stale. The room
 * object archives an idle room well inside a day, so a row still marked
 * live or slow after 26 hours means an index write was lost.
 */
const STALE_AFTER_MS = 26 * 3_600_000;

/** Rooms repaired per run, so one nightly pass stays inside a Worker's budget. */
const RECONCILE_LIMIT = 200;

/**
 * Rows deleted from one table per run. D1 has no `DELETE ... LIMIT`, so the
 * bound is a subselect of row ids; a backlog larger than this drains over
 * several nights rather than holding one pass open.
 */
const SWEEP_LIMIT = 500;

/** The tables the nightly sweep empties of expired rows, and nothing else. */
type SweptTable = "sessions" | "magic_links";

export interface ReconcileResult {
  readonly checked: number;
  readonly repaired: number;
  readonly expired: number;
  readonly failed: number;
  readonly sweptSessions: number;
  readonly sweptMagicLinks: number;
}

interface StaleRow {
  readonly room_id: string;
  readonly state: string;
  readonly archived_at: number | null;
}

async function repairOne(env: Env, row: StaleRow, now: number): Promise<"repaired" | "expired"> {
  const meta = await env.ROOM.getByName(row.room_id).getMeta();
  if (!meta) {
    // The object has no room table: its storage was deleted when the
    // archive retention ran out. The index records that and stops looking.
    await updateRoomState(env.DB, row.room_id, { expiredAt: now, reconciledAt: now });
    return "expired";
  }
  await updateRoomState(env.DB, row.room_id, {
    state: meta.state,
    lastActivityAt: Date.parse(meta.lastActivityAt),
    reconciledAt: now,
    ...(meta.state === "archived" && row.archived_at === null ? { archivedAt: now } : {}),
  });
  return "repaired";
}

/**
 * Deletes expired rows from one table, at most SWEEP_LIMIT of them, and
 * answers how many went. The table name is a literal from {@link SweptTable},
 * never caller input, so interpolating it into the statement is safe.
 */
async function deleteExpired(db: D1Database, table: SweptTable, now: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ${table}
       WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at < ? LIMIT ?)`,
    )
    .bind(now, SWEEP_LIMIT)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * The nightly cron pass. Rooms the index still believes are live or slow,
 * long after they should have gone quiet, are checked against the room
 * object itself — the only authority on a room's state — and the row is
 * brought back into line. Each room is repaired independently: one
 * unreachable object must not stop the rest of the pass.
 */
export async function reconcile(env: Env): Promise<ReconcileResult> {
  const now = nowMs();
  const stale = await env.DB.prepare(
    `SELECT room_id, state, archived_at FROM rooms
     WHERE state IN ('live', 'slow') AND last_activity_at < ? AND expired_at IS NULL
     ORDER BY reconciled_at ASC NULLS FIRST, last_activity_at ASC LIMIT ?`,
  )
    .bind(now - STALE_AFTER_MS, RECONCILE_LIMIT)
    .all<StaleRow>();
  let repaired = 0;
  let expired = 0;
  let failed = 0;
  for (const row of stale.results) {
    try {
      if ((await repairOne(env, row, now)) === "expired") expired += 1;
      else repaired += 1;
    } catch (error: unknown) {
      failed += 1;
      logEvent("index.reconcile_failed", {
        roomId: row.room_id,
        errorClass: error instanceof Error ? error.name : "unknown_error",
      });
      // Stamped even on failure: an object that keeps throwing must not
      // monopolize every future pass ahead of rooms that have never been
      // looked at. This write is best effort too — the row simply stays a
      // candidate next time if it also fails.
      try {
        await updateRoomState(env.DB, row.room_id, { reconciledAt: now });
      } catch {
        // Nothing more to do: the row is picked up again next run either way.
      }
    }
  }
  // Expired sessions and spent or stale magic links are dead weight: nothing
  // reads them, and both tables only grow. Invites are left alone on purpose
  // — an expired or spent one is the owner's history of who was let in, and
  // the list would lose rows it is meant to show.
  let sweptSessions = 0;
  let sweptMagicLinks = 0;
  try {
    sweptSessions = await deleteExpired(env.DB, "sessions", now);
    sweptMagicLinks = await deleteExpired(env.DB, "magic_links", now);
  } catch (error: unknown) {
    // The room pass already succeeded; a failed sweep only means the rows
    // stay another night.
    logEvent("index.sweep_failed", {
      errorClass: error instanceof Error ? error.name : "unknown_error",
    });
  }
  const result = {
    checked: stale.results.length,
    repaired,
    expired,
    failed,
    sweptSessions,
    sweptMagicLinks,
  };
  logEvent("index.reconciled", result);
  return result;
}
