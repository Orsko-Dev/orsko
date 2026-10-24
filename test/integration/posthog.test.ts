import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, createRoomViaHttp } from "../helpers";

async function assetText(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status, path).toBe(200);
  return res.text();
}

/**
 * Captures the upstream request the proxy makes, answering with `reply`. The
 * body is read inside the intercept: a request body belongs to the Worker's
 * I/O context and cannot be read later from the test's.
 */
function interceptUpstream(reply: () => Response = () => new Response("ok", { status: 200 })) {
  const seen: Request[] = [];
  const bodies: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    seen.push(request);
    bodies.push(request.body ? await request.clone().text() : "");
    return reply();
  });
  return { seen, bodies, spy };
}

describe("the /lens PostHog proxy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves PostHog's static bundle from the assets host", async () => {
    const { seen } = interceptUpstream(
      () => new Response("/* bundle */", { headers: { "content-type": "text/javascript" } }),
    );
    const res = await SELF.fetch(`${BASE}/lens/static/array.full.js?v=1`);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://us-assets.i.posthog.com/static/array.full.js?v=1");
    expect(seen[0]?.method).toBe("GET");
  });

  it("forwards event and recording posts to the ingestion host, body and query intact", async () => {
    const { seen, bodies } = interceptUpstream();
    const res = await SELF.fetch(`${BASE}/lens/e/?compression=gzip-js&ip=0&_=123`, {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": "203.0.113.9" },
      body: "compressed-bytes",
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe("https://us.i.posthog.com/e/?compression=gzip-js&ip=0&_=123");
    expect(seen[0]?.method).toBe("POST");
    expect(bodies[0]).toBe("compressed-bytes");
    // PostHog's approximate location comes from the visitor's address, not Cloudflare's.
    expect(seen[0]?.headers.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  it("never forwards the Orsko session cookie, a bearer token or an API key", async () => {
    const { seen } = interceptUpstream();
    await SELF.fetch(`${BASE}/lens/flags/?v=2`, {
      method: "POST",
      headers: {
        cookie: "orsko_session=secret-session; other=1",
        authorization: "Bearer member-token",
        "x-orsko-key": "orsko_key_secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const sent = seen[0];
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("x-orsko-key")).toBeNull();
    expect(sent?.headers.get("content-type")).toBe("application/json");
  });

  it("drops any cookie PostHog tries to set on orsko.dev", async () => {
    interceptUpstream(() => new Response("{}", { headers: { "set-cookie": "tracker=1; Path=/" } }));
    const res = await SELF.fetch(`${BASE}/lens/flags/?v=2`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses methods PostHog's browser SDK never uses", async () => {
    const { seen } = interceptUpstream();
    const res = await SELF.fetch(`${BASE}/lens/e/`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});

describe("PostHog on the site", () => {
  it("is set up in site.js through the first-party proxy with the full bundle", async () => {
    const js = await assetText("/site.js");
    expect(js).toContain("phc_o9osX9ZKYSRjJhbZzxirpezTA4kvDnCgmhMkZQ6hiw3L");
    expect(js).toContain('"/lens"');
    // The recorder ships inside array.full.js, so the blocked name
    // "posthog-recorder.js" is never requested.
    expect(js).toContain("/static/array.full.js");
    expect(js).not.toContain("i.posthog.com/static");
    expect(js).toContain("maskAllInputs: true");
    expect(js).toContain("maskCapturedNetworkRequestFn");
    expect(js).toContain("before_send");
    // Cookieless until the visitor accepts.
    expect(js).toContain('PERSIST_MEMORY = "memory"');
    expect(js).toContain('PERSIST_COOKIE = "localStorage+cookie"');
    expect(js).toContain("readConsent() === GRANTED ? PERSIST_COOKIE : PERSIST_MEMORY");
  });

  it("keeps the new room link out of replays and click capture", async () => {
    const js = await assetText("/start-room.js");
    expect(js).toMatch(/"result hidden ph-no-capture"|"result ph-no-capture hidden"/);
  });

  it("runs on the feedback page too, and still never on room, private, sign-in or account pages", async () => {
    expect(await assetText("/feedback.html")).toContain('<script src="/site.js" async></script>');
    for (const path of [
      "/room.html",
      "/private.html",
      "/signin.html",
      "/me.html",
      "/me/keys.html",
    ]) {
      const html = await assetText(path);
      expect(html, path).not.toContain("site.js");
      expect(html, path).not.toContain("posthog");
      expect(html, path).not.toContain("/lens");
    }
    const { roomId } = await createRoomViaHttp();
    const page = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    const html = await page.text();
    expect(html).not.toContain("site.js");
    expect(html).not.toContain("/lens");
  });

  it("is disclosed on the privacy page", async () => {
    const html = (await assetText("/privacy.html")).replace(/\s+/g, " ");
    expect(html).toContain("PostHog");
    expect(html).toContain("session recording");
    expect(html).toContain("never recorded");
    expect(html).toContain("ph_phc_");
  });
});
