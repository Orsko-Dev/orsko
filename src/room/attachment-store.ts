import { isoFromMs } from "../util/time";
import { firstRow, rows, type SqlRow } from "./sql";
import type { Attachment } from "./types";

interface AttachmentRow {
  readonly attachment_id: string;
  readonly filename: string;
  readonly size: number;
  readonly content_type: string;
  readonly uploaded_by: string;
  readonly created_at: number;
}

function toAttachment(a: AttachmentRow): Attachment {
  return {
    attachmentId: a.attachment_id,
    filename: a.filename,
    size: a.size,
    contentType: a.content_type,
    uploadedBy: a.uploaded_by,
    createdAt: isoFromMs(a.created_at),
  };
}

export function countAttachments(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachments").one().n;
}

export function insertAttachment(sql: SqlStorage, a: AttachmentRow): Attachment {
  sql.exec(
    `INSERT INTO attachments (attachment_id, filename, size, content_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    a.attachment_id,
    a.filename,
    a.size,
    a.content_type,
    a.uploaded_by,
    a.created_at,
  );
  return toAttachment(a);
}

export function findAttachment(sql: SqlStorage, attachmentId: string): Attachment | null {
  const row = firstRow(
    sql.exec<SqlRow<AttachmentRow>>(
      "SELECT * FROM attachments WHERE attachment_id = ?",
      attachmentId,
    ),
  );
  return row ? toAttachment(row) : null;
}

export function listAttachments(sql: SqlStorage): Attachment[] {
  return rows(sql.exec<SqlRow<AttachmentRow>>("SELECT * FROM attachments ORDER BY created_at")).map(
    toAttachment,
  );
}

export function bumpPostRate(sql: SqlStorage, memberId: string, minute: number): number {
  sql.exec(
    `INSERT INTO post_rate (member_id, minute, count) VALUES (?, ?, 1)
     ON CONFLICT(member_id, minute) DO UPDATE SET count = count + 1`,
    memberId,
    minute,
  );
  sql.exec("DELETE FROM post_rate WHERE minute < ?", minute - 2);
  return sql
    .exec<{ count: number }>(
      "SELECT count FROM post_rate WHERE member_id = ? AND minute = ?",
      memberId,
      minute,
    )
    .one().count;
}
