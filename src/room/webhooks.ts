import {
  WEBHOOK_DELIVERY_BATCH,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "../config/constants";
import { hmacSha256Hex } from "../util/hmac";
import { generateDeliveryId, generateWebhookSecret } from "../util/ids";
import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { fail, ok, type Result } from "../validation/errors";
import { webhookUrlProblem } from "../validation/webhook-url";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import type { MemberRole, Message } from "./types";
import * as hooks from "./webhook-store";

/**
 * What the webhook helpers need from a RoomObject instance, passed
 * explicitly so registration and delivery can live outside the class.
 * `authenticate` is a bound function because RoomObject.authenticate is
 * protected, and `announce` appends the system message that reports a
 * disabled webhook (message append lives on the class).
 */
export interface WebhookContext {
  readonly sql: SqlStorage;
  authenticate(
    token: string,
  ): Promise<Result<{ member_id: string; name: string; role: MemberRole }>>;
  room(): RoomRow | null;
  announce(row: RoomRow, text: string, now: number): void;
}

/** The url and the one-time secret a member signs deliveries with. */
export interface WebhookRegistration {
  readonly url: string;
  readonly secret: string;
}

/**
 * Stores a webhook for a member who is already in the room, replacing any
 * earlier one and clearing its failure count. Every registration mints a
 * fresh secret: the old one may have been leaked by the endpoint that just
 * stopped working, and the caller has to be told the secret anyway.
 */
export async function registerWebhook(
  ctx: WebhookContext,
  token: string,
  url: string,
): Promise<Result<WebhookRegistration>> {
  const auth = await ctx.authenticate(token);
  if (!auth.ok) return auth;
  if (auth.value.role !== "agent") return fail("forbidden", "observers cannot register a webhook");
  const row = ctx.room();
  if (!row) return fail("room_not_found", "room does not exist");
  if (row.state === "archived") return fail("room_archived", "room is archived");
  // The Worker validates too; this RPC is its own boundary, and the room
  // decides for itself what it is willing to fetch.
  const problem = webhookUrlProblem(url);
  if (problem !== null) return fail("invalid_request", problem);
  const secret = generateWebhookSecret();
  hooks.setMemberWebhook(ctx.sql, auth.value.member_id, url, secret);
  logEvent("webhook.registered", { roomId: row.room_id, memberId: auth.value.member_id });
  return ok({ url, secret });
}

/** Removes the member's webhook and drops anything still queued for it. */
export async function removeWebhook(ctx: WebhookContext, token: string): Promise<Result<null>> {
  const auth = await ctx.authenticate(token);
  if (!auth.ok) return auth;
  const row = ctx.room();
  if (!row) return fail("room_not_found", "room does not exist");
  hooks.clearMemberWebhook(ctx.sql, auth.value.member_id);
  hooks.deleteMemberDeliveries(ctx.sql, auth.value.member_id);
  logEvent("webhook.removed", { roomId: row.room_id, memberId: auth.value.member_id });
  return ok(null);
}

/**
 * Queues one delivery per present member who has an active webhook and did
 * not write the message. Returns how many rows were added, so the caller can
 * skip starting a delivery pass when there is nothing to send.
 */
export function enqueueDeliveries(sql: SqlStorage, message: Message, now: number): number {
  const targets = hooks.listWebhookTargets(sql, message.from);
  for (const target of targets) {
    hooks.insertDelivery(
      sql,
      {
        delivery_id: generateDeliveryId(),
        member_id: target.member_id,
        seq: message.seq,
        next_at: now,
      },
      now,
    );
  }
  return targets.length;
}

/** The JSON body a receiver gets, and the exact bytes the signature covers. */
function payloadFor(
  roomId: string,
  deliveryId: string,
  target: hooks.WebhookTarget,
  message: Message,
): string {
  return JSON.stringify({
    event: "message",
    deliveryId,
    roomId,
    // The member this delivery is for, not the author: the author is
    // message.from. A receiver serving several members uses it to route.
    member: { memberId: target.member_id, name: target.name },
    message,
  });
}

async function postDelivery(
  target: hooks.WebhookTarget,
  roomId: string,
  deliveryId: string,
  body: string,
): Promise<Response> {
  const signature = await hmacSha256Hex(target.webhook_secret, body);
  return fetch(target.webhook_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orsko-event": "message",
      "x-orsko-delivery": deliveryId,
      "x-orsko-room": roomId,
      "x-orsko-signature": `sha256=${signature}`,
    },
    body,
    // A receiver that answers with a redirect gets no second request: the
    // url was checked when it was registered, and the target of a redirect
    // never is. A 3xx simply counts as a failed attempt.
    redirect: "manual",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
}

/** Why an attempt failed, for the log only: never the response body. */
function failureReason(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown_error";
}

function onFailure(
  ctx: WebhookContext,
  row: RoomRow,
  delivery: hooks.DeliveryRow,
  target: hooks.WebhookTarget,
  reason: string,
): void {
  const now = nowMs();
  const attempts = delivery.attempts + 1;
  logEvent("webhook.failed", {
    roomId: row.room_id,
    memberId: target.member_id,
    seq: delivery.seq,
    attempts,
    reason,
  });
  if (attempts < WEBHOOK_MAX_ATTEMPTS) {
    const delay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1] ?? 0;
    hooks.rescheduleDelivery(ctx.sql, delivery.delivery_id, attempts, now + delay);
    return;
  }
  hooks.disableMemberWebhook(ctx.sql, target.member_id);
  logEvent("webhook.disabled", { roomId: row.room_id, memberId: target.member_id, attempts });
  if (row.state !== "archived") {
    ctx.announce(row, `${target.name}'s webhook was disabled after repeated failures`, now);
  }
}

/**
 * One attempt at one delivery. A row whose member or message is gone (the
 * member left, removed the webhook, or the room was archived out from under
 * it) is dropped rather than retried.
 */
async function deliverOne(
  ctx: WebhookContext,
  row: RoomRow,
  delivery: hooks.DeliveryRow,
): Promise<boolean> {
  const target = hooks.findWebhookTarget(ctx.sql, delivery.member_id);
  const message = db.findMessageBySeq(ctx.sql, row.room_id, delivery.seq);
  if (!target || !message) {
    hooks.deleteDelivery(ctx.sql, delivery.delivery_id);
    return false;
  }
  const body = payloadFor(row.room_id, delivery.delivery_id, target, message);
  try {
    const response = await postDelivery(target, row.room_id, delivery.delivery_id, body);
    if (!response.ok) {
      onFailure(ctx, row, delivery, target, `status_${response.status}`);
      return false;
    }
  } catch (error: unknown) {
    onFailure(ctx, row, delivery, target, failureReason(error));
    return false;
  }
  hooks.deleteDelivery(ctx.sql, delivery.delivery_id);
  // The receiver has the message now, the same as if it had polled or been
  // handed it on join: unread must not count it again on the member's own
  // next post.
  db.advanceDeliveredThrough(ctx.sql, target.member_id, delivery.seq);
  logEvent("webhook.delivered", {
    roomId: row.room_id,
    memberId: target.member_id,
    seq: delivery.seq,
    attempts: delivery.attempts + 1,
  });
  return true;
}

/**
 * Attempts every delivery that is due, one at a time so a slow receiver
 * cannot fan out into a burst of concurrent fetches from one room. Returns
 * how many succeeded.
 */
export async function deliverDue(ctx: WebhookContext, now: number): Promise<number> {
  const due = hooks.listDueDeliveries(ctx.sql, now, WEBHOOK_DELIVERY_BATCH);
  let delivered = 0;
  for (const delivery of due) {
    // Re-read each time: announcing a disabled webhook appends a message,
    // which moves the room row on.
    const row = ctx.room();
    if (!row) break;
    if (await deliverOne(ctx, row, delivery)) delivered += 1;
  }
  return delivered;
}

/**
 * Runs one delivery pass at a time. A caller that arrives while a pass is
 * running joins it and asks for one more lap, so nothing queued before the
 * call is missed and no delivery row is attempted twice at once.
 */
export class DeliveryRunner {
  private pass: Promise<void> | null = null;
  private pending = false;

  constructor(private readonly lap: () => Promise<void>) {}

  start(): Promise<void> {
    if (this.pass !== null) {
      this.pending = true;
      return this.pass;
    }
    const pass = this.loop().finally(() => {
      this.pass = null;
    });
    this.pass = pass;
    return pass;
  }

  private async loop(): Promise<void> {
    do {
      this.pending = false;
      await this.lap();
    } while (this.pending);
  }
}
