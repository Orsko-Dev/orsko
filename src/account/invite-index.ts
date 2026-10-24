/**
 * The account-side record of room invites. The room object holds the hash it
 * validates joins against; this holds who an invite was addressed to, what it
 * was labelled and what became of it, which is what the owner's list and the
 * "link my rooms when I sign up" hook need. The raw token is in neither.
 */

/** What an invite is, as the owner's list reports it. */
export type InviteStatus = "pending" | "used" | "revoked" | "expired";

export interface InviteRecord {
  readonly inviteId: string;
  readonly label: string | null;
  readonly addressedEmail: string | null;
  readonly addressedGithubLogin: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  readonly status: InviteStatus;
}

export interface InviteInput {
  readonly inviteId: string;
  readonly roomId: string;
  readonly issuedByUserId: string;
  readonly tokenHash: string;
  readonly label: string | null;
  readonly addressedEmail: string | null;
  readonly addressedGithubLogin: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface InviteRow {
  readonly id: string;
  readonly label: string | null;
  readonly addressed_email: string | null;
  readonly addressed_github_login: string | null;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
  readonly revoked_at: number | null;
}

export async function insertInvite(db: D1Database, invite: InviteInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO invites (id, room_id, issued_by_user_id, addressed_email, addressed_github_login,
         token_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invite.inviteId,
      invite.roomId,
      invite.issuedByUserId,
      invite.addressedEmail,
      invite.addressedGithubLogin,
      invite.tokenHash,
      invite.label,
      invite.createdAt,
      invite.expiresAt,
    )
    .run();
}

/**
 * What became of an invite. Being spent is final: an invite that admitted a
 * member stays `used` even if the owner revokes it afterwards, because the
 * member it let in is still in the room and the list would otherwise imply
 * the opposite.
 */
function statusOf(row: InviteRow, now: number): InviteStatus {
  if (row.used_at !== null) return "used";
  if (row.revoked_at !== null) return "revoked";
  return row.expires_at <= now ? "expired" : "pending";
}

/** Every invite issued for one room, newest first. Tokens are never read back. */
export async function listInvitesForRoom(
  db: D1Database,
  roomId: string,
  now: number,
): Promise<InviteRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, label, addressed_email, addressed_github_login, created_at, expires_at,
         used_at, revoked_at
       FROM invites WHERE room_id = ? ORDER BY created_at DESC`,
    )
    .bind(roomId)
    .all<InviteRow>();
  return result.results.map((row) => ({
    inviteId: row.id,
    label: row.label,
    addressedEmail: row.addressed_email,
    addressedGithubLogin: row.addressed_github_login,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    status: statusOf(row, now),
  }));
}

/** Mirrors the room object's single-use stamp. Only ever set once. */
export async function markInviteUsed(
  db: D1Database,
  inviteId: string,
  memberId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE invites SET used_at = ?, used_by_member_id = ? WHERE id = ? AND used_at IS NULL",
    )
    .bind(now, memberId, inviteId)
    .run();
}

/**
 * Stamps an invite revoked. A spent invite is left alone: revoking it takes
 * nothing back, and the stamp would only muddle what the owner is shown.
 */
export async function markInviteRevoked(
  db: D1Database,
  inviteId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL",
    )
    .bind(now, inviteId)
    .run();
}

/**
 * Links a member admitted by an addressed invite to the account that invite
 * names, when that account already exists. A member who joined with their own
 * key or session is left alone: their own identity wins over the address the
 * invite was sent to.
 *
 * This races the member insert the room mirrors in the background: when the
 * `room_members` row has not landed yet the update matches nothing and the
 * link is simply not made. That is why it is not the only path — the next
 * sign-in by the addressed person runs `linkPendingMembers`, which fills in
 * exactly the rows this pass missed, so the gap heals itself.
 */
export async function linkMemberFromInvite(
  db: D1Database,
  inviteId: string,
  memberId: string,
): Promise<void> {
  const user = await db
    .prepare(
      `SELECT u.id AS id FROM users u JOIN invites i ON i.id = ?
       WHERE (i.addressed_email IS NOT NULL AND u.email = i.addressed_email)
          OR (i.addressed_github_login IS NOT NULL
              AND LOWER(u.github_login) = LOWER(i.addressed_github_login))
       LIMIT 1`,
    )
    .bind(inviteId)
    .first<{ id: string }>();
  if (!user) return;
  await db
    .prepare("UPDATE room_members SET user_id = ? WHERE member_id = ? AND user_id IS NULL")
    .bind(user.id, memberId)
    .run();
}

/**
 * The account-side half of spending an invite: the used stamp, and the link
 * from the new member to the account the invite was addressed to, when that
 * account already exists. GitHub logins are matched case-insensitively: the
 * owner types the login as they saw it, GitHub reports it as it stores it. Best effort in the sense that the room object has
 * already admitted the member; a failure here is a history gap, not a
 * security hole.
 */
export async function recordInviteUse(
  db: D1Database,
  inviteId: string,
  memberId: string,
  now: number,
): Promise<void> {
  await markInviteUsed(db, inviteId, memberId, now);
  await linkMemberFromInvite(db, inviteId, memberId);
}

/**
 * Claims the rooms an invite addressed to this person already admitted an
 * agent to, before they had an account. Runs after every sign-in, so an
 * invitee who joins first and signs up later still sees the room in their
 * history. Idempotent: it only ever fills in a member row that has no user.
 */
export async function linkPendingMembers(
  db: D1Database,
  user: { id: string; email: string; github_login: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE room_members SET user_id = ?
       WHERE user_id IS NULL AND invite_id IN (
         SELECT id FROM invites
         WHERE addressed_email = ?
            OR (addressed_github_login IS NOT NULL AND LOWER(addressed_github_login) = ?))`,
    )
    .bind(user.id, user.email, user.github_login?.toLowerCase() ?? null)
    .run();
}
