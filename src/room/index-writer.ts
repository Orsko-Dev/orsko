import * as index from "../account/room-index";
import { INDEX_ACTIVITY_THROTTLE_MS } from "../config/constants";
import { logEvent } from "../util/log";

/**
 * The room object's view of the account index in D1. Every method is best
 * effort: the room's own SQLite storage is authoritative, so an index write
 * that fails must never fail the RPC that triggered it. Failures are logged
 * as `index.write_failed` and the nightly `reconcile` pass repairs the row.
 *
 * A room constructed without a `DB` binding (older tests, a local run with
 * no D1) gets a writer that does nothing at all.
 *
 * Writes are chained rather than issued concurrently: a join followed by a
 * leave must reach D1 in that order, or the leave stamp would be lost when
 * the join row lands after it.
 */
export class IndexWriter {
  private readonly db: D1Database | undefined;
  private tail: Promise<void> = Promise.resolve();
  // The room object's own last_activity_at at the moment the index was last
  // told about it. A single scalar, not a map: one writer is constructed per
  // room object, so it only ever tracks that one room's activity.
  private lastActivityWriteAt: number | null = null;

  constructor(db: D1Database | undefined) {
    this.db = db;
  }

  /** Queues one write behind the writes already in flight, swallowing errors. */
  private run(op: string, roomId: string, write: (db: D1Database) => Promise<void>): Promise<void> {
    const db = this.db;
    if (!db) return this.tail;
    this.tail = this.tail.then(async () => {
      try {
        await write(db);
      } catch (error: unknown) {
        logEvent("index.write_failed", {
          roomId,
          op,
          errorClass: error instanceof Error ? error.name : "unknown_error",
        });
      }
    });
    return this.tail;
  }

  roomCreated(r: index.RoomIndexInput): Promise<void> {
    return this.run("room_created", r.roomId, (db) => index.upsertRoom(db, r));
  }

  memberJoined(m: index.RoomMemberInput): Promise<void> {
    return this.run("member_joined", m.roomId, (db) => index.upsertRoomMember(db, m));
  }

  memberLeft(roomId: string, memberId: string, leftAt: number): Promise<void> {
    return this.run("member_left", roomId, (db) => index.markMemberLeft(db, memberId, leftAt));
  }

  stateChanged(roomId: string, state: string, lastActivityAt: number): Promise<void> {
    return this.run("state_changed", roomId, (db) =>
      index.updateRoomState(db, roomId, { state, lastActivityAt }),
    );
  }

  archived(roomId: string, archivedAt: number): Promise<void> {
    return this.run("archived", roomId, (db) =>
      index.updateRoomState(db, roomId, { state: "archived", archivedAt }),
    );
  }

  expired(roomId: string, expiredAt: number): Promise<void> {
    return this.run("expired", roomId, (db) => index.updateRoomState(db, roomId, { expiredAt }));
  }

  /**
   * Mirrors a live room staying active, throttled to at most one D1 write
   * per {@link INDEX_ACTIVITY_THROTTLE_MS}. Without this, a room that never
   * changes state (no state flips, no joins or leaves) could go a whole day
   * without its history timestamp moving, even while agents post constantly.
   * Unlike the other methods this is a plain no-op, not a queued write, when
   * called inside the throttle window — nothing to await, nothing to log.
   */
  activity(roomId: string, lastActivityAt: number): void {
    if (
      this.lastActivityWriteAt !== null &&
      lastActivityAt - this.lastActivityWriteAt < INDEX_ACTIVITY_THROTTLE_MS
    ) {
      return;
    }
    this.lastActivityWriteAt = lastActivityAt;
    void this.run("activity", roomId, (db) =>
      index.updateRoomState(db, roomId, { lastActivityAt }),
    );
  }
}
