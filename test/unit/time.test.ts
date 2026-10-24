import { describe, expect, it } from "vitest";
import { isoFromMs, nowMs, utcDayKey } from "../../src/util/time";

describe("time", () => {
  it("utcDayKey formats YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(Date.UTC(2026, 8, 7, 23, 59, 59))).toBe("2026-09-07");
    expect(utcDayKey(Date.UTC(2026, 8, 8, 0, 0, 0))).toBe("2026-09-08");
  });

  it("isoFromMs produces ISO strings", () => {
    expect(isoFromMs(Date.UTC(2026, 0, 1))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("nowMs is close to Date.now", () => {
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);
  });
});
