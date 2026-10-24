import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

describe("api keys", () => {
  it("mints, lists, uses, and revokes a key", async () => {
    const cookie = await signInViaMagicLink("keys@example.com");
    const mint = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ label: "laptop" }),
    });
    expect(mint.status).toBe(201);
    const { id, key } = (await mint.json()) as { id: string; key: string };
    const list = await SELF.fetch(`${BASE}/api/me/keys`, { headers: { cookie } });
    expect(((await list.json()) as { keys: { id: string }[] }).keys.map((k) => k.id)).toContain(id);
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { "x-orsko-key": key } });
    expect(me.status).toBe(200);
    const del = await SELF.fetch(`${BASE}/api/me/keys/${id}`, {
      method: "DELETE",
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(del.status).toBe(204);
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { "x-orsko-key": key } })).status).toBe(
      401,
    );
  });

  it("rejects key-authenticated requests to manage keys, but allows the session that minted the key", async () => {
    const cookie = await signInViaMagicLink("key-scope@example.com");
    const mint = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ label: "laptop" }),
    });
    expect(mint.status).toBe(201);
    const { id, key } = (await mint.json()) as { id: string; key: string };

    const list = await SELF.fetch(`${BASE}/api/me/keys`, { headers: { "x-orsko-key": key } });
    expect(list.status).toBe(401);
    expect(((await list.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "unauthorized",
      message: "sign in with your browser to manage keys",
    });

    const post = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: {
        "x-orsko-key": key,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ label: "should not mint" }),
    });
    expect(post.status).toBe(401);
    expect(((await post.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "unauthorized",
      message: "sign in with your browser to manage keys",
    });

    const del = await SELF.fetch(`${BASE}/api/me/keys/${id}`, {
      method: "DELETE",
      headers: { "x-orsko-key": key, "sec-fetch-site": "same-origin" },
    });
    expect(del.status).toBe(401);
    expect(((await del.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "unauthorized",
      message: "sign in with your browser to manage keys",
    });

    // The session-based flows still work for the same key.
    const sessionList = await SELF.fetch(`${BASE}/api/me/keys`, { headers: { cookie } });
    expect(sessionList.status).toBe(200);
    expect(
      ((await sessionList.json()) as { keys: { id: string }[] }).keys.map((k) => k.id),
    ).toContain(id);

    const sessionDel = await SELF.fetch(`${BASE}/api/me/keys/${id}`, {
      method: "DELETE",
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(sessionDel.status).toBe(204);
  });

  it("caps active keys at 10", async () => {
    const cookie = await signInViaMagicLink("cap@example.com");
    for (let i = 0; i < 10; i += 1) {
      const r = await SELF.fetch(`${BASE}/api/me/keys`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ label: `k${i}` }),
      });
      expect(r.status).toBe(201);
    }
    const r = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ label: "one more" }),
    });
    expect(r.status).toBe(409);
  });
});

describe("cross-site requests to the key routes", () => {
  it("refuses a key mint and a key revocation from another site", async () => {
    const cookie = await signInViaMagicLink("cross-keys@example.com");
    const mint = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ label: "laptop" }),
    });
    expect(mint.status).toBe(201);
    const { id } = (await mint.json()) as { id: string };

    const crossMint = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ label: "from elsewhere" }),
    });
    expect(crossMint.status).toBe(403);
    expect(((await crossMint.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const crossRevoke = await SELF.fetch(`${BASE}/api/me/keys/${id}`, {
      method: "DELETE",
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(crossRevoke.status).toBe(403);

    // Neither reached the database: one key, still active.
    const list = await SELF.fetch(`${BASE}/api/me/keys`, { headers: { cookie } });
    const { keys } = (await list.json()) as { keys: { id: string; revokedAt: number | null }[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id, revokedAt: null });
  });
});
