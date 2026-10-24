import type { TierLimits } from "../config/tiers";
import { logEvent } from "../util/log";
import { fail, ok, type Result } from "../validation/errors";
import { detectSecrets, secretRejectionMessage } from "../validation/secrets";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";

export interface PostInput {
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

/**
 * The room-state gate every write shares: an archived room accepts neither a
 * post nor an outcome. Pulled out so `checkPost` and `checkOutcome` refuse it
 * with the same code and message.
 */
export function checkRoomActive(row: RoomRow): Result<null> {
  if (row.state === "archived") return fail("room_archived", "room is archived");
  return ok(null);
}

/**
 * The credential guardrail every write shares: reject text that looks like a
 * live secret, and log the room, the member, and the kinds found — never the
 * text itself. `eventName` lets each caller log under its own event name
 * while sharing the rest of the check.
 */
export function checkSecrets(
  text: string,
  row: RoomRow,
  member: MemberRow,
  eventName: string,
): Result<null> {
  const secrets = detectSecrets(text);
  if (secrets.length === 0) return ok(null);
  logEvent(eventName, {
    roomId: row.room_id,
    memberId: member.member_id,
    kinds: secrets.map((hit) => hit.kind).join(","),
  });
  return fail("secret_detected", secretRejectionMessage(secrets));
}

/**
 * Every check a post must clear before a message row is written: room state,
 * size, room capacity, referenced attachments, the credential guardrail, and
 * the per-member rate limit. The rate limit counter is bumped last, so a post
 * rejected for any other reason does not consume quota.
 *
 * Rejecting on a credential logs the room, the member, and the kinds found,
 * and nothing else: the text itself is never stored or logged.
 */
export function checkPost(
  sql: SqlStorage,
  row: RoomRow,
  limits: TierLimits,
  member: MemberRow,
  input: PostInput,
  now: number,
): Result<null> {
  const active = checkRoomActive(row);
  if (!active.ok) return active;
  const bytes = new TextEncoder().encode(input.text).byteLength;
  if (bytes > limits.maxMessageTextBytes) {
    return fail("message_too_large", `text exceeds ${limits.maxMessageTextBytes} bytes`);
  }
  if (db.countMessages(sql) >= limits.maxMessages) {
    return fail("too_many_messages", `room has reached ${limits.maxMessages} messages`);
  }
  for (const id of input.attachmentIds) {
    if (!db.findAttachment(sql, id))
      return fail("attachment_not_found", `unknown attachment ${id}`);
  }
  const secrets = checkSecrets(input.text, row, member, "message.secret_rejected");
  if (!secrets.ok) return secrets;
  return checkRate(sql, limits, member, now);
}

/** The member's per-minute allowance, shared by posts and outcome writes. */
export function checkRate(
  sql: SqlStorage,
  limits: TierLimits,
  member: MemberRow,
  now: number,
): Result<null> {
  const minute = Math.floor(now / 60_000);
  if (db.bumpPostRate(sql, member.member_id, minute) > limits.maxPostsPerMinutePerMember) {
    return fail(
      "rate_limited",
      "too many posts this minute",
      60 - Math.floor((now % 60_000) / 1000),
    );
  }
  return ok(null);
}
