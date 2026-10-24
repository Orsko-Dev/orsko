import { describe, expect, it, vi } from "vitest";
import { buildGa4Payload, ga4ClientId, sendGa4Event } from "../../src/analytics/ga4";

const CONFIG = { measurementId: "G-TEST123", apiSecret: "secret-for-tests" };

describe("ga4ClientId", () => {
  it("is stable for a room and never contains the room id", async () => {
    const a = await ga4ClientId("secret-for-tests", "dvz35u66ge8v");
    const b = await ga4ClientId("secret-for-tests", "dvz35u66ge8v");
    expect(a).toBe(b);
    expect(a).not.toContain("dvz35u66ge8v");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs across rooms and across secrets", async () => {
    const room1 = await ga4ClientId("secret-for-tests", "room-one");
    const room2 = await ga4ClientId("secret-for-tests", "room-two");
    const otherKey = await ga4ClientId("another-secret", "room-one");
    expect(room1).not.toBe(room2);
    expect(room1).not.toBe(otherKey);
  });
});

describe("buildGa4Payload", () => {
  it("wraps one event with the client id and an engagement time GA needs to count it", () => {
    const payload = buildGa4Payload("abc123", {
      name: "room_joined",
      params: { role: "agent", via: "mcp" },
    });
    expect(payload).toEqual({
      client_id: "abc123",
      non_personalized_ads: true,
      events: [
        {
          name: "room_joined",
          params: { role: "agent", via: "mcp", engagement_time_msec: 1 },
        },
      ],
    });
  });
});

describe("sendGa4Event", () => {
  it("does nothing when the API secret is not configured", async () => {
    const fetchImpl = vi.fn();
    await sendGa4Event(
      { measurementId: "G-TEST123", apiSecret: undefined },
      "room-one",
      { name: "room_created", params: { private: false } },
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the event to the Measurement Protocol endpoint without the room id", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await sendGa4Event(CONFIG, "dvz35u66ge8v", { name: "room_viewed", params: {} }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://www.google-analytics.com/mp/collect?measurement_id=G-TEST123&api_secret=secret-for-tests",
    );
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).not.toContain("dvz35u66ge8v");
    expect(JSON.parse(body).events[0].name).toBe("room_viewed");
  });

  it("swallows network failures and non-2xx responses so a request is never failed by analytics", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      sendGa4Event(CONFIG, "room-one", { name: "room_viewed", params: {} }, failing),
    ).resolves.toBeUndefined();
    const rejected = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      sendGa4Event(CONFIG, "room-one", { name: "room_viewed", params: {} }, rejected),
    ).resolves.toBeUndefined();
  });
});
