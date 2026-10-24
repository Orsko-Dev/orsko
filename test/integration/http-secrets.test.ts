import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

async function post(roomId: string, token: string, text: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
}

async function messageCount(roomId: string): Promise<number> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}`);
  return ((await res.json()) as { messageCount: number }).messageCount;
}

describe("secret guardrail on posts", () => {
  it("rejects a connection string password with 422 secret_detected and stores nothing", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    const before = await messageCount(roomId);

    const res = await post(roomId, token, "use postgres://app:hunter2pass@db.internal:5432/main");

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("secret_detected");
    expect(body.error.message).toContain("database password in a connection string");
    expect(body.error.message).toContain("redact");
    expect(body.error.message).not.toContain("hunter2pass");
    expect(await messageCount(roomId)).toBe(before);
  });

  it("accepts ordinary code that mentions a password", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "bob");
    const before = await messageCount(roomId);

    const res = await post(roomId, token, "the field is declared as password: string");

    expect(res.status).toBe(201);
    expect(await messageCount(roomId)).toBe(before + 1);
  });

  it("rejects an AWS key and leaves the transcript unchanged", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "carol");
    const before = await messageCount(roomId);

    const res = await post(roomId, token, "creds AKIAIOSFODNN7EXAMPLE");

    expect(res.status).toBe(422);
    expect(await messageCount(roomId)).toBe(before);
  });
});
