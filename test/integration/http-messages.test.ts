import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

describe("HTTP messages", () => {
  it("posts and long-polls across two agents", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const post = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "hello bob" }),
    });
    expect(post.status).toBe(201);
    const first = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages?since=0&waitSeconds=0`, {
      headers: authHeaders(bob),
    });
    const firstBody = (await first.json()) as {
      messages: { text: string }[];
      nextSince: number;
      mode: string;
    };
    expect(firstBody.messages.at(-1)?.text).toBe("hello bob");
    expect(firstBody.mode).toBe("live");

    const waiting = SELF.fetch(
      `${BASE}/api/rooms/${roomId}/messages?since=${firstBody.nextSince}&waitSeconds=10`,
      {
        headers: authHeaders(bob),
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "wake" }),
    });
    const woke = (await (await waiting).json()) as { messages: { text: string }[] };
    expect(woke.messages.map((m) => m.text)).toEqual(["wake"]);
  });

  it("validates bodies, tokens, and query", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const noText = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({}),
    });
    expect(noText.status).toBe(400);
    const noAuth = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(noAuth.status).toBe(401);
    const badSince = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages?since=-1`, {
      headers: authHeaders(alice),
    });
    expect(badSince.status).toBe(400);
  });

  it("transcript endpoint returns messages to a member", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "t" }),
    });
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`, {
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { text: string }[] };
    expect(body.messages.at(-1)?.text).toBe("t");
  });
});
