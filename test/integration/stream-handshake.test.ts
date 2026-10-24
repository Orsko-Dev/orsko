import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { STREAM_CONNECT_LIMIT_PER_MINUTE } from "../../src/config/constants";
import {
  adoptStream,
  BASE,
  closeAllStreams,
  createRoomViaHttp,
  joinViaHttp,
  openStream,
  openStreamResponse,
  randomIp,
} from "../helpers";

afterEach(closeAllStreams);

describe("stream endpoint", () => {
  it("rejects a non-upgrade request with 426", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/stream`);
    expect(res.status).toBe(426);
  });

  it("rejects an invalid room id", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms/nope/stream`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown room before upgrading", async () => {
    const res = await openStreamResponse("abcdefghjkmn");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("room_not_found");
  });

  it("upgrades an existing room to a socket", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await openStreamResponse(roomId);
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    await adoptStream(res.webSocket as WebSocket).close();
  });
});

describe("stream handshake", () => {
  it("answers hello with welcome", async () => {
    const { roomId } = await createRoomViaHttp("build a thing");
    const token = await joinViaHttp(roomId, "alice");
    const client = await openStream(roomId);
    client.send({ type: "hello", token });
    const welcome = await client.nextOf("welcome");
    expect(welcome.roomId).toBe(roomId);
    expect(welcome.you).toMatchObject({ name: "alice", role: "agent" });
    expect(welcome.state).toBe("live");
    expect(welcome.lastSeq).toBe(1);
    expect(Array.isArray(welcome.members)).toBe(true);
    await client.close();
  });

  it("closes 4401 on a bad token", async () => {
    const { roomId } = await createRoomViaHttp();
    const client = await openStream(roomId);
    client.send({ type: "hello", token: "not-a-token" });
    const error = await client.nextOf("error");
    expect(error.code).toBe("invalid_token");
    expect((await client.closed()).code).toBe(4401);
  });

  it("closes 4408 when hello never arrives", async () => {
    const { roomId } = await createRoomViaHttp();
    const client = await openStream(roomId);
    expect((await client.closed()).code).toBe(4408);
  });

  it("rejects a frame sent before hello", async () => {
    const { roomId } = await createRoomViaHttp();
    const client = await openStream(roomId);
    client.send({ type: "read", since: 0 });
    const error = await client.nextOf("error");
    expect(error.code).toBe("invalid_token");
    expect((await client.closed()).code).toBe(4401);
  });
});

describe("stream upgrade rate limit", () => {
  it("refuses more than the per-minute allowance from one IP", async () => {
    const { roomId } = await createRoomViaHttp();
    const ip = randomIp();
    // Metering runs before the upgrade check, so plain requests spend the
    // allowance too and the test need not open sixty sockets.
    const knock = (from: string): Promise<Response> =>
      SELF.fetch(`${BASE}/api/rooms/${roomId}/stream`, { headers: { "cf-connecting-ip": from } });
    for (let i = 0; i < STREAM_CONNECT_LIMIT_PER_MINUTE; i += 1) {
      expect((await knock(ip)).status).toBe(426);
    }
    const refused = await knock(ip);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    // A different address is unaffected.
    expect((await knock(randomIp())).status).toBe(426);
  });
});

describe("stream handshake on an archived room", () => {
  it("welcomes with state archived and closes 4410", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await joinViaHttp(roomId, "alice");
    const stub = env.ROOM.getByName(roomId);
    await stub.forceState("slow", Date.now() - 40 * 24 * 3600 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const client = await openStream(roomId);
    client.send({ type: "hello", token });
    const welcome = await client.nextOf("welcome");
    expect(welcome.state).toBe("archived");
    expect((await client.closed()).code).toBe(4410);
  });
});
