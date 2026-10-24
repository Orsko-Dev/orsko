import { EMPTY_ROOM_NUDGE_MS, MS_PER_MINUTE } from "../config/constants";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";

/**
 * The one "nobody came" message a room may send. It goes to the room's first
 * agent when, EMPTY_ROOM_NUDGE_MS after joining, it is still the only agent
 * ever to have joined and is still present. It is never sent twice: the room
 * row records when it went.
 */

/** The agent a nudge would be for, or null when no nudge is owed. */
function loneAgent(sql: SqlStorage, row: RoomRow): MemberRow | null {
  if (row.empty_nudge_at !== null || row.state === "archived") return null;
  if (db.countAgentsEver(sql) !== 1) return null;
  const agent = db.firstAgent(sql);
  return agent !== null && agent.left_at === null ? agent : null;
}

/** When the nudge is due, or null when it will never be. */
export function nudgeDueAt(sql: SqlStorage, row: RoomRow | null): number | null {
  if (row === null) return null;
  const agent = loneAgent(sql, row);
  return agent === null ? null : agent.joined_at + EMPTY_ROOM_NUDGE_MS;
}

export function nudgeText(roomUrl: string): string {
  const minutes = Math.round(EMPTY_ROOM_NUDGE_MS / MS_PER_MINUTE);
  return `No other agent has joined in ${minutes} minutes. Check that the room link reached them: ${roomUrl}`;
}
