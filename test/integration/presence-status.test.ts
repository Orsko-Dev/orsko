import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_AWAY_AFTER_MS,
  MAX_OBSERVERS_PER_ROOM,
  OBSERVER_EXPIRE_AFTER_MS,
} from "../../src/config/constants";
import type { RoomObject } from "../../src/room/RoomObject";
import { generateRoomId } from "../../src/util/ids";
import {
  authHeaders,
  BASE,
  closeAllStreams,
  createRoomViaHttp,
  joinViaHttp,
  openStream,
  type StreamClient,
} from "../helpers";

afterEach(closeAllStreams);

interface StatusView {
  name: string;
  status: string;
}

function sqlOf(instance: RoomObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

/** Moves one member's last authenticated call `ms` into the past. */
async function seenAgo(roomId: string, name: string, ms: number): Promise<void> {
  await runInDurableObject(env.ROOM.getByName(roomId), (instance: RoomObject) => {
    sqlOf(instance).exec(
      "UPDATE members SET last_seen_at = ? WHERE name = ?",
      Date.now() - ms,
      name,
    );
  });
}

/** Moves every observer's last authenticated call `ms` into the past. */
async function observersSeenAgo(roomId: string, ms: number): Promise<void> {
  await runInDurableObject(env.ROOM.getByName(roomId), (instance: RoomObject) => {
    sqlOf(instance).exec(
      "UPDATE members SET last_seen_at = ? WHERE role = 'observer'",
      Date.now() - ms,
    );
  });
}

async function statuses(roomId: string, token: string): Promise<Record<string, string>> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    headers: authHeaders(token),
  });
  const body = (await res.json()) as { members: StatusView[] };
  return Object.fromEntries(body.members.map((m) => [m.name, m.status]));
}

async function metaStatuses(roomId: string): Promise<Record<string, string>> {
  const body = (await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).json()) as {
    members: StatusView[];
  };
  return Object.fromEntries(body.members.map((m) => [m.name, m.status]));
}

async function helloStream(roomId: string, token: string): Promise<StreamClient> {
  const client = await openStream(roomId);
  client.send({ type: "hello", token });
  return client;
}

const QUIET = AGENT_AWAY_AFTER_MS + 60_000;
const STALE = OBSERVER_EXPIRE_AFTER_MS + 60_000;

describe("member status", () => {
  it("is active after a call and away after ten quiet minutes, on both member lists", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    expect(await statuses(roomId, alice)).toEqual({ alice: "active", bob: "active" });

    await seenAgo(roomId, "bob", QUIET);
    expect(await statuses(roomId, alice)).toEqual({ alice: "active", bob: "away" });
    expect(await metaStatuses(roomId)).toEqual({ alice: "active", bob: "away" });

    // Away is derived, never stored: bob's next call makes him active again,
    // and his token was never touched.
    expect((await statuses(roomId, bob)).bob).toBe("active");
  });

  it("keeps a member with an open socket active however long it is quiet", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const stream = await helloStream(roomId, bob);
    const welcome = await stream.nextOf("welcome");
    expect((welcome.members as StatusView[]).every((m) => m.status === "active")).toBe(true);

    await seenAgo(roomId, "bob", QUIET);
    expect((await statuses(roomId, alice)).bob).toBe("active");
  });

  it("carries status on presence frames", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const stream = await helloStream(roomId, alice);
    await stream.nextOf("welcome");
    // The socket's own hello announces alice's arrival first; bob's join is the next one.
    await stream.nextOf("presence");
    await joinViaHttp(roomId, "bob");
    const presence = await stream.nextOf("presence");
    const members = presence.members as StatusView[];
    expect(members.map((m) => [m.name, m.status])).toEqual([
      ["alice", "active"],
      ["bob", "active"],
    ]);
  });
});

describe("observer expiry", () => {
  it("frees a cap slot, silently, and mirrors left_at into the account index", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const tokens: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < MAX_OBSERVERS_PER_ROOM; i += 1) {
      const joined = await stub.join({ name: `viewer-${i}`, role: "observer" });
      if (!joined.ok) throw new Error("observer join failed");
      tokens.push(joined.value.token);
      ids.push(joined.value.memberId);
    }
    expect(await stub.join({ name: "viewer-late", role: "observer" })).toMatchObject({
      code: "room_full",
    });

    await observersSeenAgo(roomId, STALE);
    expect((await stub.join({ name: "viewer-late", role: "observer" })).ok).toBe(true);

    const names = (await stub.getMeta())?.members.map((m) => m.name) ?? [];
    expect(names).toEqual(["viewer-late"]);
    expect(await stub.members(tokens[0] ?? "")).toMatchObject({ code: "invalid_token" });
    // Observer joins and leaves are never announced.
    expect((await stub.transcript()).some((m) => m.text.includes("left"))).toBe(false);

    await vi.waitFor(async () => {
      const row = await env.DB.prepare("SELECT left_at FROM room_members WHERE member_id = ?")
        .bind(ids[0] ?? "")
        .first<{ left_at: number | null }>();
      expect(row?.left_at).not.toBeNull();
    });
  });

  it("never expires an observer that holds a socket", async () => {
    const { roomId } = await createRoomViaHttp();
    const watcher = await joinViaHttp(roomId, "viewer-live", "observer");
    const stream = await helloStream(roomId, watcher);
    await stream.nextOf("welcome");
    await observersSeenAgo(roomId, STALE);
    expect(Object.keys(await metaStatuses(roomId))).toContain("viewer-live");
  });

  it("sweeps on the members list as well as on the room details", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await joinViaHttp(roomId, "viewer-gone", "observer");
    await observersSeenAgo(roomId, STALE);
    expect(Object.keys(await statuses(roomId, alice))).toEqual(["alice"]);
  });

  it("leaves a quiet agent in the room: agents only ever go away", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await seenAgo(roomId, "bob", 24 * 60 * 60_000);
    expect((await statuses(roomId, alice)).bob).toBe("away");
    const post = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(bob),
      body: JSON.stringify({ text: "back after a long job" }),
    });
    expect(post.status).toBe(201);
  });
});
