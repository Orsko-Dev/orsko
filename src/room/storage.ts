import { isoFromMs, utcDayKey } from "../util/time";
import { migrateMembers } from "./member-store";
import { ensureInviteSchema } from "./privacy";
import { addMissingColumns, type ColumnMigration, firstRow, rows, type SqlRow } from "./sql";
import type { Message, RoomState } from "./types";
import { ensureWebhookSchema } from "./webhook-store";

export interface RoomRow {
  readonly room_id: string;
  readonly tier: string;
  readonly state: RoomState;
  readonly purpose: string | null;
  readonly created_at: number;
  readonly last_activity_at: number;
  readonly next_seq: number;
  readonly budget_day: string;
  readonly budget_used_seconds: number;
  readonly budget_live_since: number | null;
  readonly archived_at: number | null;
  /** The account that created the room, or null for an anonymous room. */
  readonly creator_user_id: string | null;
  /** 1 when joining requires an invite. Stored as an integer for SQLite. */
  readonly private: number;
  /** The latest recorded outcome, the agent name that recorded it, and when. Null until then. */
  readonly outcome_text: string | null;
  readonly outcome_by: string | null;
  readonly outcome_at: number | null;
  /** When the "nobody else has joined" nudge was posted; null until it is. */
  readonly empty_nudge_at: number | null;
}

interface MessageRow {
  readonly seq: number;
  readonly id: string;
  readonly from_name: string;
  readonly text: string;
  readonly attachment_ids: string;
  readonly created_at: number;
}

export * from "./attachment-store";
export * from "./member-store";

export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS room (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_id TEXT NOT NULL, tier TEXT NOT NULL, state TEXT NOT NULL, purpose TEXT,
      created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, next_seq INTEGER NOT NULL,
      budget_day TEXT NOT NULL, budget_used_seconds INTEGER NOT NULL, budget_live_since INTEGER,
      archived_at INTEGER, creator_user_id TEXT, private INTEGER NOT NULL DEFAULT 0,
      outcome_text TEXT, outcome_by TEXT, outcome_at INTEGER, empty_nudge_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS members (
      member_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, left_at INTEGER,
      read_through INTEGER NOT NULL DEFAULT 0, delivered_through INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER,
      webhook_url TEXT, webhook_secret TEXT, webhook_status TEXT, user_id TEXT, invite_id TEXT,
      -- Reserved: created for the migration path and for older rooms that
      -- already have it, never written. Retry state lives per delivery, in
      -- webhook_deliveries.attempts.
      webhook_failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS members_name_lower ON members(name_lower);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL,
      attachment_ids TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY, filename TEXT NOT NULL, size INTEGER NOT NULL,
      content_type TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_rate (
      member_id TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (member_id, minute)
    );
  `);
  migrateRoomSchema(sql);
}

/** The same, for the single-row `room` table. */
const ROOM_COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { name: "creator_user_id", ddl: "creator_user_id TEXT" },
  { name: "private", ddl: "private INTEGER NOT NULL DEFAULT 0" },
  { name: "outcome_text", ddl: "outcome_text TEXT" },
  { name: "outcome_by", ddl: "outcome_by TEXT" },
  { name: "outcome_at", ddl: "outcome_at INTEGER" },
  { name: "empty_nudge_at", ddl: "empty_nudge_at INTEGER" },
];

/**
 * Adds any missing `room` column to a room that already has the table, on
 * the same idempotent terms as {@link migrateMembers}.
 */
export function migrateRoomTable(sql: SqlStorage): void {
  addMissingColumns(sql, "room", ROOM_COLUMN_MIGRATIONS);
}

/**
 * Every idempotent migration a room may still be missing, in one call. Run
 * on actor start and on the first room() of a deploy, so a room created
 * before any of these shipped catches up without a separate backfill.
 *
 * Callers must have confirmed the room's tables exist (see `hasRoomTable`):
 * running DDL on a room that was never created would allocate storage for it.
 */
export function migrateRoomSchema(sql: SqlStorage): void {
  migrateMembers(sql);
  migrateRoomTable(sql);
  ensureWebhookSchema(sql);
  ensureInviteSchema(sql);
}

/**
 * Read-only probe for the room table. Durable Object SQL storage is created
 * lazily, so running DDL (or querying a missing table) on a room that was
 * never created would allocate storage for it. Callers use this to decide
 * whether any other query is safe to run.
 */
export function hasRoomTable(sql: SqlStorage): boolean {
  return (
    firstRow(
      sql.exec<SqlRow<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room'",
      ),
    ) !== null
  );
}

export function readRoomRow(sql: SqlStorage): RoomRow | null {
  return firstRow(sql.exec<SqlRow<RoomRow>>("SELECT * FROM room WHERE id = 1"));
}

/** A freshly created room, live and empty, with its budget day started. */
export function newRoomRow(
  input: {
    roomId: string;
    tier: string;
    purpose: string | null;
    creatorUserId?: string | null;
    private?: boolean;
  },
  now: number,
): RoomRow {
  return {
    room_id: input.roomId,
    tier: input.tier,
    state: "live",
    purpose: input.purpose,
    created_at: now,
    last_activity_at: now,
    next_seq: 1,
    budget_day: utcDayKey(now),
    budget_used_seconds: 0,
    budget_live_since: null,
    archived_at: null,
    creator_user_id: input.creatorUserId ?? null,
    private: input.private ? 1 : 0,
    outcome_text: null,
    outcome_by: null,
    outcome_at: null,
    empty_nudge_at: null,
  };
}

export function insertRoomRow(sql: SqlStorage, r: RoomRow): void {
  sql.exec(
    `INSERT INTO room (id, room_id, tier, state, purpose, created_at, last_activity_at, next_seq,
      budget_day, budget_used_seconds, budget_live_since, archived_at, creator_user_id, private,
      outcome_text, outcome_by, outcome_at, empty_nudge_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.room_id,
    r.tier,
    r.state,
    r.purpose,
    r.created_at,
    r.last_activity_at,
    r.next_seq,
    r.budget_day,
    r.budget_used_seconds,
    r.budget_live_since,
    r.archived_at,
    r.creator_user_id,
    r.private,
    r.outcome_text,
    r.outcome_by,
    r.outcome_at,
    r.empty_nudge_at,
  );
}

export function updateRoomRow(sql: SqlStorage, patch: Partial<RoomRow>): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  sql.exec(`UPDATE room SET ${sets} WHERE id = 1`, ...entries.map(([, v]) => v));
}

function toMessage(roomId: string, r: MessageRow): Message {
  return {
    id: r.id,
    seq: r.seq,
    roomId,
    from: r.from_name,
    text: r.text,
    attachmentIds: JSON.parse(r.attachment_ids) as string[],
    createdAt: isoFromMs(r.created_at),
  };
}

export function countMessages(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
}

export function insertMessage(sql: SqlStorage, roomId: string, r: MessageRow): Message {
  sql.exec(
    "INSERT INTO messages (seq, id, from_name, text, attachment_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    r.seq,
    r.id,
    r.from_name,
    r.text,
    r.attachment_ids,
    r.created_at,
  );
  return toMessage(roomId, r);
}

export function findMessageBySeq(sql: SqlStorage, roomId: string, seq: number): Message | null {
  const row = firstRow(sql.exec<SqlRow<MessageRow>>("SELECT * FROM messages WHERE seq = ?", seq));
  return row ? toMessage(roomId, row) : null;
}

export function listMessagesSince(
  sql: SqlStorage,
  roomId: string,
  since: number,
  limit: number,
): Message[] {
  return rows(
    sql.exec<SqlRow<MessageRow>>(
      "SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
      since,
      limit,
    ),
  ).map((r) => toMessage(roomId, r));
}

/**
 * The most recent `limit` messages, in ascending seq order. Queries newest
 * first (so the LIMIT bounds the scan to the tail of the table) and reverses
 * the result rather than mutating it.
 */
export function listRecentMessages(sql: SqlStorage, roomId: string, limit: number): Message[] {
  return rows(
    sql.exec<SqlRow<MessageRow>>("SELECT * FROM messages ORDER BY seq DESC LIMIT ?", limit),
  )
    .map((r) => toMessage(roomId, r))
    .reverse();
}

export function listAllMessages(sql: SqlStorage, roomId: string): Message[] {
  return rows(sql.exec<SqlRow<MessageRow>>("SELECT * FROM messages ORDER BY seq")).map((r) =>
    toMessage(roomId, r),
  );
}

export function deleteAllMessages(sql: SqlStorage): void {
  sql.exec("DELETE FROM messages");
}
