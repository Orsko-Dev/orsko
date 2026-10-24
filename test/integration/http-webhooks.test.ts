import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

interface JoinView {
  token: string;
  webhook?: { url: string; secret: string };
}

interface MemberView {
  name: string;
  webhookStatus: "active" | "failed" | null;
}

const HOOK = "https://hooks.example.com/orsko";

async function join(
  roomId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: JoinView & { error?: { code: string; message: string } } }> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JoinView };
}

async function register(roomId: string, token: string, url: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/members/me/webhook`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({ url }),
  });
}

async function unregister(roomId: string, token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/members/me/webhook`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
}

async function statusOf(roomId: string, token: string, name: string) {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    headers: authHeaders(token),
  });
  const body = (await res.json()) as { members: MemberView[] };
  return body.members.find((m) => m.name === name);
}

describe("registering a webhook at join", () => {
  it("returns the url and a one-time secret", async () => {
    const { roomId } = await createRoomViaHttp();
    const joined = await join(roomId, { name: "alice", webhookUrl: HOOK });
    expect(joined.status).toBe(201);
    expect(joined.body.webhook?.url).toBe(HOOK);
    expect(joined.body.webhook?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await statusOf(roomId, joined.body.token, "alice")).toMatchObject({
      webhookStatus: "active",
    });
  });

  it("omits the webhook field when none was asked for", async () => {
    const { roomId } = await createRoomViaHttp();
    const joined = await join(roomId, { name: "alice" });
    expect(joined.body.webhook).toBeUndefined();
    expect(await statusOf(roomId, joined.body.token, "alice")).toMatchObject({
      webhookStatus: null,
    });
  });

  it("rejects a url that is not an allowed webhook target", async () => {
    const { roomId } = await createRoomViaHttp();
    for (const url of ["http://evil.example.com/x", "https://169.254.169.254/", "nope"]) {
      const bad = await join(roomId, { name: "alice", webhookUrl: url });
      expect(bad.status).toBe(400);
      expect(bad.body.error?.code).toBe("invalid_request");
    }
  });

  it("rejects a webhook for an observer", async () => {
    const { roomId } = await createRoomViaHttp();
    const bad = await join(roomId, { name: "watcher", role: "observer", webhookUrl: HOOK });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("invalid_request");
    expect(bad.body.error?.message).toContain("observer");
  });

  it("never returns the url or the secret again", async () => {
    const { roomId } = await createRoomViaHttp();
    const joined = await join(roomId, { name: "alice", webhookUrl: HOOK });
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      headers: authHeaders(joined.body.token),
    });
    const text = await res.text();
    expect(text).toContain('"webhookStatus":"active"');
    expect(text).not.toContain(HOOK);
    expect(text).not.toContain(joined.body.webhook?.secret ?? "never");

    // The unauthenticated room metadata carries no webhook state at all.
    const meta = await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).text();
    expect(meta).not.toContain(HOOK);
    expect(meta).not.toContain("webhookStatus");
  });
});

describe("PUT /api/rooms/:roomId/members/me/webhook", () => {
  it("registers a webhook after joining and mints a fresh secret", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    expect(await statusOf(roomId, token, "alice")).toMatchObject({ webhookStatus: null });

    const first = await register(roomId, token, HOOK);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { url: string; secret: string };
    expect(firstBody.url).toBe(HOOK);
    expect(firstBody.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await statusOf(roomId, token, "alice")).toMatchObject({ webhookStatus: "active" });

    const second = await register(roomId, token, `${HOOK}/v2`);
    const secondBody = (await second.json()) as { url: string; secret: string };
    expect(secondBody.url).toBe(`${HOOK}/v2`);
    expect(secondBody.secret).not.toBe(firstBody.secret);
  });

  it("rejects a bad url, a missing token and a bad room id", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    expect((await register(roomId, token, "http://evil.example.com/x")).status).toBe(400);
    expect((await register(roomId, "", HOOK)).status).toBe(401);
    expect((await register("not-a-room", token, HOOK)).status).toBe(400);

    const noBody = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members/me/webhook`, {
      method: "PUT",
      headers: authHeaders(token),
    });
    expect(noBody.status).toBe(400);
  });

  it("refuses observers", async () => {
    const { roomId } = await createRoomViaHttp();
    await joinViaHttp(roomId, "alice");
    const observer = await joinViaHttp(roomId, "watcher", "observer");
    const res = await register(roomId, observer, HOOK);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });
});

describe("DELETE /api/rooms/:roomId/members/me/webhook", () => {
  it("removes the webhook and is safe to repeat", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    await register(roomId, token, HOOK);

    expect((await unregister(roomId, token)).status).toBe(204);
    expect(await statusOf(roomId, token, "alice")).toMatchObject({ webhookStatus: null });
    expect((await unregister(roomId, token)).status).toBe(204);
    expect((await unregister(roomId, "")).status).toBe(401);
  });
});
