import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
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

interface MemberView {
  readonly name: string;
  readonly readThrough: number;
  readonly connected: boolean;
  readonly lastSeenAt: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function leaveViaHttp(roomId: string, token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

async function postViaHttp(roomId: string, token: string, text: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
}

async function membersViaHttp(roomId: string, token: string): Promise<MemberView[]> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    headers: authHeaders(token),
  });
  return ((await res.json()) as { members: MemberView[] }).members;
}

async function connectedStream(
  roomId: string,
  token: string,
  since?: number,
): Promise<StreamClient> {
  const client = await openStream(roomId);
  client.send(since === undefined ? { type: "hello", token } : { type: "hello", token, since });
  await client.nextOf("welcome");
  return client;
}

describe("stream delivery", () => {
  it("pushes a message another member posts over HTTP", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);

    expect((await postViaHttp(roomId, bob, "hello alice")).status).toBe(201);

    const frame = await client.nextOf("message");
    expect((frame.message as { text: string; from: string }).text).toBe("hello alice");
    expect((frame.message as { from: string }).from).toBe("bob");
  });

  it("replays everything after the client's cursor", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await postViaHttp(roomId, alice, "first");
    await postViaHttp(roomId, alice, "second");
    const client = await connectedStream(roomId, alice, 1);

    const first = await client.nextOf("message");
    const second = await client.nextOf("message");
    expect((first.message as { text: string }).text).toBe("first");
    expect((second.message as { text: string }).text).toBe("second");
  });

  it("replays nothing when hello omits since", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await postViaHttp(roomId, alice, "old news");
    const client = await connectedStream(roomId, alice);

    await postViaHttp(roomId, alice, "fresh");
    const frame = await client.nextOf("message");
    expect((frame.message as { text: string }).text).toBe("fresh");
  });
});

describe("stream posting", () => {
  it("acks a post frame and the message is readable over HTTP", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.send({ type: "post", id: "c1", text: "posted over the socket" });
    const ack = await client.nextOf("ack");
    expect(ack.id).toBe("c1");
    expect(ack.seq).toBe((ack.message as { seq: number }).seq);

    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages?since=0&waitSeconds=0`, {
      headers: authHeaders(alice),
    });
    const body = (await res.json()) as { messages: { text: string }[] };
    expect(body.messages.map((m) => m.text)).toContain("posted over the socket");
  });

  it("echoes the poster's own message as a message frame", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.send({ type: "post", id: "c1", text: "my own words" });
    const frame = await client.nextOf("message");
    expect((frame.message as { text: string }).text).toBe("my own words");
  });

  it("rejects a credential-shaped post with secret_detected and keeps the socket", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.send({
      type: "post",
      id: "c9",
      text: "use postgres://app:hunter2pass@db.internal:5432/main",
    });
    const error = await client.nextOf("error");
    expect(error.code).toBe("secret_detected");
    expect(error.id).toBe("c9");
    expect(String(error.message)).not.toContain("hunter2pass");

    client.send({ type: "post", id: "c10", text: "redacted, sorry" });
    expect((await client.nextOf("ack")).id).toBe("c10");
  });

  it("refuses a post from a member that has left the room", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    // Leaving closes the socket, so the refusal is raced against the close:
    // reconnect first, then leave through a second socketless token.
    const bob = await joinViaHttp(roomId, "bob");
    expect((await leaveViaHttp(roomId, alice)).status).toBe(204);
    expect((await client.closed()).code).toBe(4401);

    const other = await connectedStream(roomId, bob);
    other.send({ type: "post", id: "ok", text: "bob is still here" });
    expect((await other.nextOf("ack")).id).toBe("ok");
  });

  it("refuses a post from an observer", async () => {
    const { roomId } = await createRoomViaHttp();
    const observer = await joinViaHttp(roomId, "viewer-1", "observer");
    const client = await connectedStream(roomId, observer);

    client.send({ type: "post", id: "o1", text: "let me in" });
    const error = await client.nextOf("error");
    expect(error.code).toBe("forbidden");
    expect(error.id).toBe("o1");
  });

  it("reports the rate limit with retryAfterSeconds", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);
    // The counter is keyed by wall-clock minute, so a run that crosses a
    // minute boundary gets a fresh allowance: post until it refuses.
    const attempts = 2 * TIERS.free.maxPostsPerMinutePerMember + 2;
    let error: Record<string, unknown> | null = null;
    for (let i = 0; i < attempts && error === null; i += 1) {
      client.send({ type: "post", id: `r${i}`, text: `message ${i}` });
      for (;;) {
        const frame = await client.next();
        if (frame.type === "ack") break;
        if (frame.type === "error") {
          error = frame;
          break;
        }
      }
    }
    expect(error?.code).toBe("rate_limited");
    expect(String(error?.id)).toMatch(/^r\d+$/);
    expect(typeof error?.retryAfterSeconds).toBe("number");
  });
});

describe("stream read state", () => {
  it("advances readThrough on a read frame", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);
    await postViaHttp(roomId, bob, "read me");
    const frame = await client.nextOf("message");
    const seq = (frame.message as { seq: number }).seq;

    client.send({ type: "read", since: seq });
    // The next round trip proves the read frame was handled before it.
    client.send({ type: "post", id: "sync", text: "synced" });
    await client.nextOf("ack");

    const members = await membersViaHttp(roomId, bob);
    expect(members.find((m) => m.name === "alice")?.readThrough).toBe(seq);
  });
});

describe("stream presence", () => {
  it("reports connected in the members list while a socket is open", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);

    const online = await membersViaHttp(roomId, bob);
    expect(online.find((m) => m.name === "alice")?.connected).toBe(true);
    expect(online.find((m) => m.name === "bob")?.connected).toBe(false);

    await client.close();
    const offline = await membersViaHttp(roomId, bob);
    expect(offline.find((m) => m.name === "alice")?.connected).toBe(false);
  });

  it("pushes a presence frame when another member connects", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const first = await connectedStream(roomId, alice);

    const second = await connectedStream(roomId, bob);

    // Alice's own handshake also broadcasts presence, so read presence frames
    // until the one that reports bob online.
    let bobOnline = false;
    for (let i = 0; i < 4 && !bobOnline; i += 1) {
      const presence = await first.nextOf("presence");
      const members = presence.members as MemberView[];
      bobOnline = members.find((m) => m.name === "bob")?.connected === true;
    }
    expect(bobOnline).toBe(true);
    await second.close();
  });
});

describe("stream protocol errors", () => {
  it("answers an unknown type with invalid_request and keeps the socket", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.send({ type: "shout", text: "hi" });
    expect((await client.nextOf("error")).code).toBe("invalid_request");

    client.send({ type: "post", id: "still-here", text: "socket survived" });
    expect((await client.nextOf("ack")).id).toBe("still-here");
  });

  it("closes 1003 on a frame that is not JSON", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.sendRaw("not json at all");
    expect((await client.nextOf("error")).code).toBe("invalid_request");
    expect((await client.closed()).code).toBe(1003);
  });

  it("closes 1009 on a frame over 64 KiB", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);

    client.send({ type: "post", id: "big", text: "x".repeat(70 * 1024) });
    expect((await client.nextOf("error")).code).toBe("message_too_large");
    expect((await client.closed()).code).toBe(1009);
  });
});

describe("stream lifecycle", () => {
  it("announces the slow transition with a state frame", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);
    const stub = env.ROOM.getByName(roomId);

    await stub.forceState("live", Date.now() - (TIERS.free.idleToSlowSeconds + 1) * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await client.nextOf("state");
    expect(state.state).toBe("slow");
  });

  it("keeps pushing in slow mode: only long-poll is throttled", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);
    const stub = env.ROOM.getByName(roomId);
    await stub.forceState("slow", Date.now());

    expect((await postViaHttp(roomId, bob, "still pushed")).status).toBe(201);

    const frame = await client.nextOf("message");
    expect((frame.message as { text: string }).text).toBe("still pushed");
  });

  it("announces the slow to live flip a new message causes", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);
    const stub = env.ROOM.getByName(roomId);
    await stub.forceState("slow", Date.now());

    expect((await postViaHttp(roomId, bob, "wake up")).status).toBe(201);

    expect((await client.nextOf("state")).state).toBe("live");
    expect((await client.nextOf("message")).message).toMatchObject({ text: "wake up" });

    // Only the flip is announced: a second post finds the room already live.
    expect((await postViaHttp(roomId, bob, "still awake")).status).toBe(201);
    const between: string[] = [];
    for (;;) {
      const frame = await client.next();
      if (frame.type === "message") {
        if ((frame.message as { text: string }).text === "still awake") break;
        continue;
      }
      between.push(frame.type);
    }
    expect(between).not.toContain("state");
  });

  it("announces archive with a state frame and closes 4410", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const client = await connectedStream(roomId, alice);
    const stub = env.ROOM.getByName(roomId);

    await stub.forceState("slow", Date.now() - 40 * 24 * 3600 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await client.nextOf("state");
    expect(state.state).toBe("archived");
    expect((await client.closed()).code).toBe(4410);
  });
});

describe("stream membership revocation", () => {
  it("closes a departing member's socket with 4401 and stops pushing to it", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);

    expect((await leaveViaHttp(roomId, alice)).status).toBe(204);
    expect((await client.closed()).code).toBe(4401);

    client.drain();
    expect((await postViaHttp(roomId, bob, "alice must not see this")).status).toBe(201);
    // Give the broadcast every chance to reach a socket it should not.
    await sleep(50);
    const late = client
      .drain()
      .filter((frame) => frame.type === "message")
      .map((frame) => (frame.message as { text: string }).text);
    expect(late).not.toContain("alice must not see this");
    expect(late).not.toContain("alice left");
  });
});

describe("stream replay cap", () => {
  it("replays at most 200 messages and then says where to continue", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const stub = env.ROOM.getByName(roomId);
    // One system message from the join, plus 250 seeded: 251 in all.
    const lastSeq = await stub.forceSeedMessages(250);
    expect(lastSeq).toBe(251);

    const client = await connectedStream(roomId, alice, 0);
    const seqs: number[] = [];
    let truncated: Record<string, unknown> | null = null;
    while (truncated === null) {
      const frame = await client.next();
      if (frame.type === "message") seqs.push((frame.message as { seq: number }).seq);
      if (frame.type === "replay_truncated") truncated = frame;
    }
    expect(seqs.length).toBe(200);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(200);
    expect(truncated.nextSince).toBe(200);
    expect(truncated.lastSeq).toBe(251);
  });

  it("replays a short room in full with no truncation frame", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await postViaHttp(roomId, alice, "only message");
    const client = await connectedStream(roomId, alice, 0);

    await client.nextOf("message");
    // A round trip after the replay proves nothing else was queued behind it.
    client.send({ type: "post", id: "sync", text: "synced" });
    await client.nextOf("ack");
    expect(client.drain().some((frame) => frame.type === "replay_truncated")).toBe(false);
  });
});

describe("stream presence bookkeeping", () => {
  it("bumps lastSeenAt on a post frame", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await connectedStream(roomId, alice);
    const before = (await membersViaHttp(roomId, bob)).find((m) => m.name === "alice")?.lastSeenAt;
    expect(before).toBeTruthy();

    await sleep(10);
    client.send({ type: "post", id: "seen", text: "posting keeps me fresh" });
    await client.nextOf("ack");

    const after = (await membersViaHttp(roomId, bob)).find((m) => m.name === "alice")?.lastSeenAt;
    expect(Date.parse(String(after))).toBeGreaterThan(Date.parse(String(before)));
  });
});
