import { SYSTEM_SENDER } from "../config/constants";
import { generateMessageId } from "../util/ids";
import { logEvent } from "../util/log";
import type { IndexWriter } from "./index-writer";
import type { LifecycleContext } from "./lifecycleOps";
import { scheduleIdleAlarm } from "./lifecycleOps";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import * as socket from "./stream-socket";
import type { Message } from "./types";
import { enqueueDeliveries } from "./webhooks";

/**
 * What the append path needs from a RoomObject instance. It is the one place
 * a message enters the room, so it also owns everything a new message
 * implies: waking pollers and sockets, the room's state flipping back to
 * live, the webhook queue, and the idle alarm.
 */
export interface AppendContext {
  readonly sql: SqlStorage;
  readonly ctx: DurableObjectState;
  readonly index: IndexWriter;
  room(): RoomRow | null;
  lifecycle(): LifecycleContext;
  /** Wakes every long-poll waiter. */
  wake(): void;
  presentMemberIds(): ReadonlySet<string>;
  /** Starts a background webhook pass; failures are contained by the caller. */
  runDeliveries(roomId: string): void;
}

export function appendSystem(
  actx: AppendContext,
  row: RoomRow,
  text: string,
  now: number,
  activity = true,
): Message {
  return appendMessage(actx, row, SYSTEM_SENDER, text, [], now, activity);
}

/**
 * @param activity Whether this message counts as the room "doing something":
 *   `last_activity_at` moves to `now`, the room returns to `live`, and the
 *   index's activity mirror is told. Every caller except the empty-room
 *   nudge wants this (the default). The nudge is the system telling a lone
 *   agent that nothing has happened, so it must not itself count as
 *   something happening: passing `false` stores it, gives it the next seq,
 *   broadcasts and delivers it exactly like any other message, but leaves
 *   the room's activity clock and state untouched.
 */
export function appendMessage(
  actx: AppendContext,
  row: RoomRow,
  from: string,
  text: string,
  attachmentIds: readonly string[],
  now: number,
  activity = true,
): Message {
  const current = actx.room() ?? row;
  const msg = db.insertMessage(actx.sql, current.room_id, {
    seq: current.next_seq,
    id: generateMessageId(),
    from_name: from,
    text,
    attachment_ids: JSON.stringify(attachmentIds),
    created_at: now,
  });
  db.updateRoomRow(
    actx.sql,
    activity
      ? { next_seq: current.next_seq + 1, last_activity_at: now, state: "live" }
      : { next_seq: current.next_seq + 1 },
  );
  if (activity) {
    // Keeps the index's history timestamp from going stale for a room that
    // stays busy without ever changing state (see IndexWriter.activity for
    // the throttle). The state-change branch below covers its own timestamp.
    actx.index.activity(current.room_id, now);
  }
  actx.wake();
  const present = actx.presentMemberIds();
  // A message is what brings an idle room back to life, and the write above
  // has already flipped the state: socket holders that saw `slow` are told
  // it is live again, exactly as the alarm announces the other direction.
  if (activity && current.state !== "live") {
    logEvent("room.state", { roomId: current.room_id, from: current.state, to: "live" });
    void actx.index.stateChanged(current.room_id, "live", now);
    socket.broadcastState(actx.ctx, current.room_id, "live", present);
  }
  // Long-poll and stream coexist: waiters are woken above, socket holders
  // are pushed the same message here.
  socket.broadcastMessage(actx.ctx, msg, present);
  const queued = enqueueDeliveries(actx.sql, msg, now);
  // Reschedules from whatever last_activity_at and state actually are now:
  // unchanged for a non-activity message, bumped to live for everything else.
  void scheduleIdleAlarm(
    actx.lifecycle(),
    activity ? { ...current, last_activity_at: now, state: "live" } : current,
    now,
  );
  // A Durable Object stays active while a promise it started is pending,
  // so deliveries carry on after the RPC has answered. The alarm scheduled
  // above is the backstop if this actor is lost before they finish.
  if (queued > 0) actx.runDeliveries(current.room_id);
  return msg;
}
