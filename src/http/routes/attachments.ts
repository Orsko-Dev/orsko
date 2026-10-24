import { Hono } from "hono";
import type { Env } from "../../env";
import { downloadAttachment, uploadAttachment } from "../../rooms/attachments";
import { AttachmentIdParam, RoomIdParam, UploadHeaders } from "../../validation/schemas";
import { bearerToken } from "../auth";
import { respondError, respondResult } from "../respond";

export const attachmentsApi = new Hono<{ Bindings: Env }>();

attachmentsApi.put("/:roomId/attachments", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = UploadHeaders.safeParse({
    "x-filename": c.req.header("x-filename"),
    "content-length": c.req.header("content-length"),
    "content-type": c.req.header("content-type"),
  });
  if (!parsed.success)
    return respondError(c, "invalid_request", parsed.error.issues[0]?.message ?? "invalid headers");
  const result = await uploadAttachment(
    c.env,
    id.data,
    bearerToken(c),
    parsed.data,
    c.req.raw.body,
  );
  return respondResult(c, result, 201);
});

/**
 * RFC 6266 pair: a quoted ASCII-only fallback for old clients (anything
 * outside printable ASCII, plus quotes, becomes "_") and the exact UTF-8
 * name for everyone else.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\u0020-\u007e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

attachmentsApi.get("/:roomId/attachments/:attachmentId", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  const aid = AttachmentIdParam.safeParse(c.req.param("attachmentId"));
  if (!id.success || !aid.success) return respondError(c, "invalid_request", "invalid id");
  const downloaded = await downloadAttachment(c.env, id.data, bearerToken(c), aid.data);
  if (!downloaded.ok) return respondError(c, downloaded.code, downloaded.message);
  const { attachment, body, contentType } = downloaded.value;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(attachment.size),
      "content-disposition": contentDisposition(attachment.filename),
      "x-content-type-options": "nosniff",
    },
  });
});
