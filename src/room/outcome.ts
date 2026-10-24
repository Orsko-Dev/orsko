import { MAX_OUTCOME_CHARS } from "../config/constants";
import type { TierLimits } from "../config/tiers";
import { isoFromMs } from "../util/time";
import { fail, ok, type Result } from "../validation/errors";
import { checkRate, checkRoomActive, checkSecrets } from "./posting";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";
import type { Outcome } from "./types";

/**
 * The room's outcome: one short record of what a session decided and left
 * open, kept in the room row so it survives into the archive and heads the
 * markdown export. Any agent may write it; the latest write wins.
 */

export function outcomeOf(row: RoomRow): Outcome | null {
  if (row.outcome_text === null || row.outcome_by === null || row.outcome_at === null) return null;
  return { text: row.outcome_text, by: row.outcome_by, at: isoFromMs(row.outcome_at) };
}

/**
 * Every check a write must clear, in the order a post clears them: role,
 * room state, length, the credential guardrail, then the rate limit, bumped
 * last so a refused write costs no quota. Answers the trimmed text.
 *
 * Room state and the secret guardrail reuse `checkPost`'s own gates
 * (`checkRoomActive`, `checkSecrets`), and the rate limit reuses `checkRate`
 * directly, so an outcome write shares the member's per-minute post
 * allowance instead of a separate one.
 */
export function checkOutcome(
  sql: SqlStorage,
  row: RoomRow,
  limits: TierLimits,
  member: MemberRow,
  text: string,
  now: number,
): Result<string> {
  if (member.role !== "agent") return fail("forbidden", "observers cannot record the outcome");
  const active = checkRoomActive(row);
  if (!active.ok) return active;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OUTCOME_CHARS)
    return fail("invalid_request", `text must be 1 to ${MAX_OUTCOME_CHARS} characters`);
  const secrets = checkSecrets(trimmed, row, member, "outcome.secret_rejected");
  if (!secrets.ok) return secrets;
  const rate = checkRate(sql, limits, member, now);
  return rate.ok ? ok(trimmed) : fail(rate.code, rate.message, rate.retryAfterSeconds);
}

export function storeOutcome(
  sql: SqlStorage,
  member: MemberRow,
  text: string,
  now: number,
): Outcome {
  db.updateRoomRow(sql, { outcome_text: text, outcome_by: member.name, outcome_at: now });
  return { text, by: member.name, at: isoFromMs(now) };
}
