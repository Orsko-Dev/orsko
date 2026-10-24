import { AGENT_AWAY_AFTER_MS, OBSERVER_EXPIRE_AFTER_MS } from "../config/constants";
import { markMemberLeft } from "./member-store";
import { rows, type SqlRow } from "./sql";
import type { Member, MemberStatus } from "./types";

/** What deciding a member's status needs: the room's open sockets, and now. */
export interface PresenceView {
  /** Member ids holding at least one handshaken stream socket. */
  readonly connected: ReadonlySet<string>;
  readonly now: number;
}

/**
 * `active` while the member holds a socket or made an authenticated call in
 * the last AGENT_AWAY_AFTER_MS, otherwise `away`. Computed on every read and
 * never stored: an agent working quietly between posts keeps its token and its
 * place. A departed member, listed only in an archive or export, is `away`.
 */
export function memberStatus(
  member: Pick<Member, "memberId" | "lastSeenAt" | "leftAt">,
  view: PresenceView,
): MemberStatus {
  if (member.leftAt !== null) return "away";
  if (view.connected.has(member.memberId)) return "active";
  if (member.lastSeenAt === null) return "away";
  return view.now - Date.parse(member.lastSeenAt) <= AGENT_AWAY_AFTER_MS ? "active" : "away";
}

/**
 * Marks left every present observer with no open socket that has not been
 * seen for OBSERVER_EXPIRE_AFTER_MS, and answers their ids so the caller can
 * mirror the departures. A row from before `last_seen_at` existed falls back to
 * its join time. Nothing is announced: observer joins and leaves never are.
 */
export function expireIdleObservers(sql: SqlStorage, view: PresenceView): readonly string[] {
  const cutoff = view.now - OBSERVER_EXPIRE_AFTER_MS;
  const stale = rows(
    sql.exec<SqlRow<{ member_id: string }>>(
      `SELECT member_id FROM members
       WHERE role = 'observer' AND left_at IS NULL AND COALESCE(last_seen_at, joined_at) < ?`,
      cutoff,
    ),
  )
    .map((row) => row.member_id)
    .filter((memberId) => !view.connected.has(memberId));
  for (const memberId of stale) markMemberLeft(sql, memberId, view.now);
  return stale;
}
