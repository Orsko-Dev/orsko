import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

async function createRoomAs(cookie: string, body: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.1.1.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { roomId: string };
}

describe("history", () => {
  it("lists rooms created while signed in", async () => {
    const cookie = await signInViaMagicLink("h1@example.com");
    const { roomId } = await createRoomAs(cookie, { purpose: "mine" });
    const res = await SELF.fetch(`${BASE}/api/me/rooms`, { headers: { cookie } });
    const body = (await res.json()) as {
      rooms: { roomId: string; yourRole: string; purpose: string }[];
    };
    expect(body.rooms.map((r) => r.roomId)).toContain(roomId);
    expect(body.rooms.find((r) => r.roomId === roomId)).toMatchObject({
      yourRole: "creator",
      purpose: "mine",
    });
  });

  it("lists rooms joined with an api key, with member avatars", async () => {
    const owner = await signInViaMagicLink("h2@example.com");
    const { roomId } = await createRoomAs(owner);
    const joiner = await signInViaMagicLink("h3@example.com");
    const mint = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: {
        cookie: joiner,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ label: "k" }),
    });
    const { key } = (await mint.json()) as { key: string };
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orsko-key": key },
      body: JSON.stringify({ name: "bob" }),
    });
    expect(join.status).toBe(201);
    const res = await SELF.fetch(`${BASE}/api/me/rooms?filter=joined`, {
      headers: { cookie: joiner },
    });
    const body = (await res.json()) as {
      rooms: {
        roomId: string;
        yourRole: string;
        members: { name: string; avatarSeed: string }[];
      }[];
    };
    const room = body.rooms.find((r) => r.roomId === roomId);
    expect(room?.yourRole).toBe("joined");
    expect(room?.members.find((m) => m.name === "bob")?.avatarSeed).toMatch(/^[0-9a-f]{16}$/);
    const ownerView = await SELF.fetch(`${BASE}/api/me/rooms?filter=joined`, {
      headers: { cookie: owner },
    });
    expect(
      ((await ownerView.json()) as { rooms: { roomId: string }[] }).rooms.map((r) => r.roomId),
    ).not.toContain(roomId);
  });

  it("anonymous rooms are not indexed to anyone and history requires sign-in", async () => {
    expect((await SELF.fetch(`${BASE}/api/me/rooms`)).status).toBe(401);
    const anon = await createRoomAs("");
    const row = await env.DB.prepare("SELECT creator_user_id FROM rooms WHERE room_id = ?")
      .bind(anon.roomId)
      .first<{ creator_user_id: string | null }>();
    expect(row?.creator_user_id).toBeNull();
  });
});
