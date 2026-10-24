import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import {
  budgetUsedSeconds,
  isBudgetExhausted,
  nextIdleTransition,
  rolloverBudget,
  startLive,
  stopLive,
} from "../../src/room/lifecycle";

const day = Date.UTC(2026, 8, 7, 10, 0, 0);

describe("live budget", () => {
  it("accrues elapsed while live", () => {
    const b = startLive({ dayKey: "2026-09-07", usedSeconds: 100, liveSince: null }, day);
    expect(budgetUsedSeconds(b, day + 60_000)).toBe(160);
  });

  it("stopLive folds elapsed into used", () => {
    const b = stopLive(
      startLive({ dayKey: "2026-09-07", usedSeconds: 0, liveSince: null }, day),
      day + 5000,
    );
    expect(b).toEqual({ dayKey: "2026-09-07", usedSeconds: 5, liveSince: null });
  });

  it("rollover resets on a new UTC day", () => {
    const b = { dayKey: "2026-09-06", usedSeconds: 999, liveSince: day - 1000 };
    expect(rolloverBudget(b, day)).toEqual({
      dayKey: "2026-09-07",
      usedSeconds: 0,
      liveSince: day,
    });
  });

  it("exhaustion respects null limit", () => {
    const b = { dayKey: "2026-09-07", usedSeconds: 21600, liveSince: null };
    expect(isBudgetExhausted(b, day, TIERS.free.liveWindowSecondsPerDay)).toBe(true);
    expect(isBudgetExhausted(b, day, null)).toBe(false);
  });
});

describe("idle transitions", () => {
  const limits = TIERS.free;
  it("live stays live before idleToSlow and schedules the slow alarm", () => {
    const r = nextIdleTransition("live", day, day + 1000, limits);
    expect(r).toEqual({ state: "live", alarmAt: day + limits.idleToSlowSeconds * 1000 });
  });

  it("live becomes slow after idleToSlow and schedules archive", () => {
    const r = nextIdleTransition("live", day, day + limits.idleToSlowSeconds * 1000, limits);
    expect(r).toEqual({ state: "slow", alarmAt: day + limits.idleToArchiveSeconds * 1000 });
  });

  it("slow becomes archived after idleToArchive", () => {
    const r = nextIdleTransition("slow", day, day + limits.idleToArchiveSeconds * 1000, limits);
    expect(r).toEqual({ state: "archived", alarmAt: null });
  });

  it("archived stays archived", () => {
    expect(nextIdleTransition("archived", day, day + 1, limits)).toEqual({
      state: "archived",
      alarmAt: null,
    });
  });
});
