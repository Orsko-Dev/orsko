import { describe, expect, it, vi } from "vitest";
import {
  buildPosthogEvent,
  posthogAssetsOrigin,
  posthogDistinctId,
  sendPosthogEvent,
} from "../../src/analytics/posthog";

const CONFIG = { host: "https://us.i.posthog.com", token: "phc_test", secret: "secret-for-tests" };

describe("posthogDistinctId", () => {
  it("is stable per room, differs between rooms, and never contains the room id", async () => {
    const a = await posthogDistinctId("secret", "dvz35u66ge8v");
    expect(await posthogDistinctId("secret", "dvz35u66ge8v")).toBe(a);
    expect(await posthogDistinctId("secret", "abcdefghjkmn")).not.toBe(a);
    expect(a).toMatch(/^room_[0-9a-f]{32}$/);
    expect(a).not.toContain("dvz35u66ge8v");
  });

  it("depends on the secret, so the id cannot be recomputed from a room link", async () => {
    expect(await posthogDistinctId("one", "dvz35u66ge8v")).not.toBe(
      await posthogDistinctId("two", "dvz35u66ge8v"),
    );
  });
});

describe("buildPosthogEvent", () => {
  it("carries the event, its params and no person profile", () => {
    const body = buildPosthogEvent("phc_test", "room_abc", {
      name: "room_joined",
      params: { role: "agent", via: "mcp" },
    });
    expect(body).toEqual({
      api_key: "phc_test",
      event: "room_joined",
      distinct_id: "room_abc",
      properties: { role: "agent", via: "mcp", source: "server", $process_person_profile: false },
    });
  });
});

describe("posthogAssetsOrigin", () => {
  it("maps the ingestion host to its static-assets host", () => {
    expect(posthogAssetsOrigin("https://us.i.posthog.com")).toBe("https://us-assets.i.posthog.com");
    expect(posthogAssetsOrigin("https://eu.i.posthog.com")).toBe("https://eu-assets.i.posthog.com");
  });
});

describe("sendPosthogEvent", () => {
  it("posts one capture to the ingestion endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendPosthogEvent(
      CONFIG,
      "dvz35u66ge8v",
      { name: "room_created", params: { private: false } },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { event: string; distinct_id: string };
    expect(body.event).toBe("room_created");
    expect(body.distinct_id).toMatch(/^room_[0-9a-f]{32}$/);
    // The room id — the room's only credential — never leaves the Worker.
    expect(String(init.body)).not.toContain("dvz35u66ge8v");
  });

  it("does nothing when PostHog is not configured", async () => {
    const fetchImpl = vi.fn();
    await sendPosthogEvent(
      { ...CONFIG, token: undefined },
      "r",
      { name: "room_viewed", params: {} },
      fetchImpl,
    );
    await sendPosthogEvent(
      { ...CONFIG, secret: undefined },
      "r",
      { name: "room_viewed", params: {} },
      fetchImpl,
    );
    await sendPosthogEvent(
      { ...CONFIG, host: undefined },
      "r",
      { name: "room_viewed", params: {} },
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws: a rejected or failed send is logged and swallowed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendPosthogEvent(
        CONFIG,
        "r",
        { name: "room_viewed", params: {} },
        async () => new Response(null, { status: 400 }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      sendPosthogEvent(CONFIG, "r", { name: "room_viewed", params: {} }, async () => {
        throw new TypeError("network down");
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});
