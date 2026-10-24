import { MAX_POLL_BATCH, SLOW_MODE_RETRY_SECONDS } from "../config/constants";
import type { TierLimits } from "../config/tiers";
import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { isBudgetExhausted, type LiveBudget, startLive, stopLive } from "./lifecycle";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import type { PollResult } from "./types";
import type { WaiterRegistry } from "./waiters";

/** What reading and waiting need from a RoomObject instance. */
export interface PollContext {
  readonly sql: SqlStorage;
  readonly waiters: WaiterRegistry;
  room(): RoomRow | null;
  limits(row: RoomRow): TierLimits;
}

export function budgetOf(row: RoomRow): LiveBudget {
  return {
    dayKey: row.budget_day,
    usedSeconds: row.budget_used_seconds,
    liveSince: row.budget_live_since,
  };
}

export function saveBudget(sql: SqlStorage, b: LiveBudget): void {
  db.updateRoomRow(sql, {
    budget_day: b.dayKey,
    budget_used_seconds: b.usedSeconds,
    budget_live_since: b.liveSince,
  });
}

/**
 * The messages after `since` and the mode the caller should poll in next.
 * A room that has spent its daily live window reads as `slow` even while its
 * stored state is still `live`.
 */
export function readSince(ctx: PollContext, row: RoomRow, since: number): PollResult {
  const messages = db.listMessagesSince(ctx.sql, row.room_id, since, MAX_POLL_BATCH);
  const nextSince = messages.length > 0 ? (messages.at(-1)?.seq ?? since) : since;
  if (row.state === "archived") return { messages, nextSince, mode: "archived" };
  const exhausted = isBudgetExhausted(
    budgetOf(row),
    nowMs(),
    ctx.limits(row).liveWindowSecondsPerDay,
  );
  if (row.state === "slow" || exhausted) {
    return { messages, nextSince, mode: "slow", retryAfterSeconds: SLOW_MODE_RETRY_SECONDS };
  }
  return { messages, nextSince, mode: "live" };
}

/**
 * Holds the request until a message arrives or the wait runs out. The live
 * budget accrues only while at least one waiter is parked, so an idle room
 * costs nothing.
 */
export async function waitForMessage(
  ctx: PollContext,
  row: RoomRow,
  since: number,
  waitSeconds: number,
): Promise<{ woken: boolean; waitedMs: number }> {
  const started = nowMs();
  if (ctx.waiters.count() === 0) saveBudget(ctx.sql, startLive(budgetOf(row), started));
  const woken = await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = ctx.waiters.add(since, () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    });
    timer = setTimeout(() => {
      remove();
      resolve(false);
    }, waitSeconds * 1000);
  });
  if (ctx.waiters.count() === 0) {
    const current = ctx.room() ?? row;
    saveBudget(ctx.sql, stopLive(budgetOf(current), nowMs()));
  }
  return { woken, waitedMs: nowMs() - started };
}

/** What a poll asks for, once the Worker has validated the query. */
export interface PollInput {
  readonly since: number;
  readonly waitSeconds: number;
}

/**
 * One poll by an authenticated member: the answer now if there is one or the
 * caller will not wait, otherwise the answer once a message arrives or the
 * wait runs out.
 */
async function answerPoll(
  ctx: PollContext,
  row: RoomRow,
  memberId: string,
  input: PollInput,
): Promise<PollResult> {
  const immediate = readSince(ctx, row, input.since);
  if (immediate.messages.length > 0 || input.waitSeconds === 0) return immediate;
  if (immediate.mode !== "live") return immediate;
  const waited = await waitForMessage(ctx, row, input.since, input.waitSeconds);
  logEvent(waited.woken ? "poll.wake" : "poll.timeout", {
    roomId: row.room_id,
    memberId,
    waitedMs: waited.waitedMs,
  });
  return readSince(ctx, ctx.room() ?? row, input.since);
}

/**
 * Records how far the member has read, answers the poll, and records what the
 * answer handed over, so `unread` on the member's next post counts only what
 * arrived after it.
 */
export async function pollAs(
  ctx: PollContext,
  row: RoomRow,
  memberId: string,
  input: PollInput,
): Promise<PollResult> {
  db.advanceReadThrough(ctx.sql, memberId, input.since);
  const result = await answerPoll(ctx, row, memberId, input);
  db.advanceDeliveredThrough(ctx.sql, memberId, result.nextSince);
  return result;
}
