import { getTier, type Tier, type TierLimits } from "../config/tiers";
import type { Env } from "../env";
import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { fail, ok, type Result } from "../validation/errors";
import * as append from "./append";
import * as attachments from "./attachments";
import * as ops from "./lifecycleOps";
import * as membership from "./membership";
import * as nudge from "./nudge";
import * as polling from "./polling";
import * as posting from "./posting";
import { RoomSession } from "./RoomSession";
import * as roomOps from "./roomOps";
import * as db from "./storage";
import * as socket from "./stream-socket";
import type {
  Attachment,
  JoinResult,
  MemberRole,
  MessageWithUnread,
  PollResult,
  PostedMessage,
  RoomMeta,
} from "./types";
import { WaiterRegistry } from "./waiters";
import * as hooks from "./webhook-store";
import * as webhooks from "./webhooks";

export class RoomObject extends RoomSession {
  protected readonly waiters = new WaiterRegistry();

  // True once this actor has confirmed the SQL schema exists. Storage for a
  // Durable Object is created lazily, so the constructor must not run DDL:
  // a read for a room that was never created would otherwise allocate (and
  // bill) storage. room() probes sqlite_master instead, and expiry clears the
  // flag after deleteAll() drops every table.
  private schemaReady = false;

  // Coalesces delivery passes: see webhooks.DeliveryRunner.
  private readonly deliveries = new webhooks.DeliveryRunner(() => this.deliveryLap());

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A newly constructed actor holds no long-poll waiters, so any persisted
    // budget_live_since is stale: left in place it would accrue live seconds
    // for the whole time the object was evicted. Clearing it is a write, so
    // it only runs when the schema already exists.
    ctx.blockConcurrencyWhile(async () => {
      if (!db.hasRoomTable(ctx.storage.sql)) return;
      // A room created before the presence or webhook columns shipped never
      // runs ensureSchema again, so this is where it catches up. It is the
      // same gated write path, and every migration is idempotent.
      db.migrateRoomSchema(ctx.storage.sql);
      db.updateRoomRow(ctx.storage.sql, { budget_live_since: null });
    });
  }

  protected override get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  protected override room(): db.RoomRow | null {
    if (!this.schemaReady) {
      if (!db.hasRoomTable(this.sql)) return null;
      // Covers an actor that was constructed before this code was deployed
      // and is still alive: its constructor never ran the migration.
      db.migrateRoomSchema(this.sql);
      this.schemaReady = true;
    }
    return db.readRoomRow(this.sql);
  }

  protected override limits(row: db.RoomRow): TierLimits {
    return getTier(row.tier);
  }

  protected lifecycleContext(): ops.LifecycleContext {
    return {
      sql: this.sql,
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      index: this.index,
      buildMeta: (row, scope) => roomOps.buildMeta(this.sql, row, this.presenceView(), scope),
      limits: (row) => this.limits(row),
      wake: () => this.waiters.wakeAll(),
      broadcastState: (row, state) =>
        socket.broadcastState(this.ctx, row.room_id, state, this.presentMemberIds()),
      earliestDeliveryAt: () => hooks.earliestDeliveryAt(this.sql),
      nudgeDueAt: () => nudge.nudgeDueAt(this.sql, this.room()),
      onStorageDeleted: () => {
        this.schemaReady = false;
      },
    };
  }

  async create(input: {
    roomId: string;
    purpose: string | null;
    tier: Tier;
    creatorUserId?: string | null;
    private?: boolean;
  }): Promise<Result<RoomMeta>> {
    if (this.room()) return fail("invalid_request", "room already exists");
    db.ensureSchema(this.sql);
    this.schemaReady = true;
    const now = nowMs();
    const row = db.newRoomRow(input, now);
    db.insertRoomRow(this.sql, row);
    logEvent("room.create", { roomId: row.room_id, tier: row.tier });
    roomOps.indexCreatedRoom(this.index, row);
    await ops.scheduleIdleAlarm(this.lifecycleContext(), row, now);
    return ok(roomOps.buildMeta(this.sql, row, this.presenceView()));
  }

  async join(input: {
    name: string;
    role: MemberRole;
    webhookUrl?: string | undefined;
    userId?: string | null;
    /** The invite token offered, which a private room requires. */
    invite?: string | null;
  }): Promise<Result<JoinResult>> {
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    this.sweepObservers(row);
    const joined = await membership.joinRoom(this.membershipContext(), row, input, nowMs());
    if (joined.ok) socket.broadcastPresence(this.ctx, this.membersList(), this.presentMemberIds());
    return joined;
  }

  protected membershipContext(): membership.MembershipContext {
    return {
      sql: this.sql,
      index: this.index,
      limits: (row) => this.limits(row),
      announce: (row, text, now) => {
        append.appendSystem(this.appendContext(), row, text, now);
      },
    };
  }

  protected webhookContext(): webhooks.WebhookContext {
    return {
      sql: this.sql,
      authenticate: (token) => this.authenticate(token),
      room: () => this.room(),
      announce: (row, text, now) => {
        append.appendSystem(this.appendContext(), row, text, now);
      },
    };
  }

  async registerWebhook(token: string, url: string): Promise<Result<webhooks.WebhookRegistration>> {
    return webhooks.registerWebhook(this.webhookContext(), token, url);
  }

  async removeWebhook(token: string): Promise<Result<null>> {
    return webhooks.removeWebhook(this.webhookContext(), token);
  }

  /**
   * The single token check for every authenticated RPC, and therefore the
   * one place that records presence: a successful check is by definition the
   * member being seen.
   */
  protected override async authenticate(token: string): Promise<Result<db.MemberRow>> {
    if (!this.room()) return fail("room_not_found", "room does not exist");
    const found = await membership.findMember(this.sql, token);
    if (found.ok) db.touchMember(this.sql, found.value.member_id, nowMs());
    return found;
  }

  protected override appendContext(): append.AppendContext {
    return {
      sql: this.sql,
      ctx: this.ctx,
      index: this.index,
      room: () => this.room(),
      lifecycle: () => this.lifecycleContext(),
      wake: () => this.waiters.wakeAll(),
      presentMemberIds: () => this.presentMemberIds(),
      runDeliveries: (roomId) => {
        void this.runDeliveries(roomId);
      },
    };
  }

  /**
   * One delivery pass, with its failures contained. A pass that throws must
   * neither reject the append that started it in the background nor stop the
   * lifecycle step that follows it in the alarm; the rows it did not send
   * stay queued, and the next alarm retries them.
   */
  private async runDeliveries(roomId: string): Promise<void> {
    try {
      await this.deliveries.start();
    } catch (error: unknown) {
      logEvent("webhook.pass_failed", {
        roomId,
        errorClass: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  private async deliveryLap(): Promise<void> {
    await webhooks.deliverDue(this.webhookContext(), nowMs());
    const row = this.room();
    if (row) await ops.scheduleIdleAlarm(this.lifecycleContext(), row, nowMs());
  }

  async postMessage(
    token: string,
    input: { text: string; attachmentIds: readonly string[] },
  ): Promise<Result<MessageWithUnread>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const posted = this.postAs(auth.value, input);
    return posted.ok ? ok({ ...posted.value.message, unread: posted.value.unread }) : posted;
  }

  /**
   * The one post path, shared by `POST /messages` and by `post` frames on the
   * stream, so both clear the same role check, guardrail and rate limit, and
   * both report the same `unread`.
   */
  protected override postAs(
    member: db.MemberRow,
    input: { text: string; attachmentIds: readonly string[] },
  ): Result<PostedMessage> {
    if (member.role !== "agent") return fail("forbidden", "observers cannot post");
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    const now = nowMs();
    const gate = posting.checkPost(this.sql, row, this.limits(row), member, input, now);
    if (!gate.ok) return fail(gate.code, gate.message, gate.retryAfterSeconds);
    // Counted before the append, so the new message is never its own unread.
    const unread = db.countUnread(this.sql, member);
    const posted = append.appendMessage(
      this.appendContext(),
      row,
      member.name,
      input.text,
      input.attachmentIds,
      now,
    );
    logEvent("message.post", { roomId: row.room_id, memberId: member.member_id, seq: posted.seq });
    return ok({ message: posted, unread });
  }

  async authorizeUpload(
    token: string,
    input: { filename: string; size: number; contentType: string },
  ): Promise<Result<{ attachmentId: string; key: string }>> {
    return attachments.authorizeUpload(this.attachmentContext(), token, input);
  }

  async recordAttachment(
    token: string,
    input: { attachmentId: string; filename: string; size: number; contentType: string },
  ): Promise<Result<Attachment>> {
    return attachments.recordAttachment(this.attachmentContext(), token, input, nowMs());
  }

  async authorizeDownload(
    token: string,
    attachmentId: string,
  ): Promise<Result<{ attachment: Attachment; key: string }>> {
    return attachments.authorizeDownload(this.attachmentContext(), token, attachmentId);
  }

  protected attachmentContext(): attachments.AttachmentContext {
    return {
      sql: this.sql,
      authenticate: (token) => this.authenticate(token),
      room: () => this.room(),
      limits: (row) => this.limits(row),
    };
  }

  async poll(
    token: string,
    input: { since: number; waitSeconds: number },
  ): Promise<Result<PollResult>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    return ok(await polling.pollAs(this.pollContext(), row, auth.value.member_id, input));
  }

  protected pollContext(): polling.PollContext {
    return {
      sql: this.sql,
      waiters: this.waiters,
      room: () => this.room(),
      limits: (row) => this.limits(row),
    };
  }

  /**
   * Token check for callers outside the object (the transcript route) that
   * need to gate a read on membership without needing the member row.
   */
  async verifyToken(token: string): Promise<Result<null>> {
    const auth = await this.authenticate(token);
    return auth.ok ? ok(null) : fail(auth.code, auth.message);
  }

  /**
   * One alarm serves every job. Deliveries run first: the lifecycle step may
   * archive the room, which drops every pending delivery. The nudge runs
   * before the lifecycle step, whose rescheduling then no longer sees it due.
   */
  override async alarm(): Promise<void> {
    const before = this.room();
    if (!before) return;
    await this.runDeliveries(before.room_id);
    this.nudgeIfDue(nowMs());
    const row = this.room();
    if (!row) return;
    await ops.runAlarm(this.lifecycleContext(), row, nowMs());
  }

  /** Test-only: runs the delivery pass to completion, from the base class. */
  protected override async flushDeliveries(): Promise<void> {
    await this.deliveries.start();
  }
}
