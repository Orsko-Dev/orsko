import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { generateRoomId } from "../../src/util/ids";

async function roomWithAlice() {
  const roomId = generateRoomId();
  const stub = env.ROOM.getByName(roomId);
  await stub.create({ roomId, purpose: null, tier: "free" });
  const a = await stub.join({ name: "alice", role: "agent" });
  const v = await stub.join({ name: "viewer-1", role: "observer" });
  if (!a.ok || !v.ok) throw new Error("join failed");
  return { roomId, stub, alice: a.value.token, viewer: v.value.token };
}

describe("RoomObject attachments", () => {
  it("authorizes, records, and authorizes download", async () => {
    const { roomId, stub, alice, viewer } = await roomWithAlice();
    const auth = await stub.authorizeUpload(alice, {
      filename: "a.txt",
      size: 5,
      contentType: "text/plain",
    });
    if (!auth.ok) throw new Error("authorize failed");
    expect(auth.value.key).toBe(`uploads/${roomId}/${auth.value.attachmentId}`);
    const rec = await stub.recordAttachment(alice, {
      attachmentId: auth.value.attachmentId,
      filename: "a.txt",
      size: 5,
      contentType: "text/plain",
    });
    expect(rec.ok).toBe(true);
    const dl = await stub.authorizeDownload(viewer, auth.value.attachmentId);
    if (!dl.ok) throw new Error("download auth failed");
    expect(dl.value.attachment.filename).toBe("a.txt");
    expect((await stub.getMeta())?.attachmentCount).toBe(1);
  });

  it("rejects too large, observers, and unknown ids", async () => {
    const { stub, alice, viewer } = await roomWithAlice();
    const tooBig = TIERS.free.maxAttachmentBytes + 1;
    expect(
      await stub.authorizeUpload(alice, { filename: "b", size: tooBig, contentType: "x" }),
    ).toMatchObject({
      code: "attachment_too_large",
    });
    expect(
      await stub.authorizeUpload(viewer, { filename: "b", size: 1, contentType: "x" }),
    ).toMatchObject({
      code: "forbidden",
    });
    expect(await stub.authorizeDownload(alice, "a_0000000000000000")).toMatchObject({
      code: "attachment_not_found",
    });
  });

  it("enforces maxAttachmentsPerRoom at record time", async () => {
    const { stub, alice } = await roomWithAlice();
    for (let i = 0; i < TIERS.free.maxAttachmentsPerRoom; i += 1) {
      const a = await stub.authorizeUpload(alice, {
        filename: `f${i}`,
        size: 1,
        contentType: "text/plain",
      });
      if (!a.ok) throw new Error("authorize failed");
      const r = await stub.recordAttachment(alice, {
        attachmentId: a.value.attachmentId,
        filename: `f${i}`,
        size: 1,
        contentType: "text/plain",
      });
      expect(r.ok).toBe(true);
    }
    expect(
      await stub.authorizeUpload(alice, { filename: "z", size: 1, contentType: "text/plain" }),
    ).toMatchObject({
      code: "too_many_attachments",
    });
  });

  it("rejects recording the same attachmentId twice", async () => {
    const { stub, alice } = await roomWithAlice();
    const a = await stub.authorizeUpload(alice, {
      filename: "dup.txt",
      size: 4,
      contentType: "text/plain",
    });
    if (!a.ok) throw new Error("authorize failed");
    const first = await stub.recordAttachment(alice, {
      attachmentId: a.value.attachmentId,
      filename: "dup.txt",
      size: 4,
      contentType: "text/plain",
    });
    expect(first.ok).toBe(true);
    const second = await stub.recordAttachment(alice, {
      attachmentId: a.value.attachmentId,
      filename: "dup.txt",
      size: 4,
      contentType: "text/plain",
    });
    expect(second).toMatchObject({ ok: false, code: "invalid_request" });
    expect((await stub.getMeta())?.attachmentCount).toBe(1);
  });

  it("messages can reference recorded attachments", async () => {
    const { stub, alice } = await roomWithAlice();
    const a = await stub.authorizeUpload(alice, {
      filename: "p.diff",
      size: 3,
      contentType: "text/plain",
    });
    if (!a.ok) throw new Error("authorize failed");
    await stub.recordAttachment(alice, {
      attachmentId: a.value.attachmentId,
      filename: "p.diff",
      size: 3,
      contentType: "text/plain",
    });
    const m = await stub.postMessage(alice, {
      text: "patch attached",
      attachmentIds: [a.value.attachmentId],
    });
    expect(m.ok && m.value.attachmentIds).toEqual([a.value.attachmentId]);
  });
});
