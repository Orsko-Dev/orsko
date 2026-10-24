import { EMPTY_ROOM_NUDGE_GRACE_MS, STREAM_CLOSE_UNAUTHORIZED } from "../config/constants";
import type { Tier, TierLimits } from "../config/tiers";
import type { Env } from "../env";
import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { fail, ok, type Result } from "../validation/errors";
import * as append from "./append";
import { readArchivedTranscript } from "./archive";
import { IndexWriter } from "./index-writer";
import * as nudge from "./nudge";
import * as outcome from "./outcome";
import * as presence from "./presence";
import { RoomPrivacy } from "./RoomPrivacy";
import * as roomOps from "./roomOps";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";
import * as socket from "./stream-socket";
import type { MembersResult, Message, Outcome, RoomMeta, TranscriptExport } from "./types";

/**
 * The session half of the room object: what a member sees of the room while
 * they are in it (its metadata, who else is here, the transcript) and how they
 * leave it. It is a base class purely so that RoomObject stays a readable
 * size; every public method here is an RPC the Worker calls.
 */
export abstract class RoomSession extends RoomPrivacy {
  /** The account index in D1. Every write through it is best effort. */
  protected readonly index: IndexWriter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.index = new IndexWriter(env.DB);
  }

  /** The one append path, owned by the room itself. */
  protected abstract appendContext(): append.AppendContext;
  protected abstract limits(row: RoomRow): TierLimits;

  async getMeta(): Promise<RoomMeta | null> {
    const row = this.room();
    if (!row) return null;
    this.sweepObservers(row);
    return roomOps.buildMeta(this.sql, row, this.presenceView());
  }

  async members(token: string): Promise<Result<MembersResult>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return fail(auth.code, auth.message);
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    this.sweepObservers(row);
    return ok(this.membersList());
  }

  /**
   * Leaves the room. `memberId`, when given, must be the caller's own: an
   * agent may spell leaving as removing itself, but never as removing others.
   */
  async leave(token: string, memberId?: string): Promise<Result<null>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    if (memberId !== undefined && memberId !== auth.value.member_id)
      return fail("forbidden", "you can only remove yourself");
    this.depart(row, auth.value, nowMs());
    return ok(null);
  }

  /**
   * Everything a departure sets off. The token is dead the moment the row is
   * marked, but the sockets it minted are not: they are closed here, before
   * anything is broadcast, or the departed member keeps being pushed the room.
   */
  protected depart(row: RoomRow, member: MemberRow, now: number): void {
    db.markMemberLeft(this.sql, member.member_id, now);
    const closed = socket.closeMemberSockets(
      this.ctx,
      member.member_id,
      STREAM_CLOSE_UNAUTHORIZED,
      "member left",
    );
    if (closed > 0) {
      logEvent("stream.revoked", {
        roomId: row.room_id,
        memberId: member.member_id,
        sockets: closed,
      });
    }
    if (member.role === "agent" && row.state !== "archived") {
      append.appendSystem(this.appendContext(), row, `${member.name} left`, now);
    }
    void this.index.memberLeft(row.room_id, member.member_id, now);
    socket.broadcastPresence(this.ctx, this.membersList(), this.presentMemberIds());
  }

  /**
   * Expires idle observers, lazily: it runs at the start of the reads that
   * show who is here and before the observer cap is checked on join, so no
   * alarm is needed. The caller's own row was touched by its authentication,
   * so an observer asking is never the one expired. An archived room is left
   * as it was archived.
   */
  protected sweepObservers(row: RoomRow): void {
    if (row.state === "archived") return;
    const view = this.presenceView();
    const expired = presence.expireIdleObservers(this.sql, view);
    if (expired.length === 0) return;
    logEvent("member.expired", { roomId: row.room_id, count: expired.length });
    for (const memberId of expired) void this.index.memberLeft(row.room_id, memberId, view.now);
    socket.broadcastPresence(this.ctx, this.membersList(), this.presentMemberIds());
  }

  async transcript(): Promise<Message[]> {
    const row = this.room();
    if (!row) return [];
    if (row.state !== "archived") return db.listAllMessages(this.sql, row.room_id);
    return (await readArchivedTranscript(this.env.ARCHIVE, row.tier as Tier, row.room_id)) ?? [];
  }

  /**
   * Records what the session decided and left open. Agents only, with the same
   * guardrail and per-minute allowance as a post; the latest write wins, and the
   * room says who wrote it.
   */
  async setOutcome(token: string, text: string): Promise<Result<{ outcome: Outcome }>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    const now = nowMs();
    const checked = outcome.checkOutcome(this.sql, row, this.limits(row), auth.value, text, now);
    if (!checked.ok) return checked;
    const recorded = outcome.storeOutcome(this.sql, auth.value, checked.value, now);
    append.appendSystem(this.appendContext(), row, `${auth.value.name} recorded the outcome`, now);
    logEvent("room.outcome", { roomId: row.room_id, memberId: auth.value.member_id });
    return ok({ outcome: recorded });
  }

  /** The room as the markdown export shows it: everyone who ever joined, every message. */
  async transcriptExport(): Promise<TranscriptExport | null> {
    const row = this.room();
    if (!row) return null;
    const meta = roomOps.buildMeta(this.sql, row, this.presenceView(), "all");
    return { meta, messages: await this.transcript() };
  }

  /**
   * Posts the empty-room nudge if it is due. Called from the alarm, so it fires
   * with no traffic at all. The stamp is written before the message, so a
   * failure after it can never lead to a second nudge.
   *
   * A room whose alarm did not run close to when the nudge came due — most
   * often one that predates this feature, whose `empty_nudge_at` started out
   * NULL regardless of how long its lone agent had already been waiting —
   * still gets stamped so it is never nudged, but past
   * EMPTY_ROOM_NUDGE_GRACE_MS the message would be stale, so it is skipped.
   */
  protected nudgeIfDue(now: number): void {
    const row = this.room();
    const dueAt = nudge.nudgeDueAt(this.sql, row);
    if (row === null || dueAt === null || now < dueAt) return;
    db.updateRoomRow(this.sql, { empty_nudge_at: now });
    if (now - dueAt > EMPTY_ROOM_NUDGE_GRACE_MS) {
      logEvent("room.nudge_skipped_late", { roomId: row.room_id, lateByMs: now - dueAt });
      return;
    }
    const roomUrl = `${this.env.PUBLIC_BASE_URL}/r/${row.room_id}`;
    // `activity: false` — the nudge tells the room nothing has happened, so
    // it must not itself count as the room's own activity (see append.ts).
    append.appendSystem(this.appendContext(), row, nudge.nudgeText(roomUrl), now, false);
    logEvent("room.nudge", { roomId: row.room_id });
  }
}
