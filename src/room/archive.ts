import type { Tier } from "../config/tiers";
import type { Attachment, Message, RoomMeta } from "./types";

export type ArchiveFile = "transcript.jsonl" | "room.json";

export function archiveKey(tier: Tier, roomId: string, name: ArchiveFile): string {
  return `${tier}/rooms/${roomId}/${name}`;
}

export type AttachmentState = "live" | "archived";

/**
 * Live uploads sit outside the tier prefixes so the R2 lifecycle rules on
 * `free/` and `paid/` cannot expire an attachment while its room is still
 * running. Archiving copies them under the tier prefix, where retention
 * then matches the archived transcript.
 */
export function uploadKey(roomId: string, attachmentId: string): string {
  return `uploads/${roomId}/${attachmentId}`;
}

export function attachmentKey(
  tier: Tier,
  roomId: string,
  attachmentId: string,
  state: AttachmentState,
): string {
  return state === "live"
    ? uploadKey(roomId, attachmentId)
    : `${tier}/rooms/${roomId}/attachments/${attachmentId}`;
}

/**
 * Idempotent move of every recorded attachment into the archive prefix.
 * A destination that already exists is left alone (an earlier attempt got
 * that far) and the source is deleted if it is still present, so an alarm
 * retry after a partial failure converges.
 */
export async function archiveAttachments(
  bucket: R2Bucket,
  tier: Tier,
  roomId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  for (const attachmentId of attachmentIds) {
    const from = attachmentKey(tier, roomId, attachmentId, "live");
    const to = attachmentKey(tier, roomId, attachmentId, "archived");
    if ((await bucket.head(to)) === null) {
      const source = await bucket.get(from);
      if (source === null) continue;
      await bucket.put(to, source.body, {
        ...(source.httpMetadata === undefined ? {} : { httpMetadata: source.httpMetadata }),
        ...(source.customMetadata === undefined ? {} : { customMetadata: source.customMetadata }),
      });
    }
    await bucket.delete(from);
  }
}

export interface ArchivedRoom {
  readonly meta: RoomMeta;
  readonly attachments: readonly Attachment[];
  readonly archivedAt: string;
}

export async function writeArchive(
  bucket: R2Bucket,
  meta: RoomMeta,
  messages: readonly Message[],
  attachments: readonly Attachment[],
  archivedAt: string,
): Promise<void> {
  const jsonl = messages.map((m) => JSON.stringify(m)).join("\n");
  const record: ArchivedRoom = { meta, attachments, archivedAt };
  await Promise.all([
    bucket.put(archiveKey(meta.tier, meta.roomId, "transcript.jsonl"), `${jsonl}\n`, {
      httpMetadata: { contentType: "application/x-ndjson" },
    }),
    bucket.put(archiveKey(meta.tier, meta.roomId, "room.json"), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    }),
  ]);
}

export async function readArchivedTranscript(
  bucket: R2Bucket,
  tier: Tier,
  roomId: string,
): Promise<Message[] | null> {
  const obj = await bucket.get(archiveKey(tier, roomId, "transcript.jsonl"));
  if (!obj) return null;
  const text = await obj.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Message);
}

export async function readArchivedRoom(
  bucket: R2Bucket,
  tier: Tier,
  roomId: string,
): Promise<ArchivedRoom | null> {
  const obj = await bucket.get(archiveKey(tier, roomId, "room.json"));
  return obj ? ((await obj.json()) as ArchivedRoom) : null;
}

export async function readArchivedMeta(
  bucket: R2Bucket,
  tier: Tier,
  roomId: string,
): Promise<RoomMeta | null> {
  const record = await readArchivedRoom(bucket, tier, roomId);
  return record ? record.meta : null;
}
