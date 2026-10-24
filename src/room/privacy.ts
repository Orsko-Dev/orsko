import { INVITE_TOKEN_PREFIX } from "../config/constants";
import { generateInviteSecret, hashToken } from "../util/ids";
import { fail, ok, type Result } from "../validation/errors";
import { findMemberByUserId } from "./member-store";
import { firstRow, type SqlRow } from "./sql";
import type { RoomRow } from "./storage";

/**
 * The room object's own record of the invites it has issued: hash, expiry
 * and single-use stamp, and nothing else. Who an invite was addressed to and
 * what it was labelled live in D1, where the owner's list is built; the room
 * holds only what validating a join needs, so no join touches D1.
 */
export interface InviteRow {
  readonly invite_id: string;
  readonly token_hash: string;
  readonly expires_at: number;
  readonly used_at: number | null;
  readonly used_by_member_id: string | null;
}

/**
 * Idempotent, and safe to run on every actor start alongside the other room
 * migrations. Callers must have confirmed the room's tables exist: running
 * DDL on a room that was never created would allocate storage for it.
 */
export function ensureInviteSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      invite_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by_member_id TEXT
    );
  `);
}

/**
 * A fresh invite token and its hash. The raw token is returned to the owner
 * once, in the mint response, and is never stored or logged anywhere; only
 * the hash reaches either database.
 */
export function mintInviteToken(): { raw: string; hash: Promise<string> } {
  const raw = `${INVITE_TOKEN_PREFIX}${generateInviteSecret()}`;
  return { raw, hash: hashToken(raw) };
}

export function inviteTokenHash(raw: string): Promise<string> {
  return hashToken(raw);
}

/** Whether a string is shaped like an invite token at all. */
export function isInviteToken(raw: string): boolean {
  return raw.startsWith(INVITE_TOKEN_PREFIX) && raw.length > INVITE_TOKEN_PREFIX.length;
}

export function insertInvite(
  sql: SqlStorage,
  invite: { inviteId: string; tokenHash: string; expiresAt: number },
): void {
  sql.exec(
    "INSERT INTO invites (invite_id, token_hash, expires_at, used_at, used_by_member_id) VALUES (?, ?, ?, NULL, NULL)",
    invite.inviteId,
    invite.tokenHash,
    invite.expiresAt,
  );
}

/** An invite that is neither used nor expired, or null. Reads only. */
export function findUsableInvite(
  sql: SqlStorage,
  tokenHash: string,
  now: number,
): InviteRow | null {
  return firstRow(
    sql.exec<SqlRow<InviteRow>>(
      "SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
      tokenHash,
      now,
    ),
  );
}

/**
 * Spends an invite on one member, in a single conditional write so that two
 * joins racing the same token cannot both be admitted. Returns the invite id
 * for the member row and the D1 mirror, or `invalid` when the token is
 * unknown, already spent, revoked or expired.
 */
export function consumeInvite(
  sql: SqlStorage,
  tokenHash: string,
  now: number,
  memberId: string,
): { status: "ok"; inviteId: string } | { status: "invalid" } {
  const updated = sql.exec(
    "UPDATE invites SET used_at = ?, used_by_member_id = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    now,
    memberId,
    tokenHash,
    now,
  );
  if (updated.rowsWritten === 0) return { status: "invalid" };
  const row = firstRow(
    sql.exec<SqlRow<InviteRow>>("SELECT * FROM invites WHERE token_hash = ?", tokenHash),
  );
  return row ? { status: "ok", inviteId: row.invite_id } : { status: "invalid" };
}

/**
 * Drops an invite from the room, which is what revoking it means here: the
 * token stops validating immediately. D1 keeps the row and stamps it
 * `revoked_at`, so the owner's list still shows what was issued.
 */
export function revokeInvite(sql: SqlStorage, inviteId: string): boolean {
  return sql.exec("DELETE FROM invites WHERE invite_id = ?", inviteId).rowsWritten > 0;
}

/** How a caller is entitled to see, or join, this room. */
export type ViewAccess = "owner" | "member" | "invite" | "public";

/**
 * The one access rule for a private room, used by the browser view and by
 * join alike. A public room is open to everyone, as it always was. The
 * creator and any account already admitted to the room pass without an
 * invite; anyone else needs a usable one. Nothing here consumes anything:
 * reading the room's instructions must not spend the token that joining it
 * will need.
 */
export async function viewAccess(
  sql: SqlStorage,
  row: RoomRow,
  caller: { userId?: string | null; invite?: string | null },
  now: number,
): Promise<Result<ViewAccess>> {
  if (row.private !== 1) return ok("public");
  const userId = caller.userId ?? null;
  if (userId !== null && row.creator_user_id === userId) return ok("owner");
  if (userId !== null && findMemberByUserId(sql, userId)) return ok("member");
  const invite = caller.invite ?? null;
  if (invite === null || invite.length === 0)
    return fail("invite_required", "this room is private and needs an invite");
  if (!isInviteToken(invite)) return fail("invite_invalid", "that invite is not valid");
  const found = findUsableInvite(sql, await inviteTokenHash(invite), now);
  if (!found) return fail("invite_invalid", "that invite is used, revoked or expired");
  return ok("invite");
}
