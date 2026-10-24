import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

describe("HTTP rooms and members", () => {
  it("creates a room and returns its url", async () => {
    const { roomId, url } = await createRoomViaHttp("test");
    expect(roomId).toMatch(/^[a-z0-9]{12}$/);
    expect(url).toBe(`${env.PUBLIC_BASE_URL}/r/${roomId}`);
  });

  it("rejects bad create bodies", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "x".repeat(501) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("accepts an empty body as {} but rejects malformed JSON", async () => {
    const empty = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
      body: "",
    });
    expect(empty.status).toBe(201);
    const malformed = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const { error } = (await malformed.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(/^request body is not valid JSON \(/);
    expect(error.message).toContain("--data-binary @file");
  });

  it("rate limits creation per IP", async () => {
    const ip = "203.0.113.7";
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await SELF.fetch(`${BASE}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: "{}",
      });
      last = res.status;
      if (last === 429) {
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("serves metadata, markdown, and 404 for unknown rooms", async () => {
    const { roomId } = await createRoomViaHttp();
    const meta = await SELF.fetch(`${BASE}/api/rooms/${roomId}`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { state: string }).state).toBe("live");
    const md = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain(`/api/rooms/${roomId}/members`);
    const json = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "application/json" },
    });
    expect(((await json.json()) as { roomId: string }).roomId).toBe(roomId);
    const missing = await SELF.fetch(`${BASE}/api/rooms/abcdefghjkmn`);
    expect(missing.status).toBe(404);
    const badId = await SELF.fetch(`${BASE}/api/rooms/NOPE`);
    expect(badId.status).toBe(400);
  });

  it("serves generic instructions at /agents.md", async () => {
    const res = await SELF.fetch(`${BASE}/agents.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("{roomId}");
  });

  it("join response carries recent history and nextSince", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      recent: { text: string; seq: number }[];
      nextSince: number;
    };
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]?.text).toBe("alice joined");
    expect(body.nextSince).toBe(body.recent[0]?.seq);
  });

  it("joins, rejects duplicates, and leaves", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    const dup = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ALICE" }),
    });
    expect(dup.status).toBe(409);
    const leave = await SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leave.status).toBe(204);
    const bad = await SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
  });

  it("has permissive CORS on /api", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms/abcdefghjkmn`, {
      method: "OPTIONS",
      headers: { origin: "https://other.example", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("authorization");
    expect(allowed.toLowerCase()).toContain("x-filename");
    expect(allowed.toLowerCase()).toContain("x-orsko-key");
  });
});
