import { logEvent } from "../util/log";
import { nowMs } from "../util/time";
import { fail, ok, type Result } from "../validation/errors";
import * as privacy from "./privacy";
import { RoomTestHooks } from "./RoomTestHooks";
import type { RoomRow } from "./storage";
import * as db from "./storage";

/**
 * The private-room half of the room object: the privacy flag, the invites it
 * has issued, and the access rule the browser view asks about. It is a base
 * class purely so that RoomObject stays a readable size; every method here
 * is an RPC the Worker calls.
 *
 * Only the room's creator may change any of it. The Worker resolves the
 * session or key to a user id and passes that id — a session cookie never
 * reaches this object.
 */
export abstract class RoomPrivacy extends RoomTestHooks {
  /** The room row, but only for its creator. */
  private ownedBy(userId: string): Result<RoomRow> {
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    if (row.creator_user_id === null || row.creator_user_id !== userId)
      return fail("forbidden", "only the room's creator can do that");
    return ok(row);
  }

  /** Turns invite-only joining on or off. Creator only. */
  async setPrivate(userId: string, value: boolean): Promise<Result<null>> {
    const owned = this.ownedBy(userId);
    if (!owned.ok) return fail(owned.code, owned.message);
    db.updateRoomRow(this.sql, { private: value ? 1 : 0 });
    logEvent("room.privacy", { roomId: owned.value.room_id, private: value });
    return ok(null);
  }

  /**
   * Records an invite the Worker has minted. The Worker keeps the raw token
   * (it returns it to the owner once) and sends only its hash, so the room
   * never holds anything that could be replayed out of its storage.
   */
  async mintInvite(
    userId: string,
    invite: { inviteId: string; tokenHash: string; expiresAt: number },
  ): Promise<Result<null>> {
    const owned = this.ownedBy(userId);
    if (!owned.ok) return fail(owned.code, owned.message);
    if (owned.value.private !== 1)
      return fail("invalid_request", "this room is not private, so an invite would gate nothing");
    privacy.ensureInviteSchema(this.sql);
    privacy.insertInvite(this.sql, invite);
    logEvent("invite.mint", { roomId: owned.value.room_id, inviteId: invite.inviteId });
    return ok(null);
  }

  /** Drops an invite so its token stops validating. Creator only. */
  async revokeInvite(userId: string, inviteId: string): Promise<Result<null>> {
    const owned = this.ownedBy(userId);
    if (!owned.ok) return fail(owned.code, owned.message);
    if (!privacy.revokeInvite(this.sql, inviteId)) return fail("invalid_request", "no such invite");
    logEvent("invite.revoke", { roomId: owned.value.room_id, inviteId });
    return ok(null);
  }

  /**
   * How this caller may see the room, without changing anything. The browser
   * view, the JSON metadata and the markdown instructions all gate on it; an
   * `invite` result means the token is usable, not that it has been used.
   */
  async canView(userId: string | null, invite: string | null): Promise<Result<privacy.ViewAccess>> {
    const row = this.room();
    if (!row) return fail("room_not_found", "room does not exist");
    return privacy.viewAccess(this.sql, row, { userId, invite }, nowMs());
  }

  /**
   * Whether this account created the room, whatever its privacy. The room
   * view renders its owner panel from this instead of probing an owner-only
   * endpoint and reading the refusal.
   */
  async isOwner(userId: string): Promise<boolean> {
    const row = this.room();
    return row !== null && row.creator_user_id !== null && row.creator_user_id === userId;
  }
}
