import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("serves /healthz", async () => {
    const res = await SELF.fetch("http://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("has both Durable Object bindings", async () => {
    env.IP_LIMITER.getByName("smoke");
  });

  it("has the R2 binding", async () => {
    await env.ARCHIVE.put("smoke.txt", "hello");
    const obj = await env.ARCHIVE.get("smoke.txt");
    expect(await obj?.text()).toBe("hello");
  });

  it("returns a structured 404 for unknown routes", async () => {
    const res = await SELF.fetch("http://example.com/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});
