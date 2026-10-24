import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, createRoomViaHttp } from "../helpers";

const MEASUREMENT_ID = "G-BMZS75YSKZ";
const ANALYTICS_TAG = '<script src="/site.js" async></script>';

async function assetText(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status, path).toBe(200);
  return res.text();
}

// Public marketing pages carry the browser GA tag. Room pages never do: the
// room link is the room's only credential and the page holds member tokens,
// so room activity is measured server-side instead (src/analytics/ga4.ts).
describe("analytics", () => {
  it("ships one browser loader that scrubs room links before anything reaches Google", async () => {
    const js = await assetText("/site.js");
    expect(js).toContain(`"${MEASUREMENT_ID}"`);
    expect(js).toContain("https://www.googletagmanager.com/gtag/js?id=");
    // Room paths are collapsed and only campaign parameters survive.
    expect(js).toContain("/r/:room");
    expect(js).toContain("utm_");
    expect(js).toContain("page_location");
    expect(js).toContain("page_referrer");
  });

  it("asks for consent and loads Google Analytics only after the visitor accepts", async () => {
    const js = await assetText("/site.js");
    // The choice is remembered per browser; storage failures fall back to asking again.
    expect(js).toContain('"orsko-analytics-consent"');
    expect(js).toContain('"granted"');
    expect(js).toContain('"denied"');
    // Nothing Google-related runs at load: gtag is injected only inside loadAnalytics,
    // which is reached only from a stored grant or the Accept button.
    const loaderStart = js.indexOf("function loadAnalytics(");
    expect(loaderStart).toBeGreaterThan(-1);
    const loaderEnd = js.indexOf("\n  }\n", loaderStart);
    expect(js.indexOf("googletagmanager")).toBeGreaterThan(loaderStart);
    expect(js.lastIndexOf("googletagmanager")).toBeLessThan(loaderEnd);
    expect(js.indexOf("dataLayer")).toBeGreaterThan(loaderStart);
    // The banner offers both choices as real buttons and can be reopened from the privacy page.
    expect(js).toContain('"Accept"');
    expect(js).toContain('"Decline"');
    expect(js).toContain("data-analytics-consent-reset");
    // The banner is built with DOM APIs, never HTML strings.
    expect(js).not.toContain("innerHTML");
    // Default tier: page views and key clicks go to the first-party endpoint for
    // every visitor, cookieless; the consented Google tag never sends its own page
    // view, so nothing is counted twice.
    expect(js).toContain('"/api/pulse"');
    // EasyPrivacy blocks beacon (ping) requests to /api/events; the loader never uses that path
    // and sends with a keepalive fetch first.
    expect(js).not.toContain("/api/events");
    expect(js).toContain("keepalive: true");
    expect(js).toContain("sendBeacon");
    expect(js).toContain("send_page_view: false");
    for (const target of [
      "start_room",
      "have_link",
      "copy_sentence",
      "connector_link",
      "copy_connector",
    ]) {
      expect(js, target).toContain(`"${target}"`);
    }
    expect(js).toContain("without cookies");
  });

  it("styles the consent banner in the shared stylesheet", async () => {
    const css = await assetText("/style.css");
    expect(css).toContain(".consent {");
    expect(css).toContain(".consent-actions");
    // It must stand out from the page: the inverted ground, in both themes.
    expect(css).toMatch(
      /\.consent \{[^}]*background: var\(--invert-bg\);[^}]*color: var\(--invert-fg\);/,
    );
    expect(css).toContain(".consent .btn-primary { background: var(--invert-fg);");
  });

  it("loads the tag in the head of every public marketing page", async () => {
    for (const path of ["/index.html", "/connect.html", "/brand.html", "/privacy.html"]) {
      const html = await assetText(path);
      expect(html, path).toContain(ANALYTICS_TAG);
      // brand.html omits the optional <head>, </head> and <body> tags, so its head is
      // taken to end at the first <style> block, which only the head may contain.
      const headEnd = html.indexOf("</head>");
      const limit = headEnd >= 0 ? headEnd : html.search(/<body[\s>]|<style[\s>]/);
      expect(limit, path).toBeGreaterThan(0);
      expect(html.indexOf(ANALYTICS_TAG), path).toBeLessThan(limit);
      // The id lives only in site.js.
      expect(html, path).not.toContain(MEASUREMENT_ID);
    }
  });

  it("keeps the tag on the Worker-served /connect and /brand responses", async () => {
    for (const path of ["/connect", "/brand"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: { accept: "text/html" } });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(ANALYTICS_TAG);
    }
  });

  it("never puts a third-party script on room, private, sign-in or account pages", async () => {
    for (const path of [
      "/room.html",
      "/private.html",
      "/signin.html",
      "/me.html",
      "/me/keys.html",
    ]) {
      const html = await assetText(path);
      expect(html, path).not.toContain("site.js");
      expect(html, path).not.toContain("googletagmanager");
    }
    const { roomId } = await createRoomViaHttp();
    const page = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("googletagmanager");
  });
});
