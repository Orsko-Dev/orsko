import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp } from "../helpers";

interface Joined {
  token: string;
  memberId: string;
}

async function join(roomId: string, name: string): Promise<Joined> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`join failed: ${res.status}`);
  return (await res.json()) as Joined;
}

async function remove(roomId: string, target: string, token?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/members/${target}`, {
    method: "DELETE",
    headers: token === undefined ? {} : authHeaders(token),
  });
}

async function presentNames(roomId: string, token: string): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    headers: authHeaders(token),
  });
  return ((await res.json()) as { members: { name: string }[] }).members.map((m) => m.name);
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

describe("leaving by DELETE", () => {
  it("DELETE /members/me leaves exactly like POST /leave", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await join(roomId, "alice");
    const bob = await join(roomId, "bob");
    expect((await remove(roomId, "me", bob.token)).status).toBe(204);
    expect(await presentNames(roomId, alice.token)).toEqual(["alice"]);
    const poll = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages?since=0&waitSeconds=0`, {
      headers: authHeaders(alice.token),
    });
    const texts = ((await poll.json()) as { messages: { text: string }[] }).messages.map(
      (m) => m.text,
    );
    expect(texts).toContain("bob left");
    // The token is dead once the member has left.
    expect((await remove(roomId, "me", bob.token)).status).toBe(401);
  });

  it("DELETE /members/<own id> leaves too", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await join(roomId, "alice");
    const bob = await join(roomId, "bob");
    expect((await remove(roomId, bob.memberId, bob.token)).status).toBe(204);
    expect(await presentNames(roomId, alice.token)).toEqual(["alice"]);
  });

  it("refuses to remove somebody else", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await join(roomId, "alice");
    const bob = await join(roomId, "bob");
    const res = await remove(roomId, bob.memberId, alice.token);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({
      code: "forbidden",
      message: "you can only remove yourself",
    });
    expect(await presentNames(roomId, alice.token)).toEqual(["alice", "bob"]);
  });

  it("checks the token before anything else", async () => {
    const { roomId } = await createRoomViaHttp();
    const bob = await join(roomId, "bob");
    expect((await errorOf(await remove(roomId, "me"))).code).toBe("invalid_token");
    expect((await errorOf(await remove(roomId, bob.memberId, "nope"))).code).toBe("invalid_token");
  });

  it("rejects a member id that is not one", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await join(roomId, "alice");
    const res = await remove(roomId, "not-an-id", alice.token);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "invalid_request", message: "invalid member id" });
  });
});
