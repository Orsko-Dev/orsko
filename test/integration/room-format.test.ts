import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, createRoomViaHttp, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function createPrivate(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.9.2.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ private: true }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { roomId: string }).roomId;
}

async function mintInvite(cookie: string, roomId: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

describe("GET /r/:roomId?format=", () => {
  it("serves markdown for format=md even when the client asks for HTML", async () => {
    const { roomId } = await createRoomViaHttp();
    for (const format of ["md", "markdown", "MD"]) {
      const res = await SELF.fetch(`${BASE}/r/${roomId}?format=${format}`, {
        headers: { accept: BROWSER_ACCEPT },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(await res.text()).toContain(`# Orsko room ${roomId}`);
    }
  });

  it("serves the room details for format=json and the page for format=html", async () => {
    const { roomId } = await createRoomViaHttp();
    const json = await SELF.fetch(`${BASE}/r/${roomId}?format=json`, {
      headers: { accept: BROWSER_ACCEPT },
    });
    expect(json.status).toBe(200);
    expect(((await json.json()) as { roomId: string }).roomId).toBe(roomId);

    const html = await SELF.fetch(`${BASE}/r/${roomId}?format=html`, {
      headers: { accept: "text/markdown" },
    });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain('id="transcript"');
  });

  it("refuses any other format before touching the room", async () => {
    // abcdefghjkmn was never created: a 400 rather than a 404 shows the check ran first.
    for (const query of ["format=pdf", "format="]) {
      const res = await SELF.fetch(`${BASE}/r/abcdefghjkmn?${query}`, {
        headers: { accept: BROWSER_ACCEPT },
      });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({
        code: "invalid_request",
        message: "format must be md, markdown, json or html",
      });
    }
  });

  it("keeps a private room's markdown behind the gate and does not spend the invite", async () => {
    const owner = await signInViaMagicLink("format-private@example.com");
    const roomId = await createPrivate(owner);
    const invite = await mintInvite(owner, roomId);

    const denied = await SELF.fetch(`${BASE}/r/${roomId}?format=md`, {
      headers: { accept: BROWSER_ACCEPT },
    });
    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).code).toBe("invite_required");

    const allowed = await SELF.fetch(`${BASE}/r/${roomId}?format=md&invite=${invite}`, {
      headers: { accept: BROWSER_ACCEPT },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("## Private rooms");

    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "reader", invite }),
    });
    expect(join.status).toBe(201);
  });
});
