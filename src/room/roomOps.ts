import type { Tier } from "../config/tiers";
import { isoFromMs } from "../util/time";
import type { IndexWriter } from "./index-writer";
import { outcomeOf } from "./outcome";
import { memberStatus, type PresenceView } from "./presence";
import type { RoomRow } from "./storage";
import * as db from "./storage";
import type { RoomMeta } from "./types";

/** Who the metadata lists: the room as it is now, or everyone it ever held. */
export type MetaScope = "present" | "all";

/**
 * The room's public metadata, built from its own tables. Live reads list who
 * is present; the archive and the export list everyone who ever joined.
 */
export function buildMeta(
  sql: SqlStorage,
  row: RoomRow,
  view: PresenceView,
  scope: MetaScope = "present",
): RoomMeta {
  const members =
    scope === "all" ? db.listMembers(sql, row.room_id) : db.listPresentMembers(sql, row.room_id);
  return {
    roomId: row.room_id,
    tier: row.tier as Tier,
    state: row.state,
    purpose: row.purpose,
    createdAt: isoFromMs(row.created_at),
    lastActivityAt: isoFromMs(row.last_activity_at),
    messageCount: db.countMessages(sql),
    attachmentCount: db.countAttachments(sql),
    members: members.map((m) => db.publicMember(m, memberStatus(m, view))),
    private: row.private === 1,
    outcome: outcomeOf(row),
  };
}

/**
 * Mirrors a newly created room into the account index. Best effort, after
 * the room's own write: the room object stays authoritative either way.
 */
export function indexCreatedRoom(index: IndexWriter, row: RoomRow): void {
  void index.roomCreated({
    roomId: row.room_id,
    creatorUserId: row.creator_user_id,
    private: row.private === 1,
    purpose: row.purpose,
    createdAt: row.created_at,
    state: row.state,
    lastActivityAt: row.last_activity_at,
  });
}
