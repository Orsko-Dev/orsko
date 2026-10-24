import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp } from "../helpers";

describe("HTTP attachments", () => {
  it("uploads, references, and downloads a file", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const viewer = await joinViaHttp(roomId, "viewer-1", "observer");
    const body = "diff --git a b\n";
    const up = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "text/plain",
        "content-length": String(body.length),
        "x-filename": "fix.diff",
      },
      body,
    });
    expect(up.status).toBe(201);
    const meta = (await up.json()) as { attachmentId: string; size: number };
    expect(meta.size).toBe(body.length);
    const stored = await env.ARCHIVE.get(`uploads/${roomId}/${meta.attachmentId}`);
    expect(await stored?.text()).toBe(body);

    const post = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "patch", attachmentIds: [meta.attachmentId] }),
    });
    expect(post.status).toBe(201);

    const dl = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments/${meta.attachmentId}`, {
      headers: { authorization: `Bearer ${viewer}` },
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain('filename="fix.diff"');
    expect(dl.headers.get("content-type")).toContain("text/plain");
    expect(await dl.text()).toBe(body);
  });

  it("rejects missing filename, oversized declared length, unsafe types, and unknown ids", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const noName = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: { authorization: `Bearer ${alice}`, "content-length": "3" },
      body: "abc",
    });
    expect(noName.status).toBe(400);
    const tooBig = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-length": String(10 * 1024 * 1024 + 1),
        "x-filename": "big.bin",
      },
      body: "abc",
    });
    expect(tooBig.status).toBe(413);
    const html = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "text/html",
        "content-length": "3",
        "x-filename": "x.html",
      },
      body: "<b>",
    });
    expect(html.status).toBe(201);
    const id = ((await html.json()) as { attachmentId: string }).attachmentId;
    const dl = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments/${id}`, {
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    const missing = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments/a_0000000000000000`, {
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(missing.status).toBe(404);
  });
});

describe("upload size enforcement", () => {
  it("rejects a body longer than content-length and leaves nothing in R2", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "text/plain",
        "content-length": "3",
        "x-filename": "lie.txt",
      },
      body: "0123456789",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    const listed = await env.ARCHIVE.list({ prefix: `uploads/${roomId}/` });
    expect(listed.objects).toHaveLength(0);
    expect((await env.ROOM.getByName(roomId).getMeta())?.attachmentCount).toBe(0);
  });

  it("rejects a body shorter than content-length", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "text/plain",
        "content-length": "20",
        "x-filename": "short.txt",
      },
      body: "abc",
    });
    expect(res.status).toBe(400);
    const listed = await env.ARCHIVE.list({ prefix: `uploads/${roomId}/` });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("filename handling", () => {
  it("rejects a filename with a control character", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-length": "3",
        "x-filename": "bad\tname.txt",
      },
      body: "abc",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("serves a non-ASCII filename with both content-disposition parameters", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const up = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "text/plain",
        "content-length": "2",
        "x-filename": "résumé.txt",
      },
      body: "ok",
    });
    expect(up.status).toBe(201);
    const id = ((await up.json()) as { attachmentId: string }).attachmentId;
    const dl = await SELF.fetch(`${BASE}/api/rooms/${roomId}/attachments/${id}`, {
      headers: { authorization: `Bearer ${alice}` },
    });
    const disposition = dl.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="r_sum_.txt"');
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
  });
});
