import { SYSTEM_SENDER } from "../config/constants";
import { generateMessageId } from "../util/ids";
import { nowMs, utcDayKey } from "../util/time";
import { budgetUsedSeconds } from "./lifecycle";
import * as polling from "./polling";
import { RoomStreamHost } from "./RoomStreamHost";
import * as db from "./storage";
import type { RoomState } from "./types";
import * as hooks from "./webhook-store";

/**
 * The hooks the test suite drives the room with: they move the clock, the
 * budget and the delivery queue forward without waiting for real time. They
 * live apart from the room's own API so that reading RoomObject shows only
 * what production calls.
 */
export abstract class RoomTestHooks extends RoomStreamHost {
  /** Runs one webhook delivery pass to completion; owned by the room itself. */
  protected abstract flushDeliveries(): Promise<void>;

  async debugBudgetUsedSeconds(): Promise<number> {
    const row = this.room();
    return row ? budgetUsedSeconds(polling.budgetOf(row), nowMs()) : 0;
  }

  async forceState(state: RoomState, lastActivityMs: number): Promise<void> {
    if (!this.room()) return;
    db.updateRoomRow(this.sql, { state, last_activity_at: lastActivityMs });
    await this.ctx.storage.setAlarm(nowMs() + 60_000);
  }

  /** Test-only: pulls pending deliveries into the past and reports how many. */
  async forceDeliveryDue(): Promise<number> {
    if (!this.room()) return 0;
    return hooks.forceDeliveriesDue(this.sql);
  }

  /** Test-only: runs the delivery pass to completion instead of in the background. */
  async forceDeliveryFlush(): Promise<void> {
    if (!this.room()) return;
    await this.flushDeliveries();
  }

  /**
   * Test-only: writes `count` messages straight to the table, bypassing the
   * post path's per-minute rate limit, and answers with the room's new last
   * seq. It is how a test builds a room long enough to exercise the replay
   * cap without spending a minute of wall clock on it.
   */
  async forceSeedMessages(count: number): Promise<number> {
    const row = this.room();
    if (!row) return 0;
    const now = nowMs();
    let seq = row.next_seq;
    for (let i = 0; i < count; i += 1) {
      db.insertMessage(this.sql, row.room_id, {
        seq,
        id: generateMessageId(),
        from_name: SYSTEM_SENDER,
        text: `seeded ${i}`,
        attachment_ids: "[]",
        created_at: now,
      });
      seq += 1;
    }
    db.updateRoomRow(this.sql, { next_seq: seq, last_activity_at: now });
    return seq - 1;
  }

  async forceBudget(usedSeconds: number): Promise<void> {
    if (!this.room()) return;
    polling.saveBudget(this.sql, { dayKey: utcDayKey(nowMs()), usedSeconds, liveSince: null });
  }

  async forceArchivedAt(archivedAtMs: number): Promise<void> {
    if (!this.room()) return;
    db.updateRoomRow(this.sql, { archived_at: archivedAtMs });
    await this.ctx.storage.setAlarm(nowMs() + 60_000);
  }
}
