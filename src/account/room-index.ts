import { avatarFor, observerAvatarFor } from "../avatar/avatar";

/** How many rooms one history page holds. */
export const HISTORY_PAGE_SIZE = 50;

export type HistoryFilter = "all" | "created" | "joined";

export interface HistoryMember {
  readonly name: string;
  readonly role: string;
  readonly avatarSeed: string;
}

export interface HistoryRoom {
  readonly roomId: string;
  readonly purpose: string | null;
  readonly private: boolean;
  readonly state: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly yourRole: "creator" | "joined" | "both";
  readonly members: readonly HistoryMember[];
  readonly url: string;
}

export interface RoomIndexInput {
  readonly roomId: string;
  readonly creatorUserId: string | null;
  readonly private: boolean;
  readonly purpose: string | null;
  readonly createdAt: number;
  readonly state: string;
  readonly lastActivityAt: number;
}

export interface RoomStatePatch {
  readonly state?: string;
  readonly lastActivityAt?: number;
  readonly archivedAt?: number;
  readonly expiredAt?: number;
  readonly private?: boolean;
  /** When the nightly reconcile pass last attempted this row, success or failure. */
  readonly reconciledAt?: number;
}

export interface RoomMemberInput {
  readonly roomId: string;
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly userId: string | null;
  readonly inviteId: string | null;
  readonly joinedAt: number;
  readonly leftAt: number | null;
}

/**
 * Records a room in the account index. Idempotent on `room_id`: a repeated
 * create (a retried write, or a reconciliation pass) refreshes the mutable
 * columns and never duplicates the row. `creator_user_id` is only ever
 * filled in, never cleared, so a late anonymous write cannot orphan a room
 * from the account that made it.
 */
export async function upsertRoom(db: D1Database, r: RoomIndexInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rooms (room_id, creator_user_id, private, purpose, created_at, state, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         creator_user_id = COALESCE(rooms.creator_user_id, excluded.creator_user_id),
         private = excluded.private,
         purpose = COALESCE(excluded.purpose, rooms.purpose),
         state = excluded.state,
         last_activity_at = MAX(rooms.last_activity_at, excluded.last_activity_at)`,
    )
    .bind(
      r.roomId,
      r.creatorUserId,
      r.private ? 1 : 0,
      r.purpose,
      r.createdAt,
      r.state,
      r.lastActivityAt,
    )
    .run();
}

/** The columns `updateRoomState` may write, in D1 column order. */
const STATE_COLUMNS: readonly (readonly [keyof RoomStatePatch, string])[] = [
  ["state", "state"],
  ["lastActivityAt", "last_activity_at"],
  ["archivedAt", "archived_at"],
  ["expiredAt", "expired_at"],
  ["private", "private"],
  ["reconciledAt", "reconciled_at"],
];

function patchValue(patch: RoomStatePatch, key: keyof RoomStatePatch): number | string | null {
  const value = patch[key];
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ?? null;
}

/**
 * Moves an indexed room's mutable state forward. Only the keys present in
 * the patch are written, so a state change never clobbers an archive stamp
 * written by another pass.
 */
export async function updateRoomState(
  db: D1Database,
  roomId: string,
  patch: RoomStatePatch,
): Promise<void> {
  const present = STATE_COLUMNS.filter(([key]) => patch[key] !== undefined);
  if (present.length === 0) return;
  const sets = present.map(([, column]) => `${column} = ?`).join(", ");
  await db
    .prepare(`UPDATE rooms SET ${sets} WHERE room_id = ?`)
    .bind(...present.map(([key]) => patchValue(patch, key)), roomId)
    .run();
}

/**
 * Records a member of an indexed room. Idempotent on `member_id`; the link
 * to a user and to the invite that admitted them is only ever filled in.
 */
export async function upsertRoomMember(db: D1Database, m: RoomMemberInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO room_members (room_id, member_id, name, role, user_id, invite_id, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         user_id = COALESCE(room_members.user_id, excluded.user_id),
         invite_id = COALESCE(room_members.invite_id, excluded.invite_id),
         left_at = COALESCE(excluded.left_at, room_members.left_at)`,
    )
    .bind(m.roomId, m.memberId, m.name, m.role, m.userId, m.inviteId, m.joinedAt, m.leftAt)
    .run();
}

export async function markMemberLeft(
  db: D1Database,
  memberId: string,
  leftAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE room_members SET left_at = ? WHERE member_id = ? AND left_at IS NULL")
    .bind(leftAt, memberId)
    .run();
}

interface HistoryRow {
  readonly room_id: string;
  readonly purpose: string | null;
  readonly private: number;
  readonly state: string;
  readonly created_at: number;
  readonly last_activity_at: number;
  readonly is_creator: number;
  readonly is_member: number;
}

interface MemberNameRow {
  readonly room_id: string;
  readonly name: string;
  readonly role: string;
}

/** Keyset position: the last row of a page, as `<lastActivityAt>:<roomId>`. */
function encodeCursor(row: HistoryRow): string {
  return `${row.last_activity_at}:${row.room_id}`;
}

/**
 * Parses a caller-supplied cursor. Anything malformed is treated as no
 * cursor at all rather than as an error: a stale or hand-edited value
 * should show the first page, not a 500.
 */
function decodeCursor(cursor: string | null): { at: number; roomId: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf(":");
  if (split <= 0) return null;
  const at = Number(cursor.slice(0, split));
  const roomId = cursor.slice(split + 1);
  if (!Number.isSafeInteger(at) || at < 0 || roomId.length === 0) return null;
  return { at, roomId };
}

function roleOf(row: HistoryRow): "creator" | "joined" | "both" {
  if (row.is_creator === 1 && row.is_member === 1) return "both";
  return row.is_creator === 1 ? "creator" : "joined";
}

function scopeClause(filter: HistoryFilter): string {
  if (filter === "created") return "r.creator_user_id = ?";
  if (filter === "joined")
    return "EXISTS(SELECT 1 FROM room_members m WHERE m.room_id = r.room_id AND m.user_id = ?)";
  return "(r.creator_user_id = ? OR EXISTS(SELECT 1 FROM room_members m WHERE m.room_id = r.room_id AND m.user_id = ?))";
}

function avatarSeedFor(name: string, role: string, roomId: string): string {
  return role === "observer" ? observerAvatarFor(name, roomId).seed : avatarFor(name, roomId).seed;
}

/**
 * The members of every room on one history page, keyed by room id, in join
 * order. One query for the whole page rather than one per room.
 */
async function membersByRoom(
  db: D1Database,
  roomIds: readonly string[],
): Promise<Map<string, HistoryMember[]>> {
  const byRoom = new Map<string, HistoryMember[]>();
  if (roomIds.length === 0) return byRoom;
  const placeholders = roomIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT room_id, name, role FROM room_members WHERE room_id IN (${placeholders}) ORDER BY joined_at`,
    )
    .bind(...roomIds)
    .all<MemberNameRow>();
  for (const row of result.results) {
    const list = byRoom.get(row.room_id) ?? [];
    list.push({
      name: row.name,
      role: row.role,
      avatarSeed: avatarSeedFor(row.name, row.role, row.room_id),
    });
    byRoom.set(row.room_id, list);
  }
  return byRoom;
}

/**
 * One page of the caller's room history, newest activity first. Rooms the
 * user created and rooms an agent of theirs joined both count; a room whose
 * storage has expired is left out. Paging is keyset, not offset, so a room
 * whose activity moves between requests cannot make another one vanish.
 */
export async function listRoomsForUser(
  db: D1Database,
  userId: string,
  filter: HistoryFilter,
  cursor: string | null,
  baseUrl: string,
): Promise<{ rooms: HistoryRoom[]; nextCursor: string | null }> {
  const scope = scopeClause(filter);
  const binds: (string | number)[] = [userId, userId, userId];
  if (filter === "all") binds.push(userId);
  const position = decodeCursor(cursor);
  const keyset = position
    ? " AND (r.last_activity_at < ? OR (r.last_activity_at = ? AND r.room_id < ?))"
    : "";
  if (position) binds.push(position.at, position.at, position.roomId);
  binds.push(HISTORY_PAGE_SIZE + 1);
  const result = await db
    .prepare(
      `SELECT r.room_id, r.purpose, r.private, r.state, r.created_at, r.last_activity_at,
         CASE WHEN r.creator_user_id = ? THEN 1 ELSE 0 END AS is_creator,
         CASE WHEN EXISTS(SELECT 1 FROM room_members m WHERE m.room_id = r.room_id AND m.user_id = ?) THEN 1 ELSE 0 END AS is_member
       FROM rooms r
       WHERE r.expired_at IS NULL AND ${scope}${keyset}
       ORDER BY r.last_activity_at DESC, r.room_id DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<HistoryRow>();
  const page = result.results.slice(0, HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  const members = await membersByRoom(
    db,
    page.map((row) => row.room_id),
  );
  return {
    rooms: page.map((row) => ({
      roomId: row.room_id,
      purpose: row.purpose,
      private: row.private === 1,
      state: row.state,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      yourRole: roleOf(row),
      members: members.get(row.room_id) ?? [],
      url: `${baseUrl}/r/${row.room_id}`,
    })),
    nextCursor: result.results.length > HISTORY_PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}
