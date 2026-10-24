import { describe, expect, it, vi } from "vitest";
import { NO_TRACKING, roomTracker } from "../../src/analytics/track";
import type { Env } from "../../src/env";

function envWith(fields: Partial<Env>): Env {
  return fields as Env;
}

describe("roomTracker", () => {
  it("is the no-op tracker and schedules nothing when the API secret is missing", () => {
    const waitUntil = vi.fn();
    const track = roomTracker(envWith({ GA4_MEASUREMENT_ID: "G-TEST123" }), waitUntil);
    expect(track).toBe(NO_TRACKING);
    track("room-one", { name: "room_created", params: { private: false } });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("is the no-op tracker when the measurement id is missing", () => {
    const waitUntil = vi.fn();
    const track = roomTracker(envWith({ GA4_API_SECRET: "secret" }), waitUntil);
    expect(track).toBe(NO_TRACKING);
  });

  it("hands each event to waitUntil so the response never waits on Google", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((work: Promise<unknown>) => {
      pending.push(work);
    });
    const track = roomTracker(
      envWith({ GA4_MEASUREMENT_ID: "G-TEST123", GA4_API_SECRET: "secret-for-tests" }),
      waitUntil,
    );
    track("dvz35u66ge8v", { name: "room_joined", params: { role: "agent", via: "mcp" } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("measurement_id=G-TEST123");
    expect(String(init.body)).not.toContain("dvz35u66ge8v");
    expect(JSON.parse(String(init.body)).events[0]).toMatchObject({
      name: "room_joined",
      params: { role: "agent", via: "mcp" },
    });
    fetchSpy.mockRestore();
  });
});

describe("roomTracker with PostHog", () => {
  it("sends each room event to PostHog as well, without the room id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 200 }));
    const pending: Promise<unknown>[] = [];
    const track = roomTracker(
      envWith({
        GA4_MEASUREMENT_ID: "G-TEST123",
        GA4_API_SECRET: "secret-for-tests",
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_HOST: "https://us.i.posthog.com",
        COOKIE_SECRET: "cookie-secret",
      }),
      (work) => {
        pending.push(work);
      },
    );
    track("dvz35u66ge8v", { name: "room_created", params: { private: false } });
    await Promise.all(pending);
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.startsWith("https://www.google-analytics.com/mp/collect"))).toBe(
      true,
    );
    expect(urls).toContain("https://us.i.posthog.com/i/v0/e/");
    for (const call of fetchSpy.mock.calls)
      expect(String((call[1] as RequestInit).body)).not.toContain("dvz35u66ge8v");
    fetchSpy.mockRestore();
  });

  it("reports to PostHog alone when Google Analytics is not configured", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 200 }));
    const pending: Promise<unknown>[] = [];
    const track = roomTracker(
      envWith({
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_HOST: "https://us.i.posthog.com",
        COOKIE_SECRET: "c",
      }),
      (work) => {
        pending.push(work);
      },
    );
    expect(track).not.toBe(NO_TRACKING);
    track("room-one", { name: "room_viewed", params: { private: false } });
    await Promise.all(pending);
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://us.i.posthog.com/i/v0/e/",
    ]);
    fetchSpy.mockRestore();
  });
});
