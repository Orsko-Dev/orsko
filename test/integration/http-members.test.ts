import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

interface MemberView {
  memberId: string;
  name: string;
  role: string;
  joinedAt: string;
  leftAt: string | null;
  readThrough: number;
  lastSeenAt: string | null;
}

interface MembersView {
  members: MemberView[];
  lastSeq: number;
}

async function members(roomId: string, token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, { headers: authHeaders(token) });
}

async function membersBody(roomId: string, token: string): Promise<MembersView> {
  const res = await members(roomId, token);
  expect(res.status).toBe(200);
  return (await res.json()) as MembersView;
}

async function post(roomId: string, token: string, text: string): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  if (res.status !== 201) throw new Error(`post failed: ${res.status} ${await res.text()}`);
}

async function poll(roomId: string, token: string, since: number): Promise<void> {
  const res = await SELF.fetch(
    `${BASE}/api/rooms/${roomId}/messages?since=${since}&waitSeconds=0`,
    { headers: authHeaders(token) },
  );
  if (res.status !== 200) throw new Error(`poll failed: ${res.status} ${await res.text()}`);
}

describe("GET /api/rooms/:roomId/members", () => {
  it("requires a member token", async () => {
    const { roomId } = await createRoomViaHttp();
    await joinViaHttp(roomId, "alice");

    const anonymous = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`);
    expect(anonymous.status).toBe(401);

    const wrong = await members(roomId, "not-a-real-token");
    expect(wrong.status).toBe(401);
  });

  it("is readable by an observer", async () => {
    const { roomId } = await createRoomViaHttp();
    await joinViaHttp(roomId, "alice");
    const observer = await joinViaHttp(roomId, "watcher", "observer");

    const body = await membersBody(roomId, observer);
    expect(body.members.map((m) => m.name).sort()).toEqual(["alice", "watcher"]);
  });

  it("reports lastSeq and per-member read state", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    for (let i = 0; i < 4; i++) await post(roomId, alice, `note ${i}`);

    const fresh = await membersBody(roomId, bob);
    expect(fresh.lastSeq).toBeGreaterThan(0);
    expect(fresh.members.find((m) => m.name === "bob")?.readThrough).toBe(0);

    await poll(roomId, bob, 5);
    const after = await membersBody(roomId, bob);
    const bobView = after.members.find((m) => m.name === "bob");
    expect(bobView?.readThrough).toBe(5);
    expect(bobView?.lastSeenAt).not.toBeNull();
    expect(new Date(bobView?.lastSeenAt ?? "").getTime()).toBeGreaterThan(0);

    // read_through only ever moves forward
    await poll(roomId, bob, 2);
    expect(
      (await membersBody(roomId, bob)).members.find((m) => m.name === "bob")?.readThrough,
    ).toBe(5);
  });

  it("matches lastSeq to the latest message seq", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await post(roomId, alice, "hello");

    const meta = (await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).json()) as {
      messageCount: number;
    };
    const body = await membersBody(roomId, alice);
    expect(body.lastSeq).toBe(meta.messageCount);
  });

  it("omits members who have left", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");

    await SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: "POST",
      headers: authHeaders(bob),
    });

    const body = await membersBody(roomId, alice);
    expect(body.members.map((m) => m.name)).toEqual(["alice"]);
    expect(body.members[0]?.leftAt).toBeNull();
  });

  it("rejects an invalid room id", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms/not-a-room/members`, {
      headers: authHeaders("x"),
    });
    expect(res.status).toBe(400);
  });
});

describe("member presence in room metadata", () => {
  it("serializes the new fields on the room metadata members", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await post(roomId, alice, "hello");

    const meta = (await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).json()) as {
      members: MemberView[];
    };
    const view = meta.members.find((m) => m.name === "alice");
    expect(view?.readThrough).toBe(0);
    expect(view?.lastSeenAt).not.toBeNull();
  });
});
