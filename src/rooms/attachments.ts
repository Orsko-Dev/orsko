import {
  FALLBACK_CONTENT_TYPE,
  MCP_MAX_OPENED_TEXT_BYTES,
  MCP_MAX_SHARED_TEXT_BYTES,
  MCP_TEXT_CONTENT_TYPES,
  SAFE_CONTENT_TYPES,
  SHARED_TEXT_CONTENT_TYPES,
  SHARED_TEXT_DEFAULT_CONTENT_TYPE,
} from "../config/constants";
import type { Env } from "../env";
import { boundedBody } from "../http/bounded-stream";
import type { Attachment } from "../room/types";
import { fail, ok, type Result } from "../validation/errors";
import { SafeFilename } from "../validation/schemas";

export interface UploadMeta {
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
}

export interface DownloadedAttachment {
  readonly attachment: Attachment;
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
}

export interface OpenedAttachment {
  readonly attachment: Attachment;
  readonly text: string;
}

/**
 * Streams the body to R2 bounded by the declared size. Returns false when the
 * body did not match: either the bounded stream aborted the write, or R2
 * stored a different number of bytes than declared (a second guard).
 */
async function storeUpload(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  meta: UploadMeta,
): Promise<boolean> {
  try {
    const put = await bucket.put(key, boundedBody(body, meta.size), {
      httpMetadata: { contentType: meta.contentType },
      customMetadata: { filename: meta.filename },
    });
    return put.size === meta.size;
  } catch {
    return false;
  }
}

/**
 * The one upload path: `PUT /attachments` and `orsko_share_text` both call
 * this. The room object authorizes and records the attachment; the body
 * lands in R2 in between, cleaned up on any failure either side of it.
 */
export async function uploadAttachment(
  env: Env,
  roomId: string,
  token: string,
  meta: UploadMeta,
  body: ReadableStream<Uint8Array> | null,
): Promise<Result<Attachment>> {
  const stub = env.ROOM.getByName(roomId);
  const authorized = await stub.authorizeUpload(token, meta);
  if (!authorized.ok) return authorized;
  const { attachmentId, key } = authorized.value;
  if (body === null) return fail("invalid_request", "empty body");
  const stored = await storeUpload(env.ARCHIVE, key, body, meta);
  if (!stored) {
    await env.ARCHIVE.delete(key);
    return fail("invalid_request", "content-length did not match body size");
  }
  const recorded = await stub.recordAttachment(token, { attachmentId, ...meta });
  if (!recorded.ok) {
    await env.ARCHIVE.delete(key);
    return recorded;
  }
  return recorded;
}

export async function downloadAttachment(
  env: Env,
  roomId: string,
  token: string,
  attachmentId: string,
): Promise<Result<DownloadedAttachment>> {
  const authorized = await env.ROOM.getByName(roomId).authorizeDownload(token, attachmentId);
  if (!authorized.ok) return fail(authorized.code, authorized.message);
  const obj = await env.ARCHIVE.get(authorized.value.key);
  if (!obj) return fail("attachment_not_found", "attachment data is missing");
  const { attachment } = authorized.value;
  const contentType = SAFE_CONTENT_TYPES.has(attachment.contentType)
    ? attachment.contentType
    : FALLBACK_CONTENT_TYPE;
  return ok({ attachment, body: obj.body, contentType });
}

/** The content type for a shared-text upload, from the filename's extension. */
function sharedTextContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return SHARED_TEXT_CONTENT_TYPES.get(ext) ?? SHARED_TEXT_DEFAULT_CONTENT_TYPE;
}

export async function shareText(
  env: Env,
  roomId: string,
  token: string,
  input: { readonly filename: string; readonly text: string },
): Promise<Result<Attachment>> {
  const filename = SafeFilename.safeParse(input.filename);
  if (!filename.success)
    return fail("invalid_request", "filename must be 1-255 characters with no path");
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.byteLength === 0) return fail("invalid_request", "text is empty");
  if (bytes.byteLength > MCP_MAX_SHARED_TEXT_BYTES)
    return fail(
      "attachment_too_large",
      `text is ${bytes.byteLength} bytes; at most ${MCP_MAX_SHARED_TEXT_BYTES} bytes can be shared as text`,
    );
  const contentType = sharedTextContentType(filename.data);
  return uploadAttachment(
    env,
    roomId,
    token,
    { filename: filename.data, size: bytes.byteLength, contentType },
    new Response(bytes).body,
  );
}

export async function openAttachment(
  env: Env,
  roomId: string,
  token: string,
  attachmentId: string,
): Promise<Result<OpenedAttachment>> {
  const authorized = await env.ROOM.getByName(roomId).authorizeDownload(token, attachmentId);
  if (!authorized.ok) return fail(authorized.code, authorized.message);
  const { attachment } = authorized.value;
  const described = `attachment ${attachmentId} is ${attachment.contentType}, ${attachment.size} bytes`;
  if (!MCP_TEXT_CONTENT_TYPES.has(attachment.contentType))
    return fail(
      "invalid_request",
      `${described}; only ${[...MCP_TEXT_CONTENT_TYPES].join(", ")} attachments can be opened as text`,
    );
  if (attachment.size > MCP_MAX_OPENED_TEXT_BYTES)
    return fail(
      "attachment_too_large",
      `${described}; attachments over ${MCP_MAX_OPENED_TEXT_BYTES} bytes cannot be opened as text`,
    );
  const obj = await env.ARCHIVE.get(authorized.value.key);
  if (!obj) return fail("attachment_not_found", "attachment data is missing");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return ok({ attachment, text });
  } catch {
    return fail("invalid_request", `attachment ${attachmentId} is not valid UTF-8 text`);
  }
}
