import type { Tier, TierLimits } from "../config/tiers";
import { generateAttachmentId } from "../util/ids";
import { fail, ok, type Result } from "../validation/errors";
import { attachmentKey } from "./archive";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import type { Attachment, MemberRole } from "./types";

/**
 * Bundles what the attachment helpers need from a RoomObject instance,
 * without requiring them to see the whole class (or its protected
 * members) directly. `authenticate` is passed as a bound function since
 * RoomObject.authenticate is protected.
 */
export interface AttachmentContext {
  readonly sql: SqlStorage;
  authenticate(
    token: string,
  ): Promise<Result<{ member_id: string; name: string; role: MemberRole }>>;
  room(): RoomRow | null;
  limits(row: RoomRow): TierLimits;
}

async function attachmentGate(
  ctx: AttachmentContext,
  token: string,
  size: number,
): Promise<Result<{ tier: Tier; roomId: string; name: string }>> {
  const auth = await ctx.authenticate(token);
  if (!auth.ok) return auth;
  if (auth.value.role !== "agent") return fail("forbidden", "observers cannot upload");
  const row = ctx.room();
  if (!row) return fail("room_not_found", "room does not exist");
  if (row.state === "archived") return fail("room_archived", "room is archived");
  const limits = ctx.limits(row);
  if (size > limits.maxAttachmentBytes) {
    return fail("attachment_too_large", `attachment exceeds ${limits.maxAttachmentBytes} bytes`);
  }
  if (db.countAttachments(ctx.sql) >= limits.maxAttachmentsPerRoom) {
    return fail(
      "too_many_attachments",
      `room has reached ${limits.maxAttachmentsPerRoom} attachments`,
    );
  }
  return ok({ tier: row.tier as Tier, roomId: row.room_id, name: auth.value.name });
}

export async function authorizeUpload(
  ctx: AttachmentContext,
  token: string,
  input: { filename: string; size: number; contentType: string },
): Promise<Result<{ attachmentId: string; key: string }>> {
  const gate = await attachmentGate(ctx, token, input.size);
  if (!gate.ok) return gate;
  const attachmentId = generateAttachmentId();
  return ok({
    attachmentId,
    key: attachmentKey(gate.value.tier, gate.value.roomId, attachmentId, "live"),
  });
}

export async function recordAttachment(
  ctx: AttachmentContext,
  token: string,
  input: { attachmentId: string; filename: string; size: number; contentType: string },
  now: number,
): Promise<Result<Attachment>> {
  const gate = await attachmentGate(ctx, token, input.size);
  if (!gate.ok) return gate;
  if (db.findAttachment(ctx.sql, input.attachmentId)) {
    return fail("invalid_request", "attachment already recorded");
  }
  const attachment = db.insertAttachment(ctx.sql, {
    attachment_id: input.attachmentId,
    filename: input.filename,
    size: input.size,
    content_type: input.contentType,
    uploaded_by: gate.value.name,
    created_at: now,
  });
  db.updateRoomRow(ctx.sql, { last_activity_at: now });
  return ok(attachment);
}

export async function authorizeDownload(
  ctx: AttachmentContext,
  token: string,
  attachmentId: string,
): Promise<Result<{ attachment: Attachment; key: string }>> {
  const auth = await ctx.authenticate(token);
  if (!auth.ok) return auth;
  const row = ctx.room();
  if (!row) return fail("room_not_found", "room does not exist");
  const attachment = db.findAttachment(ctx.sql, attachmentId);
  if (!attachment) return fail("attachment_not_found", `unknown attachment ${attachmentId}`);
  const state = row.state === "archived" ? "archived" : "live";
  return ok({ attachment, key: attachmentKey(row.tier as Tier, row.room_id, attachmentId, state) });
}
