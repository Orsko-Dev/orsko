import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrskoApiError, OrskoClient, OrskoNetworkError } from "../src/client.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";

describe("OrskoClient", () => {
  let fake: FakeOrsko;
  let client: OrskoClient;

  beforeEach(async () => {
    fake = await startFakeOrsko();
    client = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
  });

  afterEach(async () => {
    await fake.close();
  });

  it("joins and returns the membership with recent messages", async () => {
    const join = await client.join({ name: "alice" });
    expect(join.name).toBe("alice");
    expect(join.token).toMatch(/^tok_/);
    expect(join.recent.at(-1)?.text).toBe("alice joined");
    expect(join.nextSince).toBe(1);
  });

  it("sends the API key header and the invite on join when configured", async () => {
    const keyed = new OrskoClient({
      baseUrl: fake.baseUrl,
      roomId: fake.roomId,
      apiKey: "orsko_key_abc",
    });
    await keyed.join({ name: "alice", invite: "orsko_inv_xyz" });
    expect(fake.joinRequests).toEqual([
      { name: "alice", invite: "orsko_inv_xyz", apiKey: "orsko_key_abc" },
    ]);
  });

  it("omits the API key header and the invite when they are not configured", async () => {
    await client.join({ name: "bob" });
    expect(fake.joinRequests).toEqual([{ name: "bob", invite: null, apiKey: null }]);
  });

  it("carries the token on authenticated calls via withToken", async () => {
    const join = await client.join({ name: "alice" });
    const authed = client.withToken(join.token);
    expect(client.hasToken).toBe(false);
    expect(authed.hasToken).toBe(true);
    const members = await authed.members();
    expect(members.members.map((m) => m.name)).toEqual(["alice"]);
    expect(members.lastSeq).toBe(1);
  });

  it("posts a message and returns it", async () => {
    const join = await client.join({ name: "alice" });
    const authed = client.withToken(join.token);
    const message = await authed.post({ text: "hello room" });
    expect(message.from).toBe("alice");
    expect(message.seq).toBe(2);
  });

  it("polls without waiting and reports the mode", async () => {
    const join = await client.join({ name: "alice" });
    const authed = client.withToken(join.token);
    fake.push("bob", "hi alice");
    const result = await authed.poll({ since: join.nextSince, waitSeconds: 0 });
    expect(result.messages.map((m) => m.text)).toEqual(["hi alice"]);
    expect(result.mode).toBe("live");
    expect(result.nextSince).toBe(2);
  });

  it("surfaces the retryAfterSeconds of slow mode", async () => {
    const join = await client.join({ name: "alice" });
    fake.mode = "slow";
    fake.retryAfterSeconds = 12;
    const result = await client.withToken(join.token).poll({ since: 1, waitSeconds: 0 });
    expect(result.mode).toBe("slow");
    expect(result.retryAfterSeconds).toBe(12);
  });

  it("uploads an attachment", async () => {
    const join = await client.join({ name: "alice" });
    const body = Buffer.from("id,name\n1,a\n");
    const uploaded = await client.withToken(join.token).upload({
      filename: "rows.csv",
      contentType: "text/csv",
      body,
    });
    expect(uploaded.attachmentId).toMatch(/^a_/);
    expect(fake.uploads[0]?.body.toString("utf8")).toBe(body.toString("utf8"));
    expect(fake.uploads[0]?.filename).toBe("rows.csv");
  });

  it("throws OrskoApiError with the server's code for API errors", async () => {
    const join = await client.join({ name: "alice" });
    const authed = client.withToken(join.token);
    await expect(authed.post({ text: "token sk-live-abc" })).rejects.toMatchObject({
      name: "OrskoApiError",
      code: "secret_detected",
      status: 422,
    });
    await expect(client.withToken("nope").members()).rejects.toBeInstanceOf(OrskoApiError);
    await expect(client.join({ name: "alice" })).rejects.toMatchObject({ code: "name_taken" });
  });

  it("throws OrskoNetworkError when the host is unreachable", async () => {
    const offline = new OrskoClient({ baseUrl: "http://127.0.0.1:1", roomId: fake.roomId });
    await expect(offline.join({ name: "alice" })).rejects.toBeInstanceOf(OrskoNetworkError);
  });

  it("refuses an authenticated call without a token", async () => {
    await expect(client.members()).rejects.toThrow(/token/);
  });
});
