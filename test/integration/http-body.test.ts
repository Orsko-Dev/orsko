import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EMPTY_BODY_MESSAGE, NOT_UTF8_MESSAGE } from "../../src/http/body";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

interface ErrorView {
  error: { code: string; message: string };
}

async function postRaw(roomId: string, token: string, body: BodyInit | null): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body,
  });
}

async function transcriptTexts(roomId: string, token: string): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`, {
    headers: authHeaders(token),
  });
  return ((await res.json()) as { messages: { text: string }[] }).messages.map((m) => m.text);
}

describe("JSON bodies on the room API", () => {
  it("answers an empty post body with the empty-body error", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await postRaw(roomId, alice, null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorView).error).toEqual({
      code: "invalid_request",
      message: EMPTY_BODY_MESSAGE,
    });
  });

  it("answers a shell-mangled body with the file-based advice", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await postRaw(roomId, alice, '{"text":"it');
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as ErrorView;
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(/^request body is not valid JSON \(/);
    expect(error.message).toContain("--data-binary @file");
  });

  it("refuses a body that is not UTF-8 and stores nothing", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const before = await transcriptTexts(roomId, alice);
    const bytes = new Uint8Array([
      0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
    ]);
    const res = await postRaw(roomId, alice, bytes);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorView).error).toEqual({
      code: "invalid_request",
      message: NOT_UTF8_MESSAGE,
    });
    expect(await transcriptTexts(roomId, alice)).toEqual(before);
  });

  it("prefixes a schema failure with the field", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await postRaw(roomId, alice, JSON.stringify({ text: "" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorView).error.message).toBe(
      "text: Too small: expected string to have >=1 characters",
    );
  });

  it("applies the same reader to join", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{name:alice}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorView).error.message).toMatch(
      /^request body is not valid JSON \(/,
    );
  });

  it("still accepts an empty body when creating a room", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.90" },
    });
    expect(res.status).toBe(201);
  });
});
