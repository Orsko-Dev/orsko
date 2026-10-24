import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { readArchivedRoom } from "../../src/room/archive";
import { generateRoomId } from "../../src/util/ids";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

interface OutcomeView {
  text: string;
  by: string;
  at: string;
}

async function putOutcome(roomId: string, token: string | null, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/outcome`, {
    method: "PUT",
    headers: token === null ? { "content-type": "application/json" } : authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function outcomeOf(roomId: string): Promise<OutcomeView | null> {
  const meta = (await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).json()) as {
    outcome: OutcomeView | null;
  };
  return meta.outcome;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function archive(roomId: string): Promise<void> {
  const stub = env.ROOM.getByName(roomId);
  await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
  await runDurableObjectAlarm(stub);
}

describe("PUT /outcome", () => {
  it("is null until an agent records one, then shows on the room and is announced", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    expect(await outcomeOf(roomId)).toBeNull();

    const res = await putOutcome(roomId, alice, { text: "  Decided: ship Tuesday.  " });
    expect(res.status).toBe(200);
    const { outcome } = (await res.json()) as { outcome: OutcomeView };
    expect(outcome.text).toBe("Decided: ship Tuesday.");
    expect(outcome.by).toBe("alice");
    expect(Number.isNaN(Date.parse(outcome.at))).toBe(false);
    expect(await outcomeOf(roomId)).toEqual(outcome);

    const poll = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages?since=0&waitSeconds=0`, {
      headers: authHeaders(alice),
    });
    const last = (
      (await poll.json()) as { messages: { from: string; text: string }[] }
    ).messages.at(-1);
    expect(last).toMatchObject({ from: "system", text: "alice recorded the outcome" });
  });

  it("keeps the latest write", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await putOutcome(roomId, alice, { text: "first draft" });
    await putOutcome(roomId, bob, { text: "final" });
    expect(await outcomeOf(roomId)).toMatchObject({ text: "final", by: "bob" });
  });

  it("refuses observers, credentials, bad lengths and missing tokens, and keeps the outcome", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const viewer = await joinViaHttp(roomId, "viewer-1", "observer");
    await putOutcome(roomId, alice, { text: "kept" });

    const observer = await putOutcome(roomId, viewer, { text: "mine now" });
    expect(observer.status).toBe(403);
    expect((await errorOf(observer)).code).toBe("forbidden");

    const secret = await putOutcome(roomId, alice, {
      text: "use postgres://app:hunter2pass@db.internal:5432/main",
    });
    expect(secret.status).toBe(422);
    expect((await errorOf(secret)).code).toBe("secret_detected");

    const empty = await putOutcome(roomId, alice, { text: "   " });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe(
      "text: Too small: expected string to have >=1 characters",
    );
    const long = await putOutcome(roomId, alice, { text: "x".repeat(2001) });
    expect(long.status).toBe(400);
    expect((await errorOf(long)).message).toBe(
      "text: Too big: expected string to have <=2000 characters",
    );

    const anonymous = await putOutcome(roomId, null, { text: "who am I" });
    expect(anonymous.status).toBe(401);
    expect(await outcomeOf(roomId)).toMatchObject({ text: "kept", by: "alice" });
  });

  it("shares the member's per-minute post allowance", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const alice = await stub.join({ name: "alice", role: "agent" });
    if (!alice.ok) throw new Error("join failed");
    // The counter is keyed by wall-clock minute: write until it refuses.
    let refused: { code: string; retryAfterSeconds?: number } | null = null;
    for (let i = 0; i < 2 * TIERS.free.maxPostsPerMinutePerMember + 2 && !refused; i += 1) {
      const result = await stub.setOutcome(alice.value.token, `revision ${i}`);
      if (!result.ok) refused = result;
    }
    expect(refused?.code).toBe("rate_limited");
    expect(typeof refused?.retryAfterSeconds).toBe("number");
  });

  it("is refused once the room is archived and survives in the archive record", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    await putOutcome(roomId, alice, { text: "archived with the room" });
    await archive(roomId);

    const late = await putOutcome(roomId, alice, { text: "too late" });
    expect(late.status).toBe(410);
    expect((await errorOf(late)).code).toBe("room_archived");

    const record = await readArchivedRoom(env.ARCHIVE, "free", roomId);
    expect(record?.meta.outcome).toMatchObject({ text: "archived with the room", by: "alice" });
    expect(await outcomeOf(roomId)).toMatchObject({ text: "archived with the room" });
  });
});
