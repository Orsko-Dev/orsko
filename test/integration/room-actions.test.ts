import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_MAX_OPENED_TEXT_BYTES, MCP_MAX_SHARED_TEXT_BYTES } from "../../src/config/constants";
import type { Env } from "../../src/env";
import { joinRoom, postToRoom, readRoom } from "../../src/rooms/actions";
import { openAttachment, shareText, uploadAttachment } from "../../src/rooms/attachments";
import { createRoomViaHttp } from "../helpers";

const workerEnv: Env = { ...env };

async function seatMember(roomId: string): Promise<string> {
  const joined = await joinRoom(workerEnv, {
    roomId,
    name: "alice",
    role: "agent",
    invite: null,
    userId: null,
  });
  if (!joined.ok) throw new Error(`join failed: ${joined.code} ${joined.message}`);
  return joined.value.token;
}

describe("room actions", () => {
  it("posts and reads through the same room object as the API", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const posted = await postToRoom(workerEnv, roomId, token, {
      text: "via actions",
      attachmentIds: [],
    });
    expect(posted.ok).toBe(true);
    const read = await readRoom(workerEnv, roomId, token, { since: 0, waitSeconds: 0 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.messages.map((m) => m.text)).toContain("via actions");
  });

  it("shares text as an attachment and opens it again", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const text = "# Plan\n\nship it";
    const shared = await shareText(workerEnv, roomId, token, { filename: "plan.md", text });
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.value.contentType).toBe("text/markdown");
    expect(shared.value.size).toBe(new TextEncoder().encode(text).byteLength);
    const opened = await openAttachment(workerEnv, roomId, token, shared.value.attachmentId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.text).toBe(text);
  });

  it("stores an unknown extension, inherited object keys included, as text/plain", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const shared = await shareText(workerEnv, roomId, token, {
      filename: "notes.constructor",
      text: "hi",
    });
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.value.contentType).toBe("text/plain");
  });

  it("refuses an unsafe filename", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const shared = await shareText(workerEnv, roomId, token, {
      filename: "../passwd",
      text: "hi",
    });
    expect(shared).toEqual({
      ok: false,
      code: "invalid_request",
      message: "filename must be 1-255 characters with no path",
    });
  });

  it("refuses empty text and text over the cap", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const empty = await shareText(workerEnv, roomId, token, { filename: "a.txt", text: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe("invalid_request");
      expect(empty.message).toBe("text is empty");
    }
    const tooBig = await shareText(workerEnv, roomId, token, {
      filename: "a.txt",
      text: "x".repeat(MCP_MAX_SHARED_TEXT_BYTES + 1),
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.code).toBe("attachment_too_large");
  });

  it("refuses to open a non-text attachment, naming its type and size", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const uploaded = await uploadAttachment(
      workerEnv,
      roomId,
      token,
      { filename: "pic.png", size: 4, contentType: "image/png" },
      new Response(new Uint8Array([137, 80, 78, 71])).body,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const opened = await openAttachment(workerEnv, roomId, token, uploaded.value.attachmentId);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.code).toBe("invalid_request");
      expect(opened.message).toContain("image/png");
      expect(opened.message).toContain("4 bytes");
    }
  });

  it("refuses to open a text attachment over the cap", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const size = MCP_MAX_OPENED_TEXT_BYTES + 1;
    const bytes = new Uint8Array(size).fill(97);
    const uploaded = await uploadAttachment(
      workerEnv,
      roomId,
      token,
      { filename: "big.txt", size, contentType: "text/plain" },
      new Response(bytes).body,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const opened = await openAttachment(workerEnv, roomId, token, uploaded.value.attachmentId);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.code).toBe("attachment_too_large");
      expect(opened.message).toContain(`${size} bytes`);
    }
  });

  it("refuses to open bytes that are not UTF-8", async () => {
    const { roomId } = await createRoomViaHttp();
    const token = await seatMember(roomId);
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    const uploaded = await uploadAttachment(
      workerEnv,
      roomId,
      token,
      { filename: "bad.txt", size: bytes.byteLength, contentType: "text/plain" },
      new Response(bytes).body,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    const opened = await openAttachment(workerEnv, roomId, token, uploaded.value.attachmentId);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.code).toBe("invalid_request");
      expect(opened.message.endsWith("is not valid UTF-8 text")).toBe(true);
    }
  });
});
