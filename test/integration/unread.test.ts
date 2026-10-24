import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  authHeaders,
  BASE,
  closeAllStreams,
  createRoomViaHttp,
  joinViaHttp,
  openStream,
} from "../helpers";

afterEach(closeAllStreams);

interface Posted {
  seq: number;
  text: string;
  unread: number;
}

async function post(roomId: string, token: string, text: string): Promise<Posted> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Posted;
}

async function joinFull(
  roomId: string,
  name: string,
): Promise<{ token: string; nextSince: number }> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; nextSince: number };
}

async function poll(roomId: string, token: string, since: number): Promise<number> {
  const res = await SELF.fetch(
    `${BASE}/api/rooms/${roomId}/messages?since=${since}&waitSeconds=0`,
    { headers: authHeaders(token) },
  );
  return ((await res.json()) as { nextSince: number }).nextSince;
}

describe("unread on POST /messages", () => {
  it("counts messages from others the poster was never handed", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await post(roomId, bob, "question one");
    await post(roomId, bob, "question two");
    const reply = await post(roomId, alice, "hello everyone");
    expect(reply.unread).toBe(2);
    // The message itself is unchanged: its fields stay at the top level.
    expect(reply.text).toBe("hello everyone");
  });

  it("drops to zero once a poll has handed the messages over", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinFull(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await post(roomId, bob, "question one");
    await post(roomId, bob, "question two");
    await poll(roomId, alice.token, alice.nextSince);
    expect((await post(roomId, alice.token, "answers")).unread).toBe(0);
  });

  it("counts only what arrived after the poll it last made", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinFull(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await poll(roomId, alice.token, alice.nextSince);
    await post(roomId, bob, "one more thing");
    expect((await post(roomId, alice.token, "replying")).unread).toBe(1);
  });

  it("never counts the poster's own messages or system messages", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await post(roomId, alice, "one");
    await joinViaHttp(roomId, "bob");
    expect((await post(roomId, alice, "two")).unread).toBe(0);
  });

  it("treats the messages a join hands over in recent as delivered", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await post(roomId, alice, "context for whoever joins");
    const carol = await joinViaHttp(roomId, "carol");
    expect((await post(roomId, carol, "read it, thanks")).unread).toBe(0);
  });
});

describe("unread on stream acks", () => {
  it("reports unread on the ack and honours read frames", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    const client = await openStream(roomId);
    client.send({ type: "hello", token: alice });
    await client.nextOf("welcome");
    await post(roomId, bob, "over to you");

    client.send({ type: "post", id: "p1", text: "reply before reading" });
    const first = await client.nextOf("ack");
    expect(first.unread).toBe(1);
    expect(first.seq).toBe((first.message as { seq: number }).seq);
    expect((first.message as Record<string, unknown>).unread).toBeUndefined();

    client.send({ type: "read", since: first.seq });
    client.send({ type: "post", id: "p2", text: "caught up now" });
    expect((await client.nextOf("ack")).unread).toBe(0);
  });
});
