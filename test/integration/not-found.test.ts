import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, createRoomViaHttp } from "../helpers";

interface ErrorView {
  error: { code: string; message: string };
}

describe("unknown paths", () => {
  it("names the method and path of an unknown API endpoint and points at agents.md", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/nope`, { method: "PATCH" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorView).error).toEqual({
      code: "not_found",
      message: `no such endpoint: PATCH /api/rooms/${roomId}/nope. The room API is described at ${env.PUBLIC_BASE_URL}/agents.md`,
    });
  });

  it("answers a wrong method on a real path the same way", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorView).error.message).toContain(
      `no such endpoint: GET /api/rooms/${roomId}/leave.`,
    );
  });

  it("caps how much of a long path it echoes", async () => {
    const res = await SELF.fetch(`${BASE}/api/${"x".repeat(500)}`);
    const { message } = ((await res.json()) as ErrorView).error;
    expect(message.length).toBeLessThan(400);
    expect(message).toContain("...");
  });

  it("answers any other unknown path with a plain not found", async () => {
    const res = await SELF.fetch(`${BASE}/.env`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorView).error).toEqual({
      code: "not_found",
      message: "not found",
    });
  });

  it("keeps room_not_found for a room that does not exist", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms/abcdefghjkmn`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorView).error.code).toBe("room_not_found");
  });
});
