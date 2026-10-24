import { describe, expect, it } from "vitest";
import {
  PublicEventBody,
  scrubPath,
  scrubReferrer,
  toGa4Event,
  utcDay,
  visitorClientId,
} from "../../src/analytics/events";

const SITE = "https://orsko.dev";

describe("scrubPath", () => {
  it("keeps a plain site path", () => {
    expect(scrubPath("/connect")).toBe("/connect");
    expect(scrubPath("/")).toBe("/");
  });

  it("collapses room links and drops queries and fragments", () => {
    expect(scrubPath("/r/dvz35u66ge8v")).toBe("/r/:room");
    expect(scrubPath("/r/dvz35u66ge8v?invite=secret#observer=token")).toBe("/r/:room");
    expect(scrubPath("/?utm_source=x&invite=secret")).toBe("/");
  });
});

describe("scrubReferrer", () => {
  it("reduces an external referrer to its origin", () => {
    expect(scrubReferrer("https://t.co/abc123?x=1", SITE)).toBe("https://t.co");
  });

  it("keeps a same-origin referrer's path with room links collapsed", () => {
    expect(scrubReferrer("https://orsko.dev/r/dvz35u66ge8v?invite=s", SITE)).toBe(
      "https://orsko.dev/r/:room",
    );
  });

  it("is empty for a missing or malformed referrer", () => {
    expect(scrubReferrer(undefined, SITE)).toBe("");
    expect(scrubReferrer("not a url", SITE)).toBe("");
  });
});

describe("utcDay", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDay(Date.UTC(2026, 8, 14, 23, 59))).toBe("2026-09-14");
    expect(utcDay(Date.UTC(2026, 8, 15, 0, 0))).toBe("2026-09-15");
  });
});

describe("visitorClientId", () => {
  it("is stable within a day and rotates across days, never containing the IP", async () => {
    const a = await visitorClientId("secret", "2026-09-14", "203.0.113.10", "UA");
    const b = await visitorClientId("secret", "2026-09-14", "203.0.113.10", "UA");
    const nextDay = await visitorClientId("secret", "2026-09-15", "203.0.113.10", "UA");
    const otherVisitor = await visitorClientId("secret", "2026-09-14", "203.0.113.11", "UA");
    expect(a).toBe(b);
    expect(a).not.toBe(nextDay);
    expect(a).not.toBe(otherVisitor);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203.0.113.10");
  });
});

describe("PublicEventBody", () => {
  it("requires a target exactly for clicks", () => {
    expect(
      PublicEventBody.safeParse({ name: "click", target: "copy_sentence", path: "/" }).success,
    ).toBe(true);
    expect(PublicEventBody.safeParse({ name: "click", path: "/" }).success).toBe(false);
    expect(
      PublicEventBody.safeParse({ name: "page_view", target: "copy_sentence", path: "/" }).success,
    ).toBe(false);
  });
});

describe("toGa4Event", () => {
  it("maps a page view onto GA's page_view with a scrubbed location and campaign tags", () => {
    const event = toGa4Event(
      {
        name: "page_view",
        path: "/r/dvz35u66ge8v?invite=secret",
        referrer: "https://news.ycombinator.com/item?id=1",
        utm: { utm_source: "hn", utm_campaign: "launch" },
      },
      SITE,
    );
    expect(event).toEqual({
      name: "page_view",
      params: {
        page_location: "https://orsko.dev/r/:room?utm_source=hn&utm_campaign=launch",
        page_referrer: "https://news.ycombinator.com",
      },
    });
  });

  it("maps a click onto cta_click with its target, and a video play onto video_start", () => {
    expect(toGa4Event({ name: "click", target: "start_room", path: "/" }, SITE)).toEqual({
      name: "cta_click",
      params: { target: "start_room", page_location: "https://orsko.dev/" },
    });
    expect(toGa4Event({ name: "video_play", path: "/" }, SITE)).toEqual({
      name: "video_start",
      params: { page_location: "https://orsko.dev/" },
    });
  });
});
