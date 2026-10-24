import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

// First-party, cookieless measurement for the public pages: page views and key
// clicks are counted without consent because nothing is stored in the browser.
// GA4 forwarding is a no-op in tests (no GA4_API_SECRET binding).
function post(body: unknown, ip = "203.0.113.10"): Promise<Response> {
  return SELF.fetch(`${BASE}/api/pulse`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/pulse", () => {
  it("no longer answers the old /api/events path, which EasyPrivacy blocks for beacons", async () => {
    const res = await SELF.fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "page_view", path: "/" }),
    });
    expect(res.status).toBe(404);
  });

  it("accepts a page view", async () => {
    const res = await post({ name: "page_view", path: "/", referrer: "https://t.co/abc" });
    expect(res.status).toBe(204);
  });

  it("accepts a click on a known target, with campaign tags", async () => {
    const res = await post({
      name: "click",
      target: "start_room",
      path: "/",
      utm: { utm_source: "x", utm_campaign: "launch" },
    });
    expect(res.status).toBe(204);
  });

  it("accepts a video play", async () => {
    const res = await post({ name: "video_play", path: "/" });
    expect(res.status).toBe(204);
  });

  it("rejects unknown events, unknown click targets and targets on non-click events", async () => {
    expect((await post({ name: "purchase", path: "/" })).status).toBe(400);
    expect((await post({ name: "click", target: "anything", path: "/" })).status).toBe(400);
    expect((await post({ name: "click", path: "/" })).status).toBe(400);
    expect((await post({ name: "page_view", target: "start_room", path: "/" })).status).toBe(400);
  });

  it("rejects a path that is not a site path and unexpected campaign keys", async () => {
    expect((await post({ name: "page_view", path: "https://evil.example/" })).status).toBe(400);
    expect((await post({ name: "page_view", path: "/", utm: { gclid: "abc" } })).status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    expect((await post("not json")).status).toBe(400);
  });

  it("rejects an oversized body before parsing it", async () => {
    const res = await post({
      name: "page_view",
      path: "/",
      referrer: `https://x.example/${"a".repeat(8000)}`,
    });
    expect(res.status).toBe(400);
  });

  it("is same-origin only: no CORS headers are offered", async () => {
    const res = await post({ name: "page_view", path: "/" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
