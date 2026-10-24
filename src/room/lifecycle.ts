import type { TierLimits } from "../config/tiers";
import { utcDayKey } from "../util/time";
import type { RoomState } from "./types";

export interface LiveBudget {
  readonly dayKey: string;
  readonly usedSeconds: number;
  readonly liveSince: number | null;
}

export function rolloverBudget(b: LiveBudget, nowMs: number): LiveBudget {
  const today = utcDayKey(nowMs);
  if (b.dayKey === today) return b;
  return { dayKey: today, usedSeconds: 0, liveSince: b.liveSince === null ? null : nowMs };
}

export function budgetUsedSeconds(b: LiveBudget, nowMs: number): number {
  const r = rolloverBudget(b, nowMs);
  const elapsed = r.liveSince === null ? 0 : Math.floor((nowMs - r.liveSince) / 1000);
  return r.usedSeconds + elapsed;
}

export function startLive(b: LiveBudget, nowMs: number): LiveBudget {
  const r = rolloverBudget(b, nowMs);
  return r.liveSince === null ? { ...r, liveSince: nowMs } : r;
}

export function stopLive(b: LiveBudget, nowMs: number): LiveBudget {
  const r = rolloverBudget(b, nowMs);
  if (r.liveSince === null) return r;
  return { dayKey: r.dayKey, usedSeconds: budgetUsedSeconds(r, nowMs), liveSince: null };
}

export function isBudgetExhausted(
  b: LiveBudget,
  nowMs: number,
  limitSeconds: number | null,
): boolean {
  if (limitSeconds === null) return false;
  return budgetUsedSeconds(b, nowMs) >= limitSeconds;
}

export interface IdleTransition {
  readonly state: RoomState;
  readonly alarmAt: number | null;
}

export function nextIdleTransition(
  state: RoomState,
  lastActivityMs: number,
  nowMs: number,
  limits: TierLimits,
): IdleTransition {
  if (state === "archived") return { state: "archived", alarmAt: null };
  const slowAt = lastActivityMs + limits.idleToSlowSeconds * 1000;
  const archiveAt = lastActivityMs + limits.idleToArchiveSeconds * 1000;
  if (nowMs >= archiveAt) return { state: "archived", alarmAt: null };
  if (state === "live" && nowMs < slowAt) return { state: "live", alarmAt: slowAt };
  return { state: "slow", alarmAt: archiveAt };
}
