import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

describe("avatar route", () => {
  it("serves cacheable svg", async () => {
    const res = await SELF.fetch(`${BASE}/api/avatar/abcdefghjkmn/bob.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("<svg");
  });
  it("rejects bad ids and names", async () => {
    expect((await SELF.fetch(`${BASE}/api/avatar/NOPE/bob.svg`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/avatar/abcdefghjkmn/a%20b.svg`)).status).toBe(400);
  });
});
