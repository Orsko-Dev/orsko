import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_MAX_OPENED_TEXT_BYTES, MCP_MAX_SHARED_TEXT_BYTES } from "../../src/config/constants";
import { BASE, createRoomViaHttp, joinViaHttp } from "../helpers";
import { callTool, errorOf, listTools, toolValue } from "../mcp";

interface JoinedByConnector {
  readonly memberId: string;
  readonly token: string;
  readonly name: string;
  readonly nextSince: number;
}

async function joinByConnector(room: string, name: string): Promise<JoinedByConnector> {
  return toolValue<JoinedByConnector>(await callTool("orsko_join", { room, name }));
}

const ANNOTATIONS: Readonly<
  Record<string, { readonly readOnlyHint: boolean; readonly destructiveHint: boolean }>
> = {
  orsko_join: { readOnlyHint: false, destructiveHint: false },
  orsko_read: { readOnlyHint: true, destructiveHint: false },
  orsko_post: { readOnlyHint: false, destructiveHint: false },
  orsko_members: { readOnlyHint: true, destructiveHint: false },
  orsko_outcome: { readOnlyHint: false, destructiveHint: false },
  orsko_share_text: { readOnlyHint: false, destructiveHint: false },
  orsko_open_attachment: { readOnlyHint: true, destructiveHint: false },
  orsko_leave: { readOnlyHint: false, destructiveHint: true },
};

describe("connector record tools", () => {
  it("interpolates the opened-text byte limit rather than hardcoding it", async () => {
    const tools = await listTools();
    const openAttachment = tools.find((t) => t.name === "orsko_open_attachment");
    expect(openAttachment?.description).toContain(`${MCP_MAX_OPENED_TEXT_BYTES} bytes`);
    expect(openAttachment?.description).not.toContain("1 MiB");
  });

  it("lists all eight tools with input schemas and the spec's annotations", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ANNOTATIONS).sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toHaveProperty("room");
      expect(tool.annotations).toEqual(ANNOTATIONS[tool.name]);
    }
  });

  it("records the outcome", async () => {
    const { roomId } = await createRoomViaHttp();
    const recorder = await joinByConnector(roomId, "recorder");

    const result = toolValue<{ outcome: { text: string; by: string } }>(
      await callTool("orsko_outcome", {
        room: roomId,
        token: recorder.token,
        text: "Decided: ship Tuesday.",
      }),
    );
    expect(result.outcome.text).toBe("Decided: ship Tuesday.");
    expect(result.outcome.by).toBe("recorder");

    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}`);
    const meta = (await res.json()) as { outcome: { text: string } };
    expect(meta.outcome.text).toBe("Decided: ship Tuesday.");

    const blank = await callTool("orsko_outcome", {
      room: roomId,
      token: recorder.token,
      text: "   ",
    });
    expect(blank.isError).toBe(true);
    expect(blank.content[0]?.text).toContain("Input validation error");
  });

  it("shares text and opens it again", async () => {
    const { roomId } = await createRoomViaHttp();
    const sharer = await joinByConnector(roomId, "sharer");

    const shared = toolValue<{ attachmentId: string; filename: string; size: number }>(
      await callTool("orsko_share_text", {
        room: roomId,
        token: sharer.token,
        filename: "plan.md",
        text: "# Plan\n\nship it",
      }),
    );
    expect(shared.attachmentId).toMatch(/^a_[a-z0-9]{16}$/);
    expect(shared.filename).toBe("plan.md");
    expect(shared.size).toBe(15);

    const opened = await callTool("orsko_open_attachment", {
      room: roomId,
      token: sharer.token,
      attachmentId: shared.attachmentId,
    });
    expect(opened.content[1]?.text).toBe("# Plan\n\nship it");
    expect(
      (JSON.parse(opened.content[0]?.text ?? "{}") as { contentType: string }).contentType,
    ).toBe("text/markdown");
  });

  it("refuses to share text over the byte cap", async () => {
    const { roomId } = await createRoomViaHttp();
    const sharer = await joinByConnector(roomId, "over-cap");

    const result = await callTool("orsko_share_text", {
      room: roomId,
      token: sharer.token,
      filename: "big.txt",
      text: "x".repeat(MCP_MAX_SHARED_TEXT_BYTES + 1),
    });
    expect(errorOf(result).code).toBe("attachment_too_large");
    expect(errorOf(result).message).toContain(String(MCP_MAX_SHARED_TEXT_BYTES));
  });

  it("refuses to open a non-text attachment with its size and type", async () => {
    const { roomId } = await createRoomViaHttp();
    const uploader = await joinViaHttp(roomId, "uploader");
    const connector = await joinByConnector(roomId, "opener");

    const upload = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${uploader}`,
        "x-filename": "pic.png",
        "content-type": "image/png",
        "content-length": "4",
      },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    expect(upload.status).toBe(201);
    const { attachmentId } = (await upload.json()) as { attachmentId: string };

    const result = await callTool("orsko_open_attachment", {
      room: roomId,
      token: connector.token,
      attachmentId,
    });
    expect(errorOf(result).code).toBe("invalid_request");
    expect(errorOf(result).message).toContain("image/png");
    expect(errorOf(result).message).toContain("4 bytes");
  });

  it("refuses an unsafe filename", async () => {
    const { roomId } = await createRoomViaHttp();
    const sharer = await joinByConnector(roomId, "unsafe");

    const result = await callTool("orsko_share_text", {
      room: roomId,
      token: sharer.token,
      filename: "../passwd",
      text: "anything",
    });
    expect(errorOf(result)).toEqual({
      code: "invalid_request",
      message: "filename must be 1-255 characters with no path",
    });
  });

  it("does not let an observer share text", async () => {
    const { roomId } = await createRoomViaHttp();
    const watcherToken = await joinViaHttp(roomId, "watcher", "observer");

    const result = await callTool("orsko_share_text", {
      room: roomId,
      token: watcherToken,
      filename: "note.txt",
      text: "anything",
    });
    expect(errorOf(result).code).toBe("forbidden");
    expect(errorOf(result).message).toBe("observers cannot upload");
  });
});
