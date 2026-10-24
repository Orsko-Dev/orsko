import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

async function page(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status, path).toBe(200);
  return res.text();
}

// The privacy notice must describe what the product actually does; each fact
// asserted here is backed by code (see the comments on each expectation).
describe("privacy page", () => {
  it("is bundled as /privacy.html, which Workers Assets serves at /privacy", async () => {
    const html = await page("/privacy.html");
    expect(html).toContain("<title>Privacy — Orsko</title>");
    expect(html).toContain("<h1>Privacy</h1>");
    expect(html).toContain('<meta property="og:url" content="https://orsko.dev/privacy">');
  });

  it("names the contact for privacy requests", async () => {
    const html = await page("/privacy.html");
    expect(html).toContain('href="mailto:hello@orsko.dev"');
  });

  it("discloses Google Analytics and how room links are kept out of it", async () => {
    const html = await page("/privacy.html");
    expect(html).toContain("Google Analytics");
    // public/site.js collapses room ids and drops non-campaign parameters.
    expect(html).toContain("/r/:room");
    // src/analytics/ga4.ts: server-side room events carry no room id.
    expect(html).toContain("never sends a room link");
    expect(html).toContain("https://tools.google.com/dlpage/gaoptout");
  });

  it("explains that analytics waits for consent and lets the visitor change the choice", async () => {
    const html = await page("/privacy.html");
    // public/site.js loads Google Analytics only after Accept.
    expect(html).toContain("only after you accept");
    // The default tier: cookieless counting through /api/pulse (src/http/routes/events.ts).
    expect(html).toContain("without cookies");
    expect(html).toContain("changes every day");
    expect(html).toContain("orsko-analytics-consent");
    // The control public/site.js binds to reopen the banner.
    expect(html).toMatch(/<button type="button"[^>]*data-analytics-consent-reset[^>]*>/);
  });

  it("lists the cookies and browser storage the site sets", async () => {
    const html = await page("/privacy.html");
    // src/config/constants.ts SESSION_COOKIE and SESSION_TTL_MS (30 days).
    expect(html).toContain("orsko_session");
    expect(html).toContain("30 days");
    // public/theme.js stores the chosen theme.
    expect(html).toContain("orsko-theme");
  });

  it("states the room retention the code enforces", async () => {
    const html = await page("/privacy.html");
    // src/config/tiers.ts free tier: archiveRetentionDays 7.
    expect(html).toContain("7 days");
  });

  it("names the service providers that process data", async () => {
    const html = await page("/privacy.html");
    for (const provider of ["Cloudflare", "Google", "Resend", "GitHub"]) {
      expect(html, provider).toContain(provider);
    }
  });

  it("is linked from the landing page footer, with a working contact link", async () => {
    const html = await page("/index.html");
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain('<a href="mailto:hello@orsko.dev">Contact</a>');
    expect(html).not.toContain('<a href="#">Privacy</a>');
    expect(html).not.toContain('<a href="#">Contact</a>');
  });
});
