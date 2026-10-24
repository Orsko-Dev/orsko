import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

async function archive(roomId: string): Promise<void> {
  const stub = env.ROOM.getByName(roomId);
  await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
  await runDurableObjectAlarm(stub);
}

describe("HTTP transcript", () => {
  it("requires a member token while the room is live", async () => {
    const { roomId } = await createRoomViaHttp();
    const anon = await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("invalid_token");

    const observer = await joinViaHttp(roomId, "viewer-1", "observer");
    const withToken = await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`, {
      headers: { authorization: `Bearer ${observer}` },
    });
    expect(withToken.status).toBe(200);
  });

  it("serves an archived transcript and page without a token", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "keep me" }),
    });
    await archive(roomId);

    const page = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { text: string }[] };
    expect(body.messages.map((m) => m.text)).toEqual(["alice joined", "keep me"]);
  });

  it("404s for an unknown room", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms/abcdefghjkmn/transcript`);
    expect(res.status).toBe(404);
  });
});
