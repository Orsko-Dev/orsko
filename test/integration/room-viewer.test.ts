import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, BASE, joinViaHttp, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

/**
 * Makes every D1 statement whose SQL contains `match` fail, leaving the rest
 * of the database working. Mirrors the helper in invites.test.ts.
 */
function breakD1(match: string): { calls: () => number } {
  const real = env.DB.prepare.bind(env.DB);
  let hits = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(match)) {
      hits += 1;
      throw new Error("D1 is down");
    }
    return real(query);
  });
  return { calls: () => hits };
}

interface RoomView {
  private: boolean;
  viewer: { isOwner: boolean };
}

async function createAs(cookie: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.3.3.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { roomId: string }).roomId;
}

async function view(roomId: string, headers: Record<string, string> = {}): Promise<RoomView> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as RoomView;
}

async function mintKey(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/me/keys`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "viewer test" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

describe("viewer.isOwner on the room details", () => {
  it("is true for the creator's session on a public room", async () => {
    const owner = await signInViaMagicLink("viewer-own1@example.com");
    const roomId = await createAs(owner);
    expect((await view(roomId, { cookie: owner })).viewer).toEqual({ isOwner: true });
  });

  it("is true for the creator's API key", async () => {
    const owner = await signInViaMagicLink("viewer-own2@example.com");
    const roomId = await createAs(owner);
    const key = await mintKey(owner);
    expect((await view(roomId, { "x-orsko-key": key })).viewer.isOwner).toBe(true);
  });

  it("is false for another account and for an anonymous viewer", async () => {
    const owner = await signInViaMagicLink("viewer-own3@example.com");
    const other = await signInViaMagicLink("viewer-other3@example.com");
    const roomId = await createAs(owner);
    expect((await view(roomId, { cookie: other })).viewer.isOwner).toBe(false);
    expect((await view(roomId)).viewer.isOwner).toBe(false);
  });

  it("is true for the owner of a private room and false for its members", async () => {
    const owner = await signInViaMagicLink("viewer-own4@example.com");
    const roomId = await createAs(owner, { private: true });
    expect((await view(roomId, { cookie: owner })).viewer.isOwner).toBe(true);
    const invite = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: "{}",
    });
    const { token } = (await invite.json()) as { token: string };
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "guest", invite: token }),
    });
    const member = ((await join.json()) as { token: string }).token;
    expect((await view(roomId, authHeaders(member))).viewer.isOwner).toBe(false);
  });

  it("answers isOwner false instead of 500 when the viewer lookup fails on a public room", async () => {
    const owner = await signInViaMagicLink("viewer-d1down@example.com");
    const roomId = await createAs(owner);
    const broken = breakD1("SELECT user_id, expires_at");
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}`, { headers: { cookie: owner } });
    expect(broken.calls()).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoomView;
    expect(body.viewer).toEqual({ isOwner: false });
  });

  it("is false for everyone on an anonymous room", async () => {
    const viewer = await signInViaMagicLink("viewer-anon5@example.com");
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.3.4.5" },
      body: "{}",
    });
    const { roomId } = (await res.json()) as { roomId: string };
    expect((await view(roomId, { cookie: viewer })).viewer.isOwner).toBe(false);
  });
});

describe("the privacy switch", () => {
  it("lets the owner turn a public room private, keeps existing members in, and refuses others", async () => {
    const owner = await signInViaMagicLink("switch-own@example.com");
    const stranger = await signInViaMagicLink("switch-stranger@example.com");
    const roomId = await createAs(owner);
    const agent = await joinViaHttp(roomId, "early-agent");
    const flip = (cookie: string, value: boolean) =>
      SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ private: value }),
      });

    expect((await flip(stranger, true)).status).toBe(403);
    expect((await flip(owner, true)).status).toBe(204);
    expect((await view(roomId, { cookie: owner })).private).toBe(true);

    // The agent that joined while the room was public keeps reading and posting.
    expect((await view(roomId, authHeaders(agent))).private).toBe(true);
    const post = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(agent),
      body: JSON.stringify({ text: "still here" }),
    });
    expect(post.status).toBe(201);
    expect((await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).status).toBe(403);
  });
});
