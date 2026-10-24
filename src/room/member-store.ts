/**
 * Every query over the `members` table, and the member row itself. Split out
 * of `storage.ts` so neither file grows past a readable size; `storage.ts`
 * re-exports all of it, so callers import from either.
 */
import { avatarFor, observerAvatarFor } from "../avatar/avatar";
import { SYSTEM_SENDER } from "../config/constants";
import { isoFromMs } from "../util/time";
import { addMissingColumns, type ColumnMigration, firstRow, rows, type SqlRow } from "./sql";
import type { Member, MemberRole, MemberStatus, PublicMember } from "./types";
import { webhookStatusOf } from "./webhook-store";

export interface MemberRow {
  readonly member_id: string;
  readonly name: string;
  readonly name_lower: string;
  readonly role: MemberRole;
  readonly token_hash: string;
  readonly joined_at: number;
  readonly left_at: number | null;
  readonly read_through: number;
  /**
   * The highest seq the room has handed this member in a join or poll
   * response. `unread` counts from the later of this and `read_through`, so
   * an agent is not told it missed what it was just given.
   */
  readonly delivered_through: number;
  readonly last_seen_at: number | null;
  readonly webhook_url: string | null;
  /**
   * Stored in plain form: the room signs every delivery with it, so it
   * cannot be hashed the way member tokens are. It is returned once at
   * registration and never read back out through the API.
   */
  readonly webhook_secret: string | null;
  readonly webhook_status: string | null;
  /** The account this member is linked to, or null when unlinked. */
  readonly user_id: string | null;
  /** The invite that admitted them, when one did. */
  readonly invite_id: string | null;
}

/**
 * Columns added to `members` after the table shipped. Rooms created before
 * the change already have the table, so CREATE TABLE IF NOT EXISTS skips
 * them; each missing column is added here instead.
 */
const MEMBER_COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { name: "read_through", ddl: "read_through INTEGER NOT NULL DEFAULT 0" },
  { name: "last_seen_at", ddl: "last_seen_at INTEGER" },
  { name: "user_id", ddl: "user_id TEXT" },
  { name: "invite_id", ddl: "invite_id TEXT" },
  { name: "delivered_through", ddl: "delivered_through INTEGER NOT NULL DEFAULT 0" },
];

/**
 * Adds any missing `members` column to a room that already has the table.
 * Idempotent: the check runs against the live table shape, so it is safe to
 * call on every actor start and from ensureSchema, for old and new rooms
 * alike. It writes only when a column is actually missing.
 *
 * Callers must have confirmed the room's tables exist (see `hasRoomTable`):
 * running DDL on a room that was never created would allocate storage for it.
 */
export function migrateMembers(sql: SqlStorage): void {
  addMissingColumns(sql, "members", MEMBER_COLUMN_MIGRATIONS);
}

/** Seed for a member's deterministic avatar, derived from their room and name. */
function avatarSeedFor(name: string, role: MemberRole, roomId: string): string {
  return role === "observer" ? observerAvatarFor(name, roomId).seed : avatarFor(name, roomId).seed;
}

function toMember(m: MemberRow, roomId: string): Member {
  return {
    memberId: m.member_id,
    name: m.name,
    role: m.role,
    joinedAt: isoFromMs(m.joined_at),
    leftAt: m.left_at === null ? null : isoFromMs(m.left_at),
    readThrough: m.read_through,
    lastSeenAt: m.last_seen_at === null ? null : isoFromMs(m.last_seen_at),
    webhookStatus: webhookStatusOf(m.webhook_status),
    avatarSeed: avatarSeedFor(m.name, m.role, roomId),
    linked: m.user_id !== null,
  };
}

export function listMembers(sql: SqlStorage, roomId: string): Member[] {
  return rows(sql.exec<SqlRow<MemberRow>>("SELECT * FROM members ORDER BY joined_at")).map((m) =>
    toMember(m, roomId),
  );
}

export function listPresentMembers(sql: SqlStorage, roomId: string): Member[] {
  return rows(
    sql.exec<SqlRow<MemberRow>>("SELECT * FROM members WHERE left_at IS NULL ORDER BY joined_at"),
  ).map((m) => toMember(m, roomId));
}

/**
 * A present member linked to the given account, or null. It answers "has
 * this account already been admitted to this room", which is how the owner
 * and previously invited members rejoin a private room without an invite.
 */
export function findMemberByUserId(sql: SqlStorage, userId: string): MemberRow | null {
  return firstRow(
    sql.exec<SqlRow<MemberRow>>(
      "SELECT * FROM members WHERE user_id = ? AND left_at IS NULL LIMIT 1",
      userId,
    ),
  );
}

/** The same member without the webhook state, for the unauthenticated view. */
export function publicMember(m: Member, status: MemberStatus): PublicMember {
  return {
    memberId: m.memberId,
    name: m.name,
    role: m.role,
    joinedAt: m.joinedAt,
    leftAt: m.leftAt,
    readThrough: m.readThrough,
    lastSeenAt: m.lastSeenAt,
    avatarSeed: m.avatarSeed,
    status,
  };
}

export function countPresentByRole(sql: SqlStorage, role: MemberRole): number {
  return sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM members WHERE role = ? AND left_at IS NULL",
      role,
    )
    .one().n;
}

export function countActiveAgents(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM members WHERE role = 'agent' AND left_at IS NULL",
    )
    .one().n;
}

export function findMemberByNameLower(sql: SqlStorage, nameLower: string): MemberRow | null {
  return firstRow(
    sql.exec<SqlRow<MemberRow>>(
      "SELECT * FROM members WHERE name_lower = ? AND left_at IS NULL",
      nameLower,
    ),
  );
}

/** The member behind an id, present or departed. Null when unknown. */
export function findMemberById(sql: SqlStorage, memberId: string): MemberRow | null {
  return firstRow(
    sql.exec<SqlRow<MemberRow>>("SELECT * FROM members WHERE member_id = ?", memberId),
  );
}

export function findMemberByTokenHash(sql: SqlStorage, hash: string): MemberRow | null {
  return firstRow(sql.exec<SqlRow<MemberRow>>("SELECT * FROM members WHERE token_hash = ?", hash));
}

export function insertMember(sql: SqlStorage, m: MemberRow): void {
  sql.exec(
    `INSERT INTO members (member_id, name, name_lower, role, token_hash, joined_at, left_at,
      read_through, delivered_through, last_seen_at, webhook_url, webhook_secret, webhook_status,
      user_id, invite_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.member_id,
    m.name,
    m.name_lower,
    m.role,
    m.token_hash,
    m.joined_at,
    m.left_at,
    m.read_through,
    m.delivered_through,
    m.last_seen_at,
    m.webhook_url,
    m.webhook_secret,
    m.webhook_status,
    m.user_id,
    m.invite_id,
  );
}

/** Records that the member made an authenticated request at `now`. */
export function touchMember(sql: SqlStorage, memberId: string, now: number): void {
  sql.exec("UPDATE members SET last_seen_at = ? WHERE member_id = ?", now, memberId);
}

/**
 * Moves the member's read cursor forward. It never moves backwards: a poll
 * that replays older messages does not undo evidence of what was read.
 */
export function advanceReadThrough(sql: SqlStorage, memberId: string, since: number): void {
  sql.exec(
    "UPDATE members SET read_through = MAX(read_through, ?) WHERE member_id = ?",
    since,
    memberId,
  );
}

/** Moves the member's delivered cursor forward; like read_through, never back. */
export function advanceDeliveredThrough(sql: SqlStorage, memberId: string, seq: number): void {
  sql.exec(
    "UPDATE members SET delivered_through = MAX(delivered_through, ?) WHERE member_id = ?",
    seq,
    memberId,
  );
}

/**
 * How many messages by other members this member has been neither handed nor
 * marked read: those after the later of its two cursors that it did not write
 * and the room did not announce. Callers count before appending the member's
 * own post, so that post is never among them.
 *
 * Matched by `from_name`, which is unique only among currently present
 * members (see `findMemberByNameLower`), not for the lifetime of the room: if
 * a new agent joins reusing a departed member's name, messages the departed
 * member wrote under that name are excluded from the new member's count too,
 * under-counting its unread.
 */
export function countUnread(sql: SqlStorage, member: MemberRow): number {
  return sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE seq > ? AND from_name <> ? AND from_name <> ?",
      Math.max(member.read_through, member.delivered_through),
      member.name,
      SYSTEM_SENDER,
    )
    .one().n;
}

export function markMemberLeft(sql: SqlStorage, memberId: string, leftAt: number): void {
  sql.exec("UPDATE members SET left_at = ? WHERE member_id = ?", leftAt, memberId);
}

/** How many agents ever joined, departed ones included. Observers never count. */
export function countAgentsEver(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'agent'").one().n;
}

/** The first agent ever to join, present or departed, or null when none has. */
export function firstAgent(sql: SqlStorage): MemberRow | null {
  return firstRow(
    sql.exec<SqlRow<MemberRow>>(
      "SELECT * FROM members WHERE role = 'agent' ORDER BY joined_at LIMIT 1",
    ),
  );
}
