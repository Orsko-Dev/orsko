import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

const REPO = "https://github.com/Orsko-Dev/orsko";

async function assetText(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status, path).toBe(200);
  return res.text();
}

describe("the open-source links on the site", () => {
  it("links the source from the landing page nav and footer", async () => {
    const html = await assetText("/index.html");
    const nav = html.slice(html.indexOf('<nav class="nav-links"'), html.indexOf("</nav>"));
    expect(nav).toContain(`href="${REPO}"`);
    const foot = html.slice(html.indexOf('<span class="foot-links">'));
    expect(foot.slice(0, foot.indexOf("</span>"))).toContain(`href="${REPO}"`);
  });

  it("turns Google Analytics and PostHog on only for orsko.dev itself", async () => {
    const js = await assetText("/site.js");
    expect(js).toContain('PRODUCTION_HOST = "orsko.dev"');
    // A self-hosted copy keeps its own cookieless counting, with no banner and
    // no Google or PostHog script, so it never reports into Orsko's projects.
    expect(js).toContain("window.location.hostname !== PRODUCTION_HOST");
  });
});
