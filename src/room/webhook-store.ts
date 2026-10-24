import { addMissingColumns, type ColumnMigration, firstRow, rows, type SqlRow } from "./sql";
import type { WebhookStatus } from "./types";

/** One outstanding delivery of one message to one member's webhook. */
export interface DeliveryRow {
  readonly delivery_id: string;
  readonly member_id: string;
  readonly seq: number;
  readonly attempts: number;
  readonly next_at: number;
  readonly created_at: number;
}

/** A member who is due to receive a delivery, with what is needed to sign it. */
export interface WebhookTarget {
  readonly member_id: string;
  readonly name: string;
  readonly webhook_url: string;
  readonly webhook_secret: string;
}

/**
 * Webhook columns added to `members` after that table shipped, and so also
 * present in ensureSchema's CREATE TABLE for new rooms.
 */
const WEBHOOK_MEMBER_COLUMNS: readonly ColumnMigration[] = [
  { name: "webhook_url", ddl: "webhook_url TEXT" },
  { name: "webhook_secret", ddl: "webhook_secret TEXT" },
  { name: "webhook_status", ddl: "webhook_status TEXT" },
  // Reserved. The column is created (and kept on rooms that already have it)
  // so the schema is one shape everywhere, but nothing writes it: retry state
  // is per delivery, in webhook_deliveries.attempts.
  { name: "webhook_failures", ddl: "webhook_failures INTEGER NOT NULL DEFAULT 0" },
];

/**
 * Creates the deliveries table and the member webhook columns if they are
 * missing. Idempotent, and safe to call on both new and pre-webhook rooms;
 * the caller must have confirmed the room's tables exist.
 */
export function ensureWebhookSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, seq INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_next_at ON webhook_deliveries(next_at);
  `);
  addMissingColumns(sql, "members", WEBHOOK_MEMBER_COLUMNS);
}

export function insertDelivery(
  sql: SqlStorage,
  d: { delivery_id: string; member_id: string; seq: number; next_at: number },
  now: number,
): void {
  sql.exec(
    `INSERT INTO webhook_deliveries (delivery_id, member_id, seq, attempts, next_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
    d.delivery_id,
    d.member_id,
    d.seq,
    d.next_at,
    now,
  );
}

/** Due rows, oldest first, so a backlog drains in the order it was created. */
export function listDueDeliveries(sql: SqlStorage, now: number, limit = 100): DeliveryRow[] {
  return rows(
    sql.exec<SqlRow<DeliveryRow>>(
      "SELECT * FROM webhook_deliveries WHERE next_at <= ? ORDER BY seq, created_at LIMIT ?",
      now,
      limit,
    ),
  );
}

export function earliestDeliveryAt(sql: SqlStorage): number | null {
  const row = firstRow(
    sql.exec<SqlRow<{ next_at: number | null }>>(
      "SELECT MIN(next_at) AS next_at FROM webhook_deliveries",
    ),
  );
  return row?.next_at ?? null;
}

export function rescheduleDelivery(
  sql: SqlStorage,
  deliveryId: string,
  attempts: number,
  nextAt: number,
): void {
  sql.exec(
    "UPDATE webhook_deliveries SET attempts = ?, next_at = ? WHERE delivery_id = ?",
    attempts,
    nextAt,
    deliveryId,
  );
}

export function deleteDelivery(sql: SqlStorage, deliveryId: string): void {
  sql.exec("DELETE FROM webhook_deliveries WHERE delivery_id = ?", deliveryId);
}

export function deleteMemberDeliveries(sql: SqlStorage, memberId: string): void {
  sql.exec("DELETE FROM webhook_deliveries WHERE member_id = ?", memberId);
}

export function deleteAllDeliveries(sql: SqlStorage): void {
  sql.exec("DELETE FROM webhook_deliveries");
}

/** Test-only: pulls every pending delivery into the past so a retry runs now. */
export function forceDeliveriesDue(sql: SqlStorage): number {
  sql.exec("UPDATE webhook_deliveries SET next_at = 0");
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries").one().n;
}

/**
 * Present members with a working webhook, other than `excludeName`: a member
 * is never woken for their own message.
 */
export function listWebhookTargets(sql: SqlStorage, excludeName: string): WebhookTarget[] {
  return rows(
    sql.exec<SqlRow<WebhookTarget>>(
      `SELECT member_id, name, webhook_url, webhook_secret FROM members
       WHERE left_at IS NULL AND webhook_status = 'active'
         AND webhook_url IS NOT NULL AND webhook_secret IS NOT NULL AND name != ?
       ORDER BY joined_at`,
      excludeName,
    ),
  );
}

export function findWebhookTarget(sql: SqlStorage, memberId: string): WebhookTarget | null {
  return firstRow(
    sql.exec<SqlRow<WebhookTarget>>(
      `SELECT member_id, name, webhook_url, webhook_secret FROM members
       WHERE member_id = ? AND left_at IS NULL AND webhook_status = 'active'
         AND webhook_url IS NOT NULL AND webhook_secret IS NOT NULL`,
      memberId,
    ),
  );
}

/**
 * Registers or replaces a webhook. Nothing carries over from an earlier one:
 * its pending deliveries hold their own attempt counts, and a fresh secret
 * is minted by the caller.
 */
export function setMemberWebhook(
  sql: SqlStorage,
  memberId: string,
  url: string,
  secret: string,
): void {
  sql.exec(
    `UPDATE members SET webhook_url = ?, webhook_secret = ?, webhook_status = 'active'
      WHERE member_id = ?`,
    url,
    secret,
    memberId,
  );
}

export function clearMemberWebhook(sql: SqlStorage, memberId: string): void {
  sql.exec(
    `UPDATE members SET webhook_url = NULL, webhook_secret = NULL, webhook_status = NULL
      WHERE member_id = ?`,
    memberId,
  );
}

/**
 * Marks the webhook dead. The url stays so the member can see what was
 * registered; the secret is dropped because nothing will be signed with it
 * again, and re-registering mints a new one.
 */
export function disableMemberWebhook(sql: SqlStorage, memberId: string): void {
  sql.exec(
    "UPDATE members SET webhook_status = 'failed', webhook_secret = NULL WHERE member_id = ?",
    memberId,
  );
  deleteMemberDeliveries(sql, memberId);
}

export function webhookStatusOf(value: string | null): WebhookStatus {
  return value === "active" || value === "failed" ? value : null;
}
