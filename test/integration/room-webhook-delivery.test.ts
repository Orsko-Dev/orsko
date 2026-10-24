import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomObject } from "../../src/room/RoomObject";
import { hmacSha256Hex } from "../../src/util/hmac";
import { generateRoomId } from "../../src/util/ids";

interface Capture {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly hasTimeout: boolean;
  readonly redirect: string | undefined;
}

const HOOK = "https://hooks.example.com/orsko";

/**
 * Records every outbound delivery. The Worker, the Durable Object and the
 * test share one isolate, so spying on globalThis.fetch intercepts the
 * room's deliveries without a real receiver.
 */
function captureFetch(respond: (call: Capture) => Response | Promise<Response>): Capture[] {
  const calls: Capture[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const call: Capture = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
      hasTimeout: (init as RequestInit | undefined)?.signal instanceof AbortSignal,
      redirect: (init as RequestInit | undefined)?.redirect,
    };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

const okResponse = () => new Response("ok", { status: 200 });
const failResponse = () => new Response("nope", { status: 500 });

async function roomWith(webhookFor: readonly string[]) {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: null, tier: "free" });
  const tokens: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const name of ["alice", "bob"]) {
    const joined = await stub.join(
      webhookFor.includes(name)
        ? { name, role: "agent", webhookUrl: `${HOOK}/${name}` }
        : { name, role: "agent" },
    );
    if (!joined.ok) throw new Error(`join failed for ${name}`);
    tokens[name] = joined.value.token;
    if (joined.value.webhook) secrets[name] = joined.value.webhook.secret;
  }
  return { roomId, stub, tokens, secrets };
}

async function flush(stub: DurableObjectStub<RoomObject>): Promise<void> {
  await stub.forceDeliveryFlush();
}

interface PendingDelivery {
  readonly delivery_id: string;
  readonly attempts: number;
  readonly next_at: number;
}

/** Reads the queue straight out of the object's storage, schedule and all. */
async function pending(stub: DurableObjectStub<RoomObject>): Promise<PendingDelivery[]> {
  return runInDurableObject(stub, (instance: RoomObject) => {
    const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
    return [
      ...sql.exec<PendingDelivery>(
        "SELECT delivery_id, attempts, next_at FROM webhook_deliveries ORDER BY next_at",
      ),
    ];
  });
}

/** Replaces the pass runner with one that always throws. */
async function breakDeliveries(stub: DurableObjectStub<RoomObject>): Promise<void> {
  await runInDurableObject(stub, (instance: RoomObject) => {
    (instance as unknown as { deliveries: { start(): Promise<void> } }).deliveries = {
      start: () => Promise.reject(new Error("delivery pass exploded")),
    };
  });
}

/**
 * A room whose join announcements have already been delivered, so a test
 * starts with an empty delivery queue and installs its own fetch mock.
 */
async function quietRoom(webhookFor: readonly string[]) {
  captureFetch(okResponse);
  const room = await roomWith(webhookFor);
  await flush(room.stub);
  vi.restoreAllMocks();
  return room;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook delivery", () => {
  it("posts a signed payload to every other member with an active webhook", async () => {
    const { roomId, stub, tokens, secrets } = await quietRoom(["bob"]);
    const calls = captureFetch(okResponse);

    const posted = await stub.postMessage(tokens.alice ?? "", {
      text: "hello bob",
      attachmentIds: [],
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    await flush(stub);

    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error("no delivery");
    expect(call.url).toBe(`${HOOK}/bob`);
    expect(call.method).toBe("POST");
    expect(call.hasTimeout).toBe(true);
    expect(call.headers["x-orsko-event"]).toBe("message");
    expect(call.headers["x-orsko-room"]).toBe(roomId);
    expect(call.headers["x-orsko-delivery"]).toMatch(/^d_[a-z0-9]{16}$/);
    expect(call.headers["content-type"]).toContain("application/json");

    const expected = await hmacSha256Hex(secrets.bob ?? "", call.body);
    expect(call.headers["x-orsko-signature"]).toBe(`sha256=${expected}`);

    const payload = JSON.parse(call.body) as {
      event: string;
      deliveryId: string;
      roomId: string;
      member: { memberId: string; name: string };
      message: { seq: number; text: string; from: string };
    };
    expect(payload.event).toBe("message");
    expect(payload.deliveryId).toBe(call.headers["x-orsko-delivery"]);
    expect(payload.roomId).toBe(roomId);
    expect(payload.member.name).toBe("bob");
    expect(payload.message).toMatchObject({
      seq: posted.value.seq,
      text: "hello bob",
      from: "alice",
    });
  });

  it("never delivers a member their own message", async () => {
    const { stub, tokens } = await quietRoom(["alice", "bob"]);
    const calls = captureFetch(okResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "mine", attachmentIds: [] });
    await flush(stub);
    expect(calls.map((c) => c.url)).toEqual([`${HOOK}/bob`]);
  });

  it("delivers system messages to everyone with a webhook", async () => {
    const { stub } = await quietRoom(["alice", "bob"]);
    const calls = captureFetch(okResponse);

    await stub.join({ name: "carol", role: "agent" });
    await flush(stub);
    const texts = calls.map(
      (c) => (JSON.parse(c.body) as { message: { text: string } }).message.text,
    );
    expect(calls.map((c) => c.url).sort()).toEqual([`${HOOK}/alice`, `${HOOK}/bob`]);
    expect(texts).toEqual(["carol joined", "carol joined"]);
  });

  it("delivers nothing to a member who removed their webhook", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(okResponse);
    expect(await stub.removeWebhook(tokens.bob ?? "")).toMatchObject({ ok: true });

    await stub.postMessage(tokens.alice ?? "", { text: "anyone?", attachmentIds: [] });
    await flush(stub);
    expect(calls).toEqual([]);
  });

  it("delivers nothing when no member has a webhook", async () => {
    const { stub, tokens } = await quietRoom([]);
    const calls = captureFetch(okResponse);
    await stub.postMessage(tokens.alice ?? "", { text: "quiet", attachmentIds: [] });
    await flush(stub);
    expect(calls).toEqual([]);
  });
});

describe("webhook retries", () => {
  it("retries a failed delivery and keeps the same delivery id", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(failResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "retry me", attachmentIds: [] });
    await flush(stub);
    expect(calls.length).toBe(1);
    const deliveryId = calls[0]?.headers["x-orsko-delivery"];

    // Not due yet: the schedule holds the retry back.
    await flush(stub);
    expect(calls.length).toBe(1);

    expect(await stub.forceDeliveryDue()).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]?.headers["x-orsko-delivery"]).toBe(deliveryId);
    expect(await stub.members(tokens.alice ?? "")).toMatchObject({ ok: true });
  });

  it("treats a redirect as a failure instead of following it", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );

    await stub.postMessage(tokens.alice ?? "", { text: "redirect me", attachmentIds: [] });
    await flush(stub);
    expect(calls.length).toBe(1);
    expect(calls[0]?.redirect).toBe("manual");
    // Still queued for a retry, so the 302 was counted as a failure.
    expect(await stub.forceDeliveryDue()).toBe(1);
  });

  it("retries a network error the same way", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(() => {
      throw new TypeError("connection refused");
    });

    await stub.postMessage(tokens.alice ?? "", { text: "boom", attachmentIds: [] });
    await flush(stub);
    expect(calls.length).toBe(1);
    expect(await stub.forceDeliveryDue()).toBe(1);
    await flush(stub);
    expect(calls.length).toBe(2);
  });

  it("disables the webhook after the fifth failure and announces it", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(failResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "doomed", attachmentIds: [] });
    await flush(stub);
    for (let i = 0; i < 4; i++) {
      expect(await stub.forceDeliveryDue()).toBe(1);
      await flush(stub);
    }
    expect(calls.length).toBe(5);
    expect(await stub.forceDeliveryDue()).toBe(0);

    const presence = await stub.members(tokens.alice ?? "");
    expect(presence).toMatchObject({ ok: true });
    if (!presence.ok) return;
    expect(presence.value.members.find((m) => m.name === "bob")?.webhookStatus).toBe("failed");

    const transcript = await stub.transcript();
    expect(transcript.at(-1)?.text).toBe("bob's webhook was disabled after repeated failures");
    expect(transcript.at(-1)?.from).toBe("system");

    // A disabled webhook receives nothing more.
    calls.length = 0;
    await stub.postMessage(tokens.alice ?? "", { text: "still nothing", attachmentIds: [] });
    await flush(stub);
    expect(calls).toEqual([]);
  });

  it("lets a member re-register after a failure disabled the webhook", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    captureFetch(failResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "doomed", attachmentIds: [] });
    await flush(stub);
    for (let i = 0; i < 4; i++) {
      await stub.forceDeliveryDue();
      await flush(stub);
    }
    const again = await stub.registerWebhook(tokens.bob ?? "", `${HOOK}/bob2`);
    expect(again).toMatchObject({ ok: true });

    vi.restoreAllMocks();
    const good = captureFetch(okResponse);
    await stub.postMessage(tokens.alice ?? "", { text: "back", attachmentIds: [] });
    await flush(stub);
    expect(good.map((c) => c.url)).toEqual([`${HOOK}/bob2`]);

    const presence = await stub.members(tokens.alice ?? "");
    if (!presence.ok) throw new Error("members failed");
    expect(presence.value.members.find((m) => m.name === "bob")?.webhookStatus).toBe("active");
  });
});

describe("unread after a successful webhook delivery", () => {
  it("advances delivered_through so a webhook member's own post reports unread 0", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    captureFetch(okResponse);

    const posted = await stub.postMessage(tokens.alice ?? "", {
      text: "for bob",
      attachmentIds: [],
    });
    expect(posted).toMatchObject({ ok: true });
    await flush(stub);

    // Bob never polled; the message reached him only through the webhook.
    // A successful delivery must count as having been handed to him, the
    // same way a poll or a join's `recent` does.
    const bobPosted = await stub.postMessage(tokens.bob ?? "", {
      text: "got it",
      attachmentIds: [],
    });
    expect(bobPosted).toMatchObject({ ok: true });
    if (!bobPosted.ok) return;
    expect(bobPosted.value.unread).toBe(0);
  });
});

describe("the shared room alarm", () => {
  it("runs due deliveries before the lifecycle step", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(failResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "later", attachmentIds: [] });
    await flush(stub);
    expect(calls.length).toBe(1);

    await stub.forceDeliveryDue();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls.length).toBe(2);
    // The lifecycle still ran: the room is untouched and still live.
    expect((await stub.getMeta())?.state).toBe("live");
  });

  it("drops pending deliveries when the room archives", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    const calls = captureFetch(failResponse);
    await stub.postMessage(tokens.alice ?? "", { text: "bye", attachmentIds: [] });
    await flush(stub);
    calls.length = 0;

    await stub.forceState("slow", Date.now() - 48 * 3600 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.getMeta())?.state).toBe("archived");
    expect(await stub.forceDeliveryDue()).toBe(0);
    await flush(stub);
    expect(calls).toEqual([]);
  });
});

describe("webhook url validation inside the room object", () => {
  it("refuses a private url on join, without the Worker in front of it", async () => {
    const { stub } = await quietRoom([]);
    for (const url of [
      "https://169.254.169.254/latest",
      "http://evil.example.com/x",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://10.0.0.1.nip.io/hook",
    ]) {
      expect(
        await stub.join({ name: `mallory-${url.length}`, role: "agent", webhookUrl: url }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
    }
  });

  it("refuses a private url on registerWebhook", async () => {
    const { stub, tokens } = await quietRoom([]);
    const refused = await stub.registerWebhook(tokens.alice ?? "", "https://192.168.1.10/hook");
    expect(refused).toMatchObject({ ok: false, code: "invalid_request" });
    if (refused.ok) return;
    expect(refused.message).toContain("ip address");

    const internal = await stub.registerWebhook(tokens.alice ?? "", "https://build.internal/hook");
    expect(internal).toMatchObject({ ok: false, code: "invalid_request" });

    const presence = await stub.members(tokens.alice ?? "");
    if (!presence.ok) throw new Error("members failed");
    expect(presence.value.members.find((m) => m.name === "alice")?.webhookStatus).toBeNull();
  });
});

describe("a delivery pass that throws", () => {
  it("does not stop the append that started it, nor the lifecycle step", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    captureFetch(okResponse);
    await breakDeliveries(stub);

    // The append starts a pass in the background: it must still answer.
    const posted = await stub.postMessage(tokens.alice ?? "", {
      text: "pass will fail",
      attachmentIds: [],
    });
    expect(posted).toMatchObject({ ok: true });

    // The alarm runs deliveries first; the lifecycle step still archives.
    await stub.forceState("slow", Date.now() - 48 * 3600 * 1000);
    await runDurableObjectAlarm(stub);
    expect((await stub.getMeta())?.state).toBe("archived");
  });

  it("logs webhook.pass_failed with an error class and no url", async () => {
    const { roomId, stub, tokens } = await quietRoom(["bob"]);
    captureFetch(okResponse);
    await breakDeliveries(stub);
    await stub.postMessage(tokens.alice ?? "", { text: "boom", attachmentIds: [] });

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    // The guard itself: the pass rejects and this still resolves.
    await runInDurableObject(stub, async (instance: RoomObject) => {
      await (instance as unknown as { runDeliveries(roomId: string): Promise<void> }).runDeliveries(
        roomId,
      );
    });

    const failed = lines
      .map((line) => JSON.parse(line) as { event: string; roomId?: string; errorClass?: string })
      .filter((entry) => entry.event === "webhook.pass_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ roomId, errorClass: "Error" });
    expect(lines.join("\n")).not.toContain(HOOK);
  });
});

/**
 * The object's clock is the time of its last I/O, which can sit a hair
 * behind the test's Date.now(); the schedule itself is exact.
 */
const CLOCK_SLACK_MS = 250;

describe("the retry schedule", () => {
  it("waits 5 s after the first failure and 30 s after the second", async () => {
    const { stub, tokens } = await quietRoom(["bob"]);
    captureFetch(failResponse);

    await stub.postMessage(tokens.alice ?? "", { text: "slow to land", attachmentIds: [] });
    const beforeFirst = Date.now();
    await flush(stub);
    const afterFirst = Date.now();
    const [first] = await pending(stub);
    if (!first) throw new Error("no pending delivery");
    expect(first.attempts).toBe(1);
    expect(first.next_at).toBeGreaterThanOrEqual(beforeFirst - CLOCK_SLACK_MS + 5_000);
    expect(first.next_at).toBeLessThanOrEqual(afterFirst + 5_000);

    expect(await stub.forceDeliveryDue()).toBe(1);
    const beforeSecond = Date.now();
    await flush(stub);
    const afterSecond = Date.now();
    const [second] = await pending(stub);
    if (!second) throw new Error("no pending delivery");
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.attempts).toBe(2);
    expect(second.next_at).toBeGreaterThanOrEqual(beforeSecond - CLOCK_SLACK_MS + 30_000);
    expect(second.next_at).toBeLessThanOrEqual(afterSecond + 30_000);
  });
});
