import type { TierLimits } from "../config/tiers";
import { logEvent } from "../util/log";
import { isoFromMs } from "../util/time";
import { archiveAttachments, writeArchive } from "./archive";
import type { IndexWriter } from "./index-writer";
import { nextIdleTransition } from "./lifecycle";
import type { MetaScope } from "./roomOps";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import type { RoomMeta, RoomState } from "./types";
import { deleteAllDeliveries } from "./webhook-store";

/**
 * What the alarm-driven lifecycle steps need from a RoomObject instance,
 * passed explicitly so the transitions can live outside the class.
 */
export interface LifecycleContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
  /** Mirrors every transition into the account index; never throws. */
  readonly index: IndexWriter;
  buildMeta(row: RoomRow, scope?: MetaScope): RoomMeta;
  limits(row: RoomRow): TierLimits;
  wake(): void;
  /** Announces a transition on the room's open stream sockets. */
  broadcastState(row: RoomRow, state: RoomState): void;
  /** When the earliest pending webhook delivery is due, or null if none is. */
  earliestDeliveryAt(): number | null;
  /** When the empty-room nudge is due, or null when none is owed. */
  nudgeDueAt(): number | null;
  onStorageDeleted(): void;
}

/**
 * The room has one alarm and three users of it — the lifecycle transition,
 * the next due webhook delivery, and the empty-room nudge — so every schedule
 * point is the earliest of them.
 */
function soonest(...times: readonly (number | null)[]): number | null {
  const due = times.filter((time): time is number => time !== null);
  return due.length === 0 ? null : Math.min(...due);
}

export async function scheduleIdleAlarm(
  ctx: LifecycleContext,
  row: RoomRow,
  now: number,
): Promise<void> {
  const t = nextIdleTransition(row.state, row.last_activity_at, now, ctx.limits(row));
  const alarmAt = soonest(t.alarmAt, ctx.earliestDeliveryAt(), ctx.nudgeDueAt());
  if (alarmAt !== null) await ctx.storage.setAlarm(alarmAt);
}

export async function runAlarm(ctx: LifecycleContext, row: RoomRow, now: number): Promise<void> {
  if (row.state === "archived") return expireIfDue(ctx, row, now);
  const t = nextIdleTransition(row.state, row.last_activity_at, now, ctx.limits(row));
  if (t.state === "archived") return archiveRoom(ctx, row, now);
  if (t.state !== row.state) {
    db.updateRoomRow(ctx.sql, { state: t.state });
    logEvent("room.state", { roomId: row.room_id, from: row.state, to: t.state });
    void ctx.index.stateChanged(row.room_id, t.state, row.last_activity_at);
    ctx.wake();
    ctx.broadcastState(row, t.state);
  }
  const alarmAt = soonest(t.alarmAt, ctx.earliestDeliveryAt(), ctx.nudgeDueAt());
  if (alarmAt !== null) await ctx.storage.setAlarm(alarmAt);
}

export async function archiveRoom(ctx: LifecycleContext, row: RoomRow, now: number): Promise<void> {
  // The archive record keeps every member ever present, including departed
  // ones; live metadata only lists who is still in the room.
  const meta = ctx.buildMeta(row, "all");
  const messages = db.listAllMessages(ctx.sql, row.room_id);
  const attachments = db.listAttachments(ctx.sql);
  // Attachments move first: a failure here leaves the room live so the
  // retry alarm can try again with nothing yet written to the archive.
  await archiveAttachments(
    ctx.bucket,
    meta.tier,
    row.room_id,
    attachments.map((a) => a.attachmentId),
  );
  await writeArchive(ctx.bucket, meta, messages, attachments, isoFromMs(now));
  db.deleteAllMessages(ctx.sql);
  // The messages a pending delivery would carry are gone, so the deliveries
  // go with them rather than retrying against nothing.
  deleteAllDeliveries(ctx.sql);
  db.updateRoomRow(ctx.sql, { state: "archived", archived_at: now });
  logEvent("room.state", { roomId: row.room_id, from: row.state, to: "archived" });
  logEvent("room.archive", {
    roomId: row.room_id,
    messageCount: messages.length,
    attachmentCount: attachments.length,
  });
  void ctx.index.archived(row.room_id, now);
  ctx.wake();
  // Last thing the sockets hear: the state frame, then a 4410 close.
  ctx.broadcastState(row, "archived");
  await ctx.storage.setAlarm(now + ctx.limits(row).archiveRetentionDays * 86400 * 1000);
}

export async function expireIfDue(ctx: LifecycleContext, row: RoomRow, now: number): Promise<void> {
  const dueAt = (row.archived_at ?? now) + ctx.limits(row).archiveRetentionDays * 86400 * 1000;
  if (now < dueAt) {
    await ctx.storage.setAlarm(dueAt);
    return;
  }
  await ctx.storage.deleteAll();
  logEvent("room.expire", { roomId: row.room_id });
  void ctx.index.expired(row.room_id, now);
  ctx.onStorageDeleted();
}
