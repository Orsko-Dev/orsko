import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, logFailure } from "../../src/util/log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logEvent", () => {
  it("writes one JSON line with the level, event, fields, and timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("message.post", { roomId: "r1", seq: 4, archived: false, purpose: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("message.post");
    expect(parsed.roomId).toBe("r1");
    expect(parsed.seq).toBe(4);
    expect(parsed.archived).toBe(false);
    expect(parsed.purpose).toBeNull();
    expect(typeof parsed.at).toBe("string");
    expect(new Date(parsed.at as string).toISOString()).toBe(parsed.at);
  });

  it("accepts an event with no fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("room.expire", {});
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "info", event: "room.expire" });
  });
});

describe("logFailure", () => {
  it("writes the same shape at error level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("index.write_failed", { op: "invite.use", roomId: "r1" });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "error", event: "index.write_failed", op: "invite.use" });
    expect(typeof parsed.at).toBe("string");
  });
});
